// Retrieval layer. Calls Moss when MOSS_PROJECT_ID/KEY are set; otherwise
// falls back to local BM25. The two paths return the same normalized shape so
// the rest of the app doesn't care which ran. Swapping fully to Moss is just
// providing the env keys -- no other code changes.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bm25Search } from "./bm25.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/dispute_corpus.json"), "utf8")
);

const INDEX = process.env.MOSS_INDEX || "disputes";
const MOSS_ON = !!(process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY);

let _client = null;
async function getMoss() {
  if (_client) return _client;
  // Lazy import so a missing package never crashes the app -- it just falls back.
  const mod = await import("@moss-dev/moss");
  const MossClient = mod.MossClient || mod.default;
  _client = new MossClient(process.env.MOSS_PROJECT_ID, process.env.MOSS_PROJECT_KEY);
  await _client.loadIndex(INDEX); // pulls the index into the in-process runtime
  return _client;
}

function buildMossFilter({ domain, instrument } = {}) {
  // Moss metadata filtering ($eq/$and/$in). Verify operator shape at docs.moss.dev.
  const clauses = [];
  if (domain) clauses.push({ domain: { $eq: domain } });
  if (instrument && instrument !== "any")
    clauses.push({ instrument: { $in: [instrument, "both"] } });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function localFilter({ domain, instrument, dispute_type } = {}) {
  // Mirror of the Moss filter for the BM25 path. When the dispute type is known,
  // scope to it so only the relevant authorities surface (no cross-type noise).
  return (c) =>
    (!domain || c.domain === domain) &&
    (!instrument || instrument === "any" || c.instrument === instrument || c.instrument === "both") &&
    (!dispute_type || c.dispute_type === dispute_type);
}

export async function retrieve(query, filters = {}, k = 4) {
  const t0 = performance.now();

  if (MOSS_ON) {
    try {
      const client = await getMoss();
      // Over-fetch unfiltered, then apply domain/instrument as a JS post-filter.
      // (The cloud filter DSL rejected our shape; post-filtering keeps Moss live
      // and returns the same normalized result either way.)
      const res = await client.query(INDEX, query, { topK: Math.max(k * 5, 20) });
      const pred = localFilter(filters);
      const hits = (res?.docs || res?.results || res || [])
        .map((r) => ({
          chunk: r.metadata ? { ...r.metadata, text: r.text, id: r.id } : r,
          score: r.score ?? 0,
        }))
        .filter((h) => pred(h.chunk))
        .slice(0, k);
      return { backend: "moss", ms: +(performance.now() - t0).toFixed(2), hits };
    } catch (e) {
      console.warn(`[retrieval] Moss query failed, falling back to BM25: ${e.message}`);
    }
  }

  const pred = localFilter(filters);
  const pool = CORPUS.filter(pred);
  const scored = bm25Search(pool, query, {}, k);
  return { backend: "bm25", ms: +(performance.now() - t0).toFixed(2), hits: scored };
}

export const retrievalBackend = () => (MOSS_ON ? "moss" : "bm25");
