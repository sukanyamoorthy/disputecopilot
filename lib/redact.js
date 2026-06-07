// PII guardrail. Masks sensitive numbers (card, SSN) out of the caller's
// utterance BEFORE it ever reaches retrieval, the LLM, logs, or the screen.
//
// In production this is a TrueFoundry AI-Gateway guardrail (PII masking is
// configured once on the gateway and enforced on every model call centrally).
// That config lives in your TrueFoundry console, not in code -- so for the
// local demo the same masking is applied here in the pipeline, which is what
// makes the "say your card number and watch it disappear" moment work offline.
export function redact(text) {
  const types = new Set();
  let clean = text;

  // Card numbers: 13-19 digits, optionally split by spaces/dashes. Keep last 4.
  clean = clean.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19) {
      types.add("card");
      return "•••• •••• •••• " + digits.slice(-4);
    }
    return m;
  });

  // SSN in 3-2-4 form (dashes or spaces). Keep last 4.
  clean = clean.replace(/\b\d{3}[ -]\d{2}[ -]\d{4}\b/g, (m) => {
    types.add("ssn");
    return "•••-••-" + m.replace(/\D/g, "").slice(-4);
  });

  // Bare 9-digit SSN.
  clean = clean.replace(/\b\d{9}\b/g, (m) => {
    types.add("ssn");
    return "•••-••-" + m.slice(-4);
  });

  return { clean, masked: types.size > 0, types: [...types] };
}
