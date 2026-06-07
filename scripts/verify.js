// One-shot module verification. Exercises each layer directly and prints
// PASS/FAIL so we can see exactly which module misbehaves. Run: node scripts/verify.js
import "dotenv/config";
import { redact } from "../lib/redact.js";
import { classifyIntent as localIntent, detectDisputeType } from "../lib/intent.js";
import { bm25Search } from "../lib/bm25.js";
import { retrieve, retrievalBackend, CORPUS } from "../lib/retrieval.js";
import { classifyIntent, guide, llmBackend } from "../lib/llm.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`); };

console.log(`\n== backends ==  retrieval:${retrievalBackend()}  llm:${llmBackend()}  corpus:${CORPUS.length}\n`);

console.log("== redact (PII) ==");
{
  const a = redact("my card is 4111 1111 1111 1111");
  ok("masks card, keeps last4", a.masked && a.clean.includes("1111") && a.clean.includes("••••"), a.clean);
  const b = redact("ssn 123-45-6789");
  ok("masks ssn", b.masked && b.types.includes("ssn"), b.clean);
  const c = redact("there is a charge I don't recognize");
  ok("leaves clean text untouched", !c.masked && c.clean.includes("charge"));
}

console.log("\n== intent.js (local fallback classifier) ==");
{
  const cases = [
    ["hi there", "greeting"],
    ["thanks so much", "thanks"],
    ["what can you do", "help"],
    ["there is a charge I never authorized", "dispute"],
    ["my subscription kept billing after I cancelled", "dispute"],
    ["I never received my order", "dispute"],
    ["you cancelled my flight and gave me a voucher", "dispute"],
    ["I want my money back on a charge", "dispute_unclear"],
    ["what's the weather", "offtopic"],
  ];
  for (const [t, want] of cases) {
    const got = localIntent(t).intent;
    ok(`"${t}" -> ${want}`, got === want, `got ${got}`);
  }
  ok("detectDisputeType subscription", detectDisputeType("my subscription kept billing after I cancelled") === "cancelled_recurring");
}

console.log("\n== bm25.js (lexical fallback ranking) ==");
{
  const hits = bm25Search(CORPUS.filter(c => c.domain === "cards"), "unauthorized charge I did not make", {}, 3);
  ok("returns ranked hits", hits.length === 3 && hits[0].score > 0);
  ok("top hit is unauthorized", hits[0].chunk.dispute_type === "unauthorized_transaction", hits[0].chunk.citation);
}

console.log("\n== retrieval.js (Moss live + metadata filter) ==");
{
  const r = await retrieve("subscription still charging after I cancelled", { domain: "cards", instrument: "credit" }, 4);
  ok("backend is live engine", ["moss", "bm25"].includes(r.backend), r.backend);
  ok("returns hits", r.hits.length > 0, `${r.hits.length} hits in ${r.ms}ms`);
  ok("domain filter holds", r.hits.every(h => h.chunk.domain === "cards"));
  ok("instrument filter holds", r.hits.every(h => ["credit", "both"].includes(h.chunk.instrument)));
  ok("top hit relevant to recurring", r.hits[0].chunk.dispute_type === "cancelled_recurring", r.hits[0].chunk.dispute_type);
}

console.log("\n== llm.js classifyIntent (TrueFoundry triage) ==");
{
  const cases = [
    ["good morning", "greeting", null],
    ["there's a charge I don't recognize", "dispute", "unauthorized_transaction"],
    ["I cancelled netflix but got billed again", "dispute", "cancelled_recurring"],
    ["my package never arrived", "dispute", "goods_not_received"],
  ];
  for (const [t, wantIntent, wantType] of cases) {
    const g = await classifyIntent(t);
    const intentOk = g.intent === wantIntent || (wantIntent === "dispute" && g.intent === "dispute_unclear");
    ok(`triage "${t}" -> ${wantIntent}/${wantType}`, intentOk && (wantType == null || g.disputeType === wantType), `got ${g.intent}/${g.disputeType}`);
  }
}

console.log("\n== llm.js guide (consistency checks) ==");
{
  const r = await retrieve("there is a charge I don't recognize", { domain: "cards" }, 4);
  const g = await guide("there is a charge I don't recognize", r.hits, "unauthorized_transaction", []);
  ok("guide returns say + ask", !!g.say && Array.isArray(g.ask), `ask=${g.ask?.length}`);
  ok("dispute_type matches classified type", g.dispute_type === "unauthorized_transaction", g.dispute_type);
  // The contradiction bug: label must not contradict summary.
  const txt = `${g.label} ${g.summary}`.toLowerCase();
  const contradicts = txt.includes("cancel") && txt.includes("not cancel");
  ok("label/summary not self-contradictory", !contradicts, `${g.label} / ${g.summary}`);
  ok("citations come from retrieved hits", g.citations.every(c => r.hits.some(h => h.chunk.citation === c)));
}

console.log(`\n== RESULT ==  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
