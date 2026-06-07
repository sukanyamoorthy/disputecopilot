// Minimal BM25 (Okapi) over the in-memory corpus. Used only as the local
// fallback when Moss credentials are absent. Identical role to a Moss query:
// filter by metadata, then rank by relevance.
const STOP = new Set("the a an of to and or for in on at is are be by with as it i my we you me did do does they them their that this within when what how much who was".split(" "));
const tok = (s) => (s.toLowerCase().match(/[a-z0-9$]+/g) || []).filter((w) => !STOP.has(w));

const k1 = 1.5, b = 0.75;

export function bm25Search(corpus, queryText, filter = {}, k = 4) {
  const pool = corpus.filter((c) => Object.entries(filter).every(([key, val]) => val == null || c[key] === val));
  if (pool.length === 0) return [];

  const docs = pool.map((c) => tok(c.text));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N;

  const df = {};
  docs.forEach((d) => new Set(d).forEach((t) => (df[t] = (df[t] || 0) + 1)));
  const idf = (t) => Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));

  const q = tok(queryText);
  const scored = pool.map((chunk, i) => {
    const d = docs[i];
    const tf = {};
    d.forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    let score = 0;
    for (const t of q) {
      if (!tf[t]) continue;
      const num = tf[t] * (k1 + 1);
      const den = tf[t] + k1 * (1 - b + (b * d.length) / avgdl);
      score += idf(t) * (num / den);
    }
    return { chunk, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
