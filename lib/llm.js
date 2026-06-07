// Guidance layer. Turns the retrieved chunks into an answer: detected dispute
// type, compliant phrasing, do / do-not, and the requirement panels. Uses the
// TrueFoundry AI Gateway (OpenAI-compatible) when configured; otherwise builds
// the guidance deterministically from the retrieved chunks so the app still runs.
import OpenAI from "openai";
import { detectDisputeType, classifyIntent as classifyIntentLocal } from "./intent.js";
import { redact as redactLocal } from "./redact.js";

const TF_ON = !!(process.env.TRUEFOUNDRY_API_KEY && process.env.TRUEFOUNDRY_BASE_URL);
export const llmBackend = () => (TF_ON ? "truefoundry" : "local");

// One configured client for the TrueFoundry gateway (OpenAI-compatible).
const tfClient = () =>
  new OpenAI({ apiKey: process.env.TRUEFOUNDRY_API_KEY, baseURL: process.env.TRUEFOUNDRY_BASE_URL });

// Friendly labels for the PII categories TrueFoundry's guardrail returns.
const PII_LABEL = {
  CreditCardNumber: "card", CreditDebitNumber: "card", USSocialSecurityNumber: "ssn",
  USBankAccountNumber: "bank acct", ABARoutingNumber: "routing", Email: "email",
  PhoneNumber: "phone",
};
// Only these are masked. Dates, merchant names, amounts, etc. must reach the
// copilot so it can reason about the dispute — we never blind it to "what was asked".
const SENSITIVE = new Set(Object.keys(PII_LABEL));

