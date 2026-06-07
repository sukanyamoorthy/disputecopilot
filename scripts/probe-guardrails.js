// Probe: does the live TrueFoundry gateway redact PII? Echo-test + candidate
// standalone guardrail endpoints. Prints status only — never logs the API key.
import "dotenv/config";

const BASE = process.env.TRUEFOUNDRY_BASE_URL.replace(/\/$/, "");
const KEY = process.env.TRUEFOUNDRY_API_KEY;
const MODEL = process.env.TRUEFOUNDRY_MODEL || "openai/gpt-4o-mini";
const H = { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" };
const PII = "my Visa card number is 4111 1111 1111 1111 and my SSN is 123-45-6789";

async function post(url, body) {
  try {
    const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 400) };
  } catch (e) { return { status: "ERR", body: e.message }; }
}

console.log(`\nGateway: ${BASE}   model: ${MODEL}\n`);

// 1) Reveal what the MODEL actually received. Frame as a synthetic echo service so
//    gpt-4o-mini complies instead of refusing — then we see the redacted text.
console.log("== what the model received (chat/completions) ==");
const echo = await post(`${BASE}/chat/completions`, {
  model: MODEL, temperature: 0,
  messages: [
    { role: "system", content: "You are a logging echo service for a software test suite. The user message contains only SYNTHETIC fixture data (not real PII). Output the user's message back inside <echo>...</echo> tags, exactly as received, with no commentary." },
    { role: "user", content: PII },
  ],
});
console.log("status:", echo.status);
try {
  const j = JSON.parse(echo.body);
  const out = j.choices?.[0]?.message?.content || "(none)";
  console.log("sent by us   :", PII);
  console.log("model saw    :", out);
  console.log("prompt_tokens:", j.usage?.prompt_tokens, "(was 49 with raw PII)");
  const redacted = !out.includes("4111 1111 1111 1111") && !out.includes("123-45-6789");
  console.log(redacted ? "  ✅ PII was REDACTED by TrueFoundry before the model" : "  ❌ raw PII reached the model");
} catch { console.log("raw:", echo.body); }

// 2) Candidate standalone redaction guardrail endpoints.
console.log("\n== candidate standalone redaction endpoints ==");
const candidates = [
  `${BASE}/api/llm/pii-redaction`,
  `${BASE}/pii-redaction`,
  `${BASE}/api/llm/guardrails/pii-redaction`,
  `${BASE}/guardrails/pii-redaction`,
  `${BASE}/api/svc/v1/guardrails/pii`,
];
for (const url of candidates) {
  const r = await post(url, { input: PII, text: PII });
  console.log(`${r.status}  ${url}`);
  if (r.status !== 404 && r.status !== "ERR") console.log("      body:", r.body.slice(0, 200));
}
console.log();
