// STANDALONE Unsiloed test — NOT wired into the app. Verifies the parse API works
// and shows the chunk quality. Usage: node scripts/unsiloed-test.js <file.pdf>
import "dotenv/config";
import fs from "fs";
import path from "path";

const file = process.argv[2] || "docs_test/disputes_source.pdf";
const BASE = (process.env.UNSILOED_BASE_URL || "https://prod.visionapi.unsiloed.ai").replace(/\/$/, "");
const KEY = process.env.UNSILOED_API_KEY;
if (!KEY) { console.error("Set UNSILOED_API_KEY in .env"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Submit the document.
const buf = fs.readFileSync(file);
const form = new FormData();
form.append("file", new Blob([buf], { type: "application/pdf" }), path.basename(file));
form.append("use_high_resolution", "true");
form.append("layout_analysis", "smart_layout_detection");

console.log(`Submitting ${path.basename(file)} to ${BASE}/parse …`);
const submit = await fetch(`${BASE}/parse`, { method: "POST", headers: { "api-key": KEY, accept: "application/json" }, body: form });
const submitBody = await submit.text();
if (!submit.ok) { console.error("submit failed", submit.status, submitBody.slice(0, 400)); process.exit(1); }
const job = JSON.parse(submitBody);
console.log("job:", job.job_id, "| status:", job.status, "| credits left:", job.quota_remaining);

// 2) Poll for completion.
let result = null;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const r = await fetch(`${BASE}/parse/${job.job_id}`, { headers: { "api-key": KEY, accept: "application/json" } });
  const j = await r.json();
  process.stdout.write(`  poll ${i + 1}: ${j.status}\n`);
  if (j.status === "Succeeded") { result = j; break; }
  if (j.status === "Failed") { console.error("job failed:", JSON.stringify(j).slice(0, 400)); process.exit(1); }
}
if (!result) { console.error("timed out waiting for job"); process.exit(1); }

// 3) Show the chunks Unsiloed produced.
const chunks = result.chunks || [];
console.log(`\n=== ${chunks.length} chunks ===\n`);
chunks.forEach((c, i) => {
  const segs = c.segments || [];
  const text = segs.map((s) => s.markdown || s.content || "").join("\n").trim();
  const types = [...new Set(segs.map((s) => s.segment_type))];
  console.log(`--- chunk ${i + 1}  [${types.join(", ")}]  (${text.length} chars) ---`);
  console.log(text.slice(0, 600));
  console.log();
});
fs.writeFileSync("docs_test/unsiloed_raw.json", JSON.stringify(result, null, 2));
console.log("Full response saved to docs_test/unsiloed_raw.json");
