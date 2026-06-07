// Lightweight, LLM-free intent + dispute-type detection. Lets the copilot tell
// a greeting / off-topic message apart from an actual dispute instead of forcing
// every utterance through the dispute pipeline, and classifies the dispute type
// from the caller's own words rather than "whatever chunk ranked first".

const GREETING = /^(hi+|hey+|hello+|hiya|yo|sup|howdy|greetings|good\s+(morning|afternoon|evening|day))\b/i;
const THANKS = /\b(thanks|thank you|cheers|appreciate it)\b/i;
const HELP = /(what can you do|who are you|what is this|what do you do|how (do|does) (this|you) work|^\s*help\s*$)/i;

// Per-type keyword signals. First match wins; order is the tie-break priority.
const TYPE_SIGNALS = [
  ["flight_cancellation", /\b(flight|airline|carrier|voucher|boarding|airfare|canc[ei]l(l?ed)?\s+flight)\b/i],
  ["cancelled_recurring", /\b(subscription|recurring|membership|auto[- ]?renew|still (billing|charging)|after i canc[ei]l|canc[ei]l(l?ed|l?ing)?\b.*\b(charge|bill|subscription|member))\b/i],
  ["goods_not_received", /\b(not received|never (arrived|came|got|delivered|showed|received)|did(n'?t| not) (arrive|receive|get)|not delivered|no delivery|package|undelivered)\b/i],
  ["unauthorized_transaction", /\b(unauthor[is]zed|fraud|stolen|did(n'?t| not) (make|authori[sz]e)|never (made|authori[sz]ed)|do(n'?t| not) recognize|unrecognized|someone (used|charged)|charge i did)\b/i],
];

// Generic "this is about a charge/refund" signal even when the type is unclear.
const DISPUTE_GENERIC = /\b(charge|charged|charges|refund|disput|money back|billed|double[- ]?charged|charged twice|transaction|chargeback)\b/i;

export function detectDisputeType(text) {
  for (const [type, re] of TYPE_SIGNALS) if (re.test(text)) return type;
  return null;
}

// Returns { intent, disputeType }. intent is one of:
//   greeting | help | thanks | offtopic | unclear  (non-dispute, answered conversationally)
//   dispute            (a dispute with a recognized type)
//   dispute_unclear    (clearly a charge/refund issue, but type not yet certain)
export function classifyIntent(utterance) {
  const t = (utterance || "").trim();
  if (!t) return { intent: "unclear", disputeType: null };

  const type = detectDisputeType(t);
  if (type) return { intent: "dispute", disputeType: type };
  if (DISPUTE_GENERIC.test(t)) return { intent: "dispute_unclear", disputeType: null };

  if (HELP.test(t)) return { intent: "help", disputeType: null };
  if (THANKS.test(t)) return { intent: "thanks", disputeType: null };
  if (GREETING.test(t)) return { intent: "greeting", disputeType: null };
  return { intent: "offtopic", disputeType: null };
}
