// One-time ingest: load the tagged corpus into a Moss index so queries can
// filter on metadata. Run `npm run ingest` after putting your Moss keys in .env.
// Verify method names / payload shape against docs.moss.dev -- isolated here.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = process.env.MOSS_INDEX || "disputes";

if (!process.env.MOSS_PROJECT_ID || !process.env.MOSS_PROJECT_KEY) {
  console.error("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env first.");
  process.exit(1);
}

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/dispute_corpus.json"), "utf8"));

// Moss metadata is a Record<string, string>: every value must be a string.
// Drop null/undefined fields (e.g. card_network on non-card chunks) so the
// native binding doesn't choke trying to convert null into a Rust String.
function cleanMetadata(c) {
  const raw = {
    domain: c.domain,
    instrument: c.instrument,
    dispute_type: c.dispute_type,
    rule_type: c.rule_type,
    source: c.source,
    citation: c.citation,
    card_network: c.card_network,
    jurisdiction: c.jurisdiction,
    effective_date: c.effective_date,
    parsed_via: c.parsed_via, // provenance: "Unsiloed" for pipeline-ingested chunks
  };
  const meta = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null && v !== undefined) meta[k] = String(v);
  }
  return meta;
}

const docs = corpus.map((c) => ({
  id: c.id,
  text: c.text,
  // metadata used for filtering + citations at query time
  metadata: cleanMetadata(c),
}));

const { MossClient } = await import("@moss-dev/moss");
const client = new MossClient(process.env.MOSS_PROJECT_ID, process.env.MOSS_PROJECT_KEY);

console.log(`Creating index "${INDEX}" with ${docs.length} chunks…`);
// createIndex(name, docs, embeddingModel) -- confirm the embedding-model arg at docs.moss.dev
await client.createIndex(INDEX, docs, "moss-minilm");
console.log("Done. The app will now query Moss instead of BM25.");
