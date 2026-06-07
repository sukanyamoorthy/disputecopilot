# Recourse — Dispute Copilot

A retrieval-grounded copilot for money-back calls (card disputes + flight refunds).
A care rep types what the caller said → it classifies the dispute, retrieves the governing
rules from an indexed corpus, and returns compliant agent guidance: detected type, the next
line to say, what to ask, do / do-not, and the cited authorities. It runs a realistic call
flow (verify identity first → fraud questions → action) so it reads like a real rep.

- **Intent + guidance + PII** → **TrueFoundry** AI Gateway (routes `gpt-4o-mini`). It
  classifies the caller's intent, generates the guidance, and **redacts PII (card/SSN) via a
  gateway guardrail** before any model sees it. Falls back to local rules when keys are absent.
- **Retrieval** → **Moss** vector search over the rulebook, metadata-filtered by dispute
  type/domain. Falls back to local BM25.
- **Corpus** → `data/dispute_corpus.json` (22 chunks) — card-dispute types (unauthorized,
  cancelled-recurring, goods-not-received) + a travel chunk, each tagged with metadata and a
  real citation. Two `Regulation E` chunks were ingested from a real CFR PDF via the
  **Unsiloed** pipeline (see below) and carry a `parsed_via: "Unsiloed"` badge in the UI.
- **Voice** → browser Web Speech API (mic in + spoken replies), Chrome/Edge.

The engine pills in the UI header (**Moss · TrueFoundry · Unsiloed**) show what's live vs.
the local fallbacks.

## Quick start (works with no keys)

```bash
npm install
npm run dev
# open http://localhost:3000
```

Out of the box it runs on **BM25 + rule-based guidance** so you can demo immediately.

## Turn on Moss + TrueFoundry

```bash
cp .env.example .env
# fill in MOSS_PROJECT_ID / MOSS_PROJECT_KEY  (from moss.dev)
# fill in TRUEFOUNDRY_BASE_URL / TRUEFOUNDRY_API_KEY / TRUEFOUNDRY_MODEL
npm run ingest      # one-time: push the corpus into a Moss index
npm run dev
```

Now retrieval runs on Moss and the guidance step runs your model through TrueFoundry.
No other code changes — the chips flip to "Moss" and "TrueFoundry".

## Build corpus chunks from real PDFs — Unsiloed + TrueFoundry (build-time)

Most of the corpus is hand-curated, but some chunks are ingested from real source
documents through a two-vendor pipeline ([`scripts/ingest-pdf.js`](scripts/ingest-pdf.js)):

```bash
# UNSILOED_API_KEY + TRUEFOUNDRY_* in .env, then:
npm run ingest-pdf -- --file docs_test/cfr1005.pdf \
     --domain cards --dispute-type unauthorized_transaction \
     --instrument debit --source "Regulation E" --max 3
# -> writes data/parsed_unauthorized-transaction.json for review
```

Pipeline, and the honest division of labour:

```
raw PDF ──▶ Unsiloed  (POST /parse: OCR + layout, handles scans/columns/tables)
        ──▶ TrueFoundry gateway (gpt-4o-mini): de-scramble two-column OCR + condense to one rule
        ──▶ tag metadata + parsed_via:"Unsiloed", citation flagged REVIEW
        ──▶ data/parsed_<type>.json ──▶ (human verifies citations) ──▶ dispute_corpus.json
        ──▶ npm run ingest ──▶ Moss index ──▶ runtime query
```

- **Unsiloed** parses (the hard OCR/layout lift). On dense two-column legal text the
  reading order can scramble — that's why TrueFoundry cleans it.
- **TrueFoundry** de-scrambles and condenses each chunk to a faithful one-rule snippet.
- **You** confirm the citation: the model *guesses* it, and two-column bleed can
  mis-attribute a section, so citations land flagged `REVIEW(...)` for a human check.

Chunks ingested this way carry `parsed_via: "Unsiloed"` and show an **Unsiloed** badge in
the Authorities column. Two real `Regulation E` chunks (`rege-unsiloed-1/2`) in
`dispute_corpus.json` were produced by exactly this pipeline. Unsiloed/TrueFoundry-clean is
build-time; Moss is the runtime retrieval layer — they never run at the same stage.

## How it fits together

```
caller utterance ─▶ /api/resolve
   ├─ redactPII()      → TrueFoundry guardrail masks card/SSN          ⇢ local masker
   ├─ classifyIntent() → TrueFoundry triages greeting vs dispute       ⇢ local regex
   ├─ retrieve()       → Moss query (filtered by dispute type/domain)  ⇢ BM25 fallback
   └─ guide()          → TrueFoundry LLM (grounded in retrieved ctx)   ⇢ rule-based fallback
◀─ { dispute_type, say, ask, todo, dont, citations, requirements, pii, hits }
```

- `lib/retrieval.js` — the only file that talks to Moss. Swapping search backends = this file.
- `lib/llm.js` — the only file that talks to TrueFoundry (intent, guidance, PII redaction,
  chunk cleaning). `PLAYBOOK` is the **offline fallback** guidance — used only when
  TrueFoundry keys are absent, never in the live path.
- `lib/intent.js` / `lib/redact.js` — local regex intent + PII fallbacks.
- `scripts/ingest.js` — loads the corpus into Moss · `scripts/ingest-pdf.js` — the
  Unsiloed→TrueFoundry chunk pipeline · `scripts/verify.js` — one-shot module verification
  (`28/28`) · `scripts/probe-guardrails.js` — checks the live TrueFoundry PII guardrail.
- `public/` — the 3-column call-console UI.

## Notes / things to verify against vendor docs

- Moss SDK method names (`createIndex`, `loadIndex`, `query`) and the metadata-filter
  operator shape are based on the public docs; confirm them at **docs.moss.dev** and
  adjust `lib/retrieval.js` / `scripts/ingest.js` if your SDK version differs. If the
  `@moss-dev/moss` package or your keys are missing, the app silently uses BM25.
- TrueFoundry's gateway is OpenAI-compatible; set `TRUEFOUNDRY_BASE_URL` to your gateway
  URL and `TRUEFOUNDRY_MODEL` to a model your gateway exposes.
- **PII redaction** is a TrueFoundry **gateway guardrail** (Mutate mode, PII categories) you
  configure in the TrueFoundry console and bind to the model. `lib/llm.js#redactPII` reads
  the redacted text + detected entities from the `guardrail_checks` field. Scope the guardrail
  to `CreditCardNumber` + `USSocialSecurityNumber` only — broader categories (DateTime,
  Organization) will mask dates/merchant names and starve the copilot. `redactPII` masks only
  genuinely-sensitive categories for display; the app degrades gracefully if the guardrail is
  off (local masker) or over-broad.
- The corpus citations are real (Reg E, Reg Z, DOT 14 CFR 259.5, Visa/Mastercard reason
  codes) but the chunk text is condensed for demo. In production, ingest verbatim eCFR
  XML and your licensed network-rule excerpts via Unsiloed and keep the metadata schema.
- Not legal advice.
```