// PII redaction via the TrueFoundry gateway guardrail. We send the raw text
// through the gateway; TrueFoundry's input guardrail masks PII BEFORE any model
// sees it and reports exactly what it redacted in `guardrail_checks`. We read the
// masked text + detected entities straight from there. Falls back to the local
// regex masker only when the gateway is off or errors.
export async function redactPII(text) {
  if (!TF_ON) return { ...redactLocal(text), engine: "local" };
  try {
    const base = process.env.TRUEFOUNDRY_BASE_URL.replace(/\/$/, "");
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TRUEFOUNDRY_API_KEY}`, "Content-Type": "application/json" },
      // max_tokens:1 — the guardrail runs on INPUT regardless, so we don't need a
      // real completion, just the guardrail_checks it returns alongside.
      body: JSON.stringify({
        model: process.env.TRUEFOUNDRY_MODEL || "openai/gpt-4o-mini",
        max_tokens: 1, temperature: 0,
        messages: [{ role: "user", content: text }],
      }),
    });
    const j = await resp.json();
    const checks = j?.guardrail_checks?.input_guardrails || [];
    const data = (checks.find((c) => c.transformed) || checks[0])?.data?.[0];
    // Mask ONLY genuinely-sensitive spans (card/SSN/account/email/phone) and keep
    // everything else (dates, merchants, amounts) intact for both screen and copilot.
    const entities = (data?.entities || []).filter((e) => SENSITIVE.has(e.category));
    if (!entities.length) return { clean: text, masked: false, types: [], engine: "truefoundry" };
    let clean = text;
    for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
      if (typeof e.offset === "number" && typeof e.length === "number") {
        clean = clean.slice(0, e.offset) + "•".repeat(Math.min(e.length, 16)) + clean.slice(e.offset + e.length);
      }
    }
    const types = [...new Set(entities.map((e) => PII_LABEL[e.category] || e.category.toLowerCase()))];
    return { clean, masked: true, types, engine: "truefoundry" };
  } catch (e) {
    console.warn(`[redact] TrueFoundry redaction failed, using local masker: ${e.message}`);
    return { ...redactLocal(text), engine: "local" };
  }
}

const KNOWN_TYPES = ["unauthorized_transaction", "cancelled_recurring", "goods_not_received", "flight_cancellation"];

// Intent triage through TrueFoundry: decides greeting/help/dispute and, for a
// dispute, the type — using the running conversation for context so thin
// follow-ups ("yeah, I have the email") are read correctly. Falls back to the
// local regex classifier only when the gateway is off or errors.
export async function classifyIntent(utterance, history = []) {
  if (!TF_ON) return classifyIntentLocal(utterance);
  try {
    const client = tfClient();
    const model = await resolveModel(client);
    const sys =
      "You triage messages on a LIVE bank dispute/refund call. Classify the latest caller message, using prior turns for context. " +
      "intent is one of: greeting, help, thanks, offtopic (non-dispute small talk), or dispute (any unauthorized charge, billing problem, " +
      "subscription still charging, goods/services not received, or refund request). " +
      'If intent is "dispute", set dispute_type to one of: unauthorized_transaction, cancelled_recurring, goods_not_received, ' +
      'flight_cancellation, or "unclear" if it is clearly a dispute but the type is not yet determinable.\n' +
      "STICKINESS: once an earlier turn established a dispute type, KEEP that same type unless the caller clearly raises a different " +
      "problem. A short reply like \"yes\", \"no\", or a fact that simply answers your previous question does NOT change the dispute type. " +
      'Return STRICT JSON only: {"intent":"","dispute_type":""}.';
    const priorTurns = (history || [])
      .filter((m) => m && m.role && m.content)
      .slice(-6)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
    const messages = [
      { role: "system", content: sys },
      ...priorTurns,
      { role: "user", content: `Latest caller message: "${utterance}"\nReturn the JSON.` },
    ];
    let resp;
    try {
      resp = await client.chat.completions.create({ model, temperature: 0, max_tokens: 60, response_format: { type: "json_object" }, messages });
    } catch {
      resp = await client.chat.completions.create({ model, temperature: 0, max_tokens: 60, messages });
    }
    const parsed = parseJsonLoose(resp.choices?.[0]?.message?.content);
    if (!parsed || !parsed.intent) return classifyIntentLocal(utterance);
    const intent = String(parsed.intent).toLowerCase();
    if (intent === "dispute") {
      const dt = String(parsed.dispute_type || "").toLowerCase();
      return KNOWN_TYPES.includes(dt)
        ? { intent: "dispute", disputeType: dt }
        : { intent: "dispute_unclear", disputeType: null };
    }
    return { intent, disputeType: null };
  } catch (e) {
    console.warn(`[llm] intent triage failed, using local classifier: ${e.message}`);
    return classifyIntentLocal(utterance);
  }
}

// Conversational replies for non-dispute input (greetings, help, off-topic).
// Same shape as guidance so the frontend renders it without special-casing.
export function chatReply(intent) {
  const base = { mode: "chat", dispute_type: intent, label: "", summary: "", say: "", ask: [], todo: [], dont: [], requirements: [], citations: [] };
  switch (intent) {
    case "greeting":
      return { ...base, label: "Call opening",
        say: "Hi, thanks for calling — I'm happy to help get this sorted. Can you tell me what's going on with the charge?" };
    case "help":
      return { ...base, label: "Scope the issue",
        say: "Of course — I can help with an unrecognized charge, a subscription that kept billing after you cancelled, an order that never arrived, or a refund. Which one is it?" };
    case "thanks":
      return { ...base, label: "Wrap up",
        say: "You're welcome — is there anything else I can help you with on the account today?" };
    default: // offtopic | unclear
      return { ...base, label: "Clarify",
        say: "I want to make sure I help with the right thing — can you tell me what happened with the charge?" };
  }
}

// Conversational reply for non-dispute turns (greeting / small talk / scoping),
// generated live by TrueFoundry so nothing in Agent Guidance is canned. Coaches
// the rep's next line toward identifying the dispute. Falls back to chatReply()
// only when the gateway is off or errors.
export async function converseReply(utterance, intent, history = []) {
  if (!TF_ON) return chatReply(intent);
  try {
    const client = tfClient();
    const model = await resolveModel(client);
    const sys =
      "You are a real-time copilot coaching a human agent in a bank's dispute & refund call center. " +
      "The caller's latest message is NOT yet a dispute (a greeting, thanks, small talk, or a vague/scoping line). " +
      "Write the ONE natural, warm, professional line the AGENT should say next to open the call or steer toward identifying the " +
      "issue (an unrecognized charge, a subscription still billing after cancellation, goods not received, or a refund). " +
      "One or two sentences. Never invent account details, names, or amounts. Do not introduce yourself as an AI or 'copilot'. " +
      'Return STRICT JSON only: {"label":"","say":""} — label is a 1-3 word tag like "Call opening" or "Scope the issue".';
    const priorTurns = (history || [])
      .filter((m) => m && m.role && m.content)
      .slice(-6)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
    const messages = [
      { role: "system", content: sys },
      ...priorTurns,
      { role: "user", content: `Caller said: "${utterance}"\nReturn the JSON.` },
    ];
    let resp;
    try {
      resp = await client.chat.completions.create({ model, temperature: 0.4, max_tokens: 120, response_format: { type: "json_object" }, messages });
    } catch {
      resp = await client.chat.completions.create({ model, temperature: 0.4, max_tokens: 120, messages });
    }
    const parsed = parseJsonLoose(resp.choices?.[0]?.message?.content);
    if (!parsed?.say) return chatReply(intent);
    return { mode: "chat", dispute_type: intent, label: parsed.label || "", summary: "", say: parsed.say, ask: [], todo: [], dont: [], requirements: [], citations: [] };
  } catch (e) {
    console.warn(`[llm] converse reply failed, using static: ${e.message}`);
    return chatReply(intent);
  }
}

// Curated do/do-not + phrasing per dispute type, consistent with the approved
// scripts in the corpus. Used by the local fallback and as guardrails for the LLM.
const PLAYBOOK = {
  unauthorized_transaction: {
    label: "Unauthorized charge",
    say: "I've opened your dispute. If we can't finish the review within 10 business days, you'll receive a provisional credit while we investigate, and written confirmation of the claim.",
    todo: ["Open the dispute and start the timeline clock", "Issue provisional credit if the review runs past 10 business days", "Send written confirmation of the claim"],
    dont: ["Do not accuse the customer or imply they made the purchase", "Do not discourage the customer from filing", "Do not promise a specific final outcome"],
  },
  cancelled_recurring: {
    label: "Cancelled subscription still billing",
    say: "I'll stop any future charges from that merchant and dispute the charges billed after you cancelled. Do you have a cancellation confirmation I can note?",
    todo: ["Capture the cancellation date and method", "Stop future preauthorized charges from the merchant", "Dispute the post-cancellation charges"],
    dont: ["Do not tell the customer the charge is valid just because they used the service", "Do not require the customer to keep contacting the merchant alone"],
  },
  goods_not_received: {
    label: "Goods or services not received",
    say: "I'll file a not-received dispute. The merchant gets a window to show proof of delivery; if they can't, the charge is reversed.",
    todo: ["Confirm the expected delivery/service date has passed", "Note any attempt to resolve with the merchant", "File the not-received dispute with the order details"],
    dont: ["Do not promise the charge will be reversed before the investigation", "Do not skip recording the expected delivery date"],
  },
  flight_cancellation: {
    label: "Flight cancellation refund",
    say: "You're entitled to a full cash refund to your original form of payment, and I can start that now — the voucher is optional, not required.",
    todo: ["Confirm the cancellation was carrier-initiated", "Issue a cash refund to the original payment", "Void the voucher if one was issued"],
    dont: ["Do not steer the passenger to a voucher or rebooking as the only option", "Do not require the passenger to request the refund"],
  },
};

function requirementsFrom(hits) {
  // Pull the cited authorities (regulations + network reason codes) for the panel.
  const seen = new Set();
  return hits
    .map((h) => h.chunk)
    .filter((c) => ["regulation", "network_reason_code"].includes(c.rule_type))
    .filter((c) => (seen.has(c.citation) ? false : seen.add(c.citation)))
    .map((c) => ({ citation: c.citation, source: c.source, rule_type: c.rule_type }));
}

function localGuide(utterance, hits, disputeType) {
  // Classify from the caller's own words first, then a confident retrieval hit.
  // If we still can't tell, ASK rather than defaulting to "unauthorized charge".
  const type =
    disputeType ||
    detectDisputeType(utterance) ||
    (hits[0]?.score > 0 ? hits[0]?.chunk?.dispute_type : null);

  if (!type || !PLAYBOOK[type]) {
    return {
      mode: "chat",
      dispute_type: "unclear",
      label: "Which kind of dispute is this?",
      summary: "I couldn't pin down the dispute type from that.",
      say: "Could you say a bit more? For example: the charge is unauthorized, a subscription kept billing after cancelling, goods never arrived, or a flight was cancelled.",
      todo: [], dont: [], requirements: [], citations: [],
    };
  }

  const pb = PLAYBOOK[type];
  return {
    mode: "dispute",
    dispute_type: type,
    label: pb.label,
    summary: `Detected as "${pb.label}" from the caller's statement and the indexed rulebook.`,
    say: pb.say,
    todo: pb.todo,
    dont: pb.dont,
    requirements: requirementsFrom(hits),
    citations: hits.map((h) => h.chunk.citation),
  };
}

