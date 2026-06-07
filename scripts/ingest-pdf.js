// BUILD-TIME corpus pipeline — NOT called by the running server.
// Turns a real source PDF into review-ready rulebook chunks:
//
//   raw PDF ──▶ Unsiloed (/parse, OCR + layout)  ──▶ clean text segments
//           ──▶ TrueFoundry gateway (gpt-4o-mini) ──▶ de-scrambled, condensed rule + citation guess
//           ──▶ tag with corpus metadata (+ parsed_via: "Unsiloed")
//           ──▶ data/parsed_<type>.json   (REVIEW the citations, then merge into dispute_corpus.json + `npm run ingest`)
//
// Honest division of labour:
//   Unsiloed    -> parsing (handles scans, columns, tables, images)
//   TrueFoundry -> cleanup of two-column OCR scramble + condense to one rule
//   You         -> verify the citation (the model GUESSES it; two-column bleed can mis-attribute) and the metadata
//
// Usage:
//   node scripts/ingest-pdf.js --file docs_test/cfr1005.pdf \
//        --domain cards --dispute-type unauthorized_transaction \
//        --instrument debit --source "Regulation E" --max 3
//
// Requires UNSILOED_API_KEY + TRUEFOUNDRY_API_KEY/BASE_URL in .env.
import "dotenv/config";
import fs from "fs";
import path from "path";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const file = arg("file");
const domain = arg("domain", "cards");
const disputeType = arg("dispute-type");
const instrument = arg("instrument", "debit");
const source = arg("source", "Unsiloed import");
const max = parseInt(arg("max", "3"), 10);
if (!file || !disputeType) { console.error("Usage: node scripts/ingest-pdf.js --file <pdf> --dispute-type <type> [--domain] [--instrument] [--source] [--max N]"); process.exit(1); }

const U_BASE = (process.env.UNSILOED_BASE_URL || "https://prod.visionapi.unsiloed.ai").replace(/\/$/, "");
const U_KEY = process.env.UNSILOED_API_KEY;
const TF_BASE = (process.env.TRUEFOUNDRY_BASE_URL || "").replace(/\/$/, "");
const TF_KEY = process.env.TRUEFOUNDRY_API_KEY;
const TF_MODEL = process.env.TRUEFOUNDRY_MODEL || "openai/gpt-4o-mini";
if (!U_KEY || !TF_KEY) { console.error("Set UNSILOED_API_KEY and TRUEFOUNDRY_API_KEY in .env"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) PARSE via Unsiloed (async job + poll).
const form = new FormData();
form.append("file", new Blob([fs.readFileSync(file)], { type: "application/pdf" }), path.basename(file));
form.append("use_high_resolution", "true");
form.append("layout_analysis", "smart_layout_detection");
console.log(`[Unsiloed] parsing ${path.basename(file)} …`);
const sub = await fetch(`${U_BASE}/parse`, { method: "POST", headers: { "api-key": U_KEY, accept: "application/json" }, body: form });
if (!sub.ok) { console.error("[Unsiloed] submit failed", sub.status, (await sub.text()).slice(0, 300)); process.exit(1); }
const job = JSON.parse(await sub.text());
let parsed = null;
for (let i = 0; i < 80; i++) {
  await sleep(4000);
  const j = await (await fetch(`${U_BASE}/parse/${job.job_id}`, { headers: { "api-key": U_KEY, accept: "application/json" } })).json();
  if (j.status === "Succeeded") { parsed = j; break; }
  if (j.status === "Failed") { console.error("[Unsiloed] job failed"); process.exit(1); }
}
if (!parsed) { console.error("[Unsiloed] timed out"); process.exit(1); }

// Flatten to candidate texts, keep dispute-relevant ones.
const texts = (parsed.chunks || [])
  .map((c) => (c.segments || []).map((s) => s.markdown || s.content || "").join(" ").replace(/\s+/g, " ").trim())
  .filter((t) => t.length >= 250 && t.length <= 1100)
  .filter((t) => /unauthor|error resolution|notice of error|provisional credit|business days|liability|preauthorized|refund|chargeback/i.test(t));
console.log(`[Unsiloed] ${texts.length} dispute-relevant raw chunks`);

// 2) CLEAN each via TrueFoundry — de-scramble + condense + guess citation.
const SYS = "You clean OCR-scrambled US regulation text into ONE faithful rule chunk for a dispute rulebook. " +
  "Fix two-column word-order scramble; never invent or alter meaning. Return STRICT JSON {\"citation\":\"\",\"text\":\"\"} — " +
  "citation = best-guess CFR/section (mark uncertainty is fine), text = the cleaned 1-3 sentence rule.";
const out = [];
for (const raw of texts.slice(0, max)) {
  const r = await fetch(`${TF_BASE}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${TF_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TF_MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYS }, { role: "user", content: raw }] }),
  });
  let o; try { o = JSON.parse((await r.json()).choices[0].message.content); } catch { continue; }
  if (!o.text || o.text.length < 80) continue;
  out.push({ rawCitation: o.citation, text: o.text });
}
console.log(`[TrueFoundry] cleaned ${out.length} chunks`);

// 3) TAG with corpus metadata. Citation is flagged REVIEW because two-column bleed
//    can mis-attribute the section — a human confirms before merging.
const slug = disputeType.replace(/_/g, "-");
const entries = out.map((o, i) => ({
  id: `${slug}-unsiloed-${i + 1}`,
  dispute_type: disputeType, domain, instrument, rule_type: "regulation",
  source, citation: `REVIEW(${o.rawCitation}): confirm the exact section`,
  card_network: null, jurisdiction: "US", effective_date: "2024-01-01",
  parsed_via: "Unsiloed", text: o.text,
}));
const dest = path.join("data", `parsed_${slug}.json`);
fs.writeFileSync(dest, JSON.stringify(entries, null, 2));
console.log(`\nWrote ${entries.length} review-ready chunks to ${dest}.`);
console.log("Next: verify each REVIEW citation, then merge into data/dispute_corpus.json and run `npm run ingest`.");
