import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { retrieve, retrievalBackend, CORPUS } from "./lib/retrieval.js";
import { guide, converseReply, llmBackend, classifyIntent, redactPII } from "./lib/llm.js";
import { detectDisputeType } from "./lib/intent.js";
import { redact } from "./lib/redact.js"; // sync local masker for the history re-scan

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Which engines are actually live (drives the honesty badges in the UI).
app.get("/api/health", (_req, res) => {
  res.json({
    retrieval: retrievalBackend(),
    llm: llmBackend(),
    chunks: CORPUS.length,
    domains: [...new Set(CORPUS.map((c) => c.domain))],
  });
});

// Core endpoint: caller utterance -> retrieve (Moss/BM25) -> guide (TrueFoundry/local).
app.post("/api/resolve", async (req, res) => {
  try {
    const { utterance, k = 4, history = [], establishedType = null } = req.body || {};
    if (!utterance || !utterance.trim()) return res.status(400).json({ error: "utterance required" });

    // PII guardrail (TrueFoundry): mask card/SSN/email via the gateway guardrail
    // BEFORE anything else sees the text. Falls back to a local masker if the
    // gateway is unavailable. Only invoked when the text plausibly carries PII
    // (a digit or an "@") so ordinary turns skip the extra round-trip.
    const { clean, masked, types, engine: piiEngine } = /[\d@]/.test(utterance)
      ? await redactPII(utterance)
      : { clean: utterance, masked: false, types: [], engine: llmBackend() };

    // Intent gate (TrueFoundry): greetings / help / off-topic get a conversational
    // reply and skip retrieval entirely, so we never force chit-chat into a dispute.
    let { intent, disputeType } = await classifyIntent(clean, history);

    // Deterministic stickiness: once a dispute type is established on the call, keep
    // it for every follow-up — only switch when THIS message clearly signals a
    // different dispute. Stops thin replies ("no", "I don't know") from flipping the
    // classification. Pleasantries still route to the conversational path.
    if (establishedType && intent !== "greeting" && intent !== "help" && intent !== "thanks") {
      const signal = detectDisputeType(clean);
      disputeType = signal && signal !== establishedType ? signal : establishedType;
      intent = "dispute";
    }
    if (intent !== "dispute" && intent !== "dispute_unclear") {
      return res.json({
        utterance: clean,
        pii: { masked, types, engine: piiEngine },
        retrieval: { backend: "none", ms: 0 },
        hits: [],
        guidance: await converseReply(clean, intent, history),
        llm: llmBackend(),
      });
    }

    // Retrieve in conversational context: blend the recent user turns into the
    // query so thin follow-ups ("yes, I have the email") still pull the right rules.
    const recentUser = (history || [])
      .filter((m) => m && m.role === "user" && m.content)
      .slice(-2)
      .map((m) => redact(String(m.content)).clean);
    const retrievalQuery = [...recentUser, clean].join(" ");

    // Auto-route the domain from the dispute itself — the rep never picks "Cards
    // vs Travel". Flight/airline disputes hit the travel corpus; everything else
    // is cards. Instrument is left open so retrieval spans debit + credit rules.
    const domain =
      disputeType === "flight_cancellation" || /\b(flight|airline|airfare|voucher|boarding|carrier)\b/i.test(clean)
        ? "travel"
        : "cards";
    const r = await retrieve(retrievalQuery, { domain, instrument: "any", dispute_type: disputeType || undefined }, k);
    const g = await guide(clean, r.hits, disputeType, history);

    res.json({
      utterance: clean,
      pii: { masked, types, engine: piiEngine },
      retrieval: { backend: r.backend, ms: r.ms },
      hits: r.hits.map((h) => ({
        citation: h.chunk.citation,
        source: h.chunk.source,
        dispute_type: h.chunk.dispute_type,
        rule_type: h.chunk.rule_type,
        instrument: h.chunk.instrument,
        parsed_via: h.chunk.parsed_via || null,
        score: +(h.score || 0).toFixed(2),
        text: h.chunk.text,
      })),
      guidance: g,
      llm: llmBackend(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Recourse running at http://localhost:${PORT}`);
  console.log(`  retrieval: ${retrievalBackend()}   llm: ${llmBackend()}\n`);
});