// Resolve the model id from the gateway: prefer TRUEFOUNDRY_MODEL when it's
// actually enabled, otherwise auto-pick whatever model is connected. Cached, so
// the list is fetched once. Keeps the app provider-agnostic — connect OpenAI,
// Gemini, or Groq in the dashboard and it picks it up on restart.
let _modelId = null;
async function resolveModel(client) {
  if (_modelId) return _modelId;
  const want = process.env.TRUEFOUNDRY_MODEL;
  try {
    const ids = (await client.models.list()).data?.map((m) => m.id) || [];
    _modelId = want && ids.includes(want) ? want : ids[0] || want || "openai/gpt-4o-mini";
  } catch {
    _modelId = want || "openai/gpt-4o-mini";
  }
  return _modelId;
}

// Some gateway providers ignore response_format; pull JSON out defensively.
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

export async function guide(utterance, hits, disputeType, history = []) {
  if (!TF_ON) return localGuide(utterance, hits, disputeType);

  try {
    const client = tfClient(); // TrueFoundry gateway, OpenAI-compatible

    const context = hits
      .map((h, i) => `[${i + 1}] (${h.chunk.dispute_type} | ${h.chunk.citation}) ${h.chunk.text}`)
      .join("\n");

    const sys =
      "You are a compliance copilot riding along on a LIVE dispute call, advising the agent in real time. " +
      "You are mid-conversation: read the prior turns, track what the caller HAS and HAS NOT disclosed, and never re-ask " +
      "something already answered. Use ONLY the retrieved rulebook context for rules/citations; never invent rules or citations. " +
      "Classify the dispute and produce safe agent guidance.\n" +
      "BE FAST — this is a SHORT call (under a minute). Bias HARD toward action over questions: aim to wrap in 2-3 exchanges. " +
      "The moment you have enough to file, STOP asking and give the disposition and next steps. Do not drag it out.\n" +
      "THIS IS A LIVE BANK CALL. Follow the real representative flow, IN ORDER, and never skip ahead:\n" +
      "(1) FIRST, ALWAYS verify the caller's identity — their name and the LAST FOUR digits of the card (never the full number). " +
      "Do NOT open, file, or promise anything until identity is verified — that is always the very first step.\n" +
      "(2) Then ask only the few questions a real rep asks that the bank can't look up: \"Do you recognize this merchant at all?\", " +
      "\"Is your card still in your possession?\", \"Did you authorize anyone else to use it?\".\n" +
      "(3) Then act: if the card is compromised, block it and issue a new one; open the dispute / Reg E claim; explain provisional " +
      "credit and the timeline.\n" +
      "Do NOT narrate system lookups in what you SAY — NEVER say things like \"I'll pull up your transactions\" or \"let me check " +
      "your account\": you cannot show results, so it reads as hollow. Reviewing the account is a rep action that belongs in the " +
      "what-to-do steps, not the spoken line.\n" +
      "The bank ALREADY HAS the amounts, dates, and merchant names — NEVER interrogate the caller for those and never loop on a date " +
      "or amount. Refer to the charges GENERICALLY (\"these charges\", \"the disputed transactions\") — do NOT echo specific merchant " +
      "names or amounts back to the caller. Never re-ask anything already answered.\n" +
      "`say` is the agent's next line — usually JUST the next question, in ONE short warm sentence with NO preamble. " +
      "CRITICAL: do NOT prefix your turns with your plan (\"I'll dispute the $X charge for you...\", \"I'll file the dispute...\"). " +
      "Saying that every turn is robotic and infuriating. State the disposition on the SINGLE turn you first decide it, then NEVER " +
      "again — after that, every line is simply the next question, with no restating. Vary your wording; never repeat a sentence " +
      "you've already said. If the caller can't answer, say you'll pull it from the account and move on. Once you have what you " +
      "need, state the next action.\n" +
      "`ask` lists AT MOST 1-2 ESSENTIAL questions still needed to act — prefer fewer, and return [] the moment you can proceed. " +
      "This is a short call: gather only what's truly required to file (verify identity, confirm which charges are disputed). " +
      "Do NOT ask minor things like payment method, exact timestamps, or whether they contacted the merchant. Each ask is a real, " +
      "natural question tailored to this dispute — never bare words. Never ask for a full card number, CVV, PIN, or SSN.\n" +
      'Return STRICT JSON only: {"dispute_type":"","label":"","summary":"","say":"","ask":[],"todo":[],"dont":[],"citations":[]}.';

    const typeLine = disputeType
      ? `\n\nThe established dispute type for this call is: ${disputeType}. Your summary, say, and ask MUST be consistent with this type — never describe it as a different kind of dispute.`
      : "";
    const user = `Caller just said: "${utterance}"${typeLine}\n\nRetrieved rulebook context:\n${context}\n\nReturn the JSON.`;

    // Thread the prior back-and-forth so the copilot remembers the conversation.
    const priorTurns = (history || [])
      .filter((m) => m && m.role && m.content)
      .slice(-8)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));

    const model = await resolveModel(client);
    const messages = [
      { role: "system", content: sys },
      ...priorTurns,
      { role: "user", content: user },
    ];

    let resp;
    try {
      resp = await client.chat.completions.create({
        model, temperature: 0, response_format: { type: "json_object" }, messages,
      });
    } catch {
      // Retry without response_format for providers that reject it.
      resp = await client.chat.completions.create({ model, temperature: 0, messages });
    }

    const parsed = parseJsonLoose(resp.choices?.[0]?.message?.content);
    if (!parsed) return localGuide(utterance, hits, disputeType);
    parsed.mode = "dispute";
    // Single source of truth: anchor the type/label to the triage classification
    // so the label can never contradict the summary (e.g. "Cancelled Subscription"
    // while the summary says "has not cancelled"). The model still writes say/ask.
    if (disputeType && PLAYBOOK[disputeType]) {
      parsed.dispute_type = disputeType;
      parsed.label = PLAYBOOK[disputeType].label;
    }
    parsed.requirements = requirementsFrom(hits);
    if (!Array.isArray(parsed.ask)) parsed.ask = [];
    // Real calls verify identity FIRST. If the conversation hasn't addressed it yet,
    // force the next line to be identity verification before any dispute action.
    const convoAll = [...(history || []).map((m) => String(m?.content || "")), utterance].join(" ");
    const identityHandled = /\b(last four|last 4|ending (in )?\d|verif\w+ (your )?identity|your (full )?name|date of birth|\bdob\b)\b/i.test(convoAll);
    if (!identityHandled) {
      parsed.say = "First, let me verify your identity — can you confirm your name and the last four digits of your card?";
      parsed.ask = ["Full name on the account", "Last four digits of the card"];
    }
    // Kill the repetitive disposition line: if we already said "I'll dispute/block/…"
    // earlier in the call, strip it so this turn is just the next question — and if
    // nothing's left to say, wrap instead of repeating the same line.
    const DISPO = "(go ahead and\\s+)?(dispute|file|open|start|reverse|refund|block|cancel|reissue|close)";
    const saidBefore = (history || []).some((m) => m && m.role === "assistant" && new RegExp(`\\bi['’]?ll\\s+${DISPO}\\b`, "i").test(String(m.content)));
    if (saidBefore && parsed.say) {
      const stripped = parsed.say.replace(new RegExp(`^\\s*i['’]?ll\\s+${DISPO}[^.?!]*[.?!]\\s*`, "i"), "").trim();
      if (stripped) parsed.say = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      else if (parsed.ask?.length) parsed.say = parsed.ask[0];
      else parsed.say = "Is there anything else I can help you with today?";
    }
    // The spoken line must always drive the call forward. If the model returned a
    // bare acknowledgement with no question while facts are still missing, append
    // the top open question so the rep is never left with a dead-end line.
    if (parsed.say && !parsed.say.includes("?") && parsed.ask.length) {
      parsed.say = parsed.say.trim() + " " + parsed.ask[0];
    }
    // Grounding guard: keep ONLY citations that came from the retrieved context —
    // never let the model cite a rule from memory. Fall back to all retrieved
    // citations if it cited nothing valid.
    const retrieved = new Set(hits.map((h) => h.chunk.citation));
    parsed.citations = (parsed.citations || []).filter((c) => retrieved.has(c));
    if (!parsed.citations.length) parsed.citations = hits.map((h) => h.chunk.citation);
    return parsed;
  } catch (e) {
    console.warn(`[llm] TrueFoundry call failed, using local guidance: ${e.message}`);
    return localGuide(utterance, hits, disputeType);
  }
}
