const $ = (s) => document.querySelector(s);
let nextViaVoice = false;
let convo = []; // running conversation: [{role, content, t}]
let establishedType = null; // dispute type locked in for this call
const KNOWN_TYPES = ["unauthorized_transaction", "cancelled_recurring", "goods_not_received", "flight_cancellation"];
let callStart = null, timerInt = null;

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function stamp() { return callStart ? fmt(Date.now() - callStart) : "0:00"; }

function startTimer() {
  if (timerInt) return;
  timerInt = setInterval(() => { $("#callTimer").textContent = stamp(); }, 1000);
}

function renderTranscript() {
  const el = $("#transcript");
  if (!convo.length) {
    el.innerHTML = '<div class="empty">The conversation appears here. Type what the caller said to begin.</div>';
    return;
  }
  el.innerHTML = convo.map((m) => m.role === "user"
    ? `<div class="turn caller"><div class="tmeta"><span class="avatar c">C</span><span class="ts">${m.t || ""}</span></div><div class="bubble user">${esc(m.content)}</div></div>`
    : `<div class="turn agent"><div class="tmeta"><span class="ts">${m.t || ""}</span><span class="avatar r">R</span></div><div class="bubble bot">${esc(m.content)}</div></div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

async function loadHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    const ret = $("#chip-ret"), llm = $("#chip-llm");
    ret.innerHTML = `<span class="edot"></span>${h.retrieval === "moss" ? "Moss" : "BM25 (local)"}`;
    ret.className = "engine " + (h.retrieval === "moss" ? "live" : "fallback");
    llm.innerHTML = `<span class="edot"></span>${h.llm === "truefoundry" ? "TrueFoundry" : "local"}`;
    llm.className = "engine " + (h.llm === "truefoundry" ? "live" : "fallback");
  } catch {}
}

function setStatus(t) { const el = $("#voiceStatus"); if (el) el.textContent = t || ""; }

function speak(text) {
  try {
    const synth = window.speechSynthesis; if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.03; u.pitch = 1;
    u.onstart = () => setStatus("Speaking…");
    u.onend = () => setStatus("");
    synth.speak(u);
  } catch {}
}

function checklist(items, kind) {
  const ic = kind === "ok" ? "✓" : kind === "no" ? "✕" : "?";
  return `<ul class="list">${items.map((t) => `<li><span class="ic ${kind}">${ic}</span><span>${esc(t)}</span></li>`).join("")}</ul>`;
}

function reqCard(h, backend) {
  const src = backend === "moss" ? "Moss" : backend === "bm25" ? "BM25" : backend;
  return `<div class="reqcard">
    <div class="reqhead"><span class="reqtitle">${esc(h.source)}</span><span class="reqpill">${esc(h.rule_type.replace(/_/g, " "))}</span></div>
    <p class="reqbody">${esc(h.text)}</p>
    <div class="reqfoot"><span class="cite">${esc(h.citation)}</span><span class="src ${backend}">${src}</span>${h.parsed_via ? `<span class="src unsiloed">${esc(h.parsed_via)}</span>` : ""}<span class="score">score ${h.score}</span></div>
  </div>`;
}

function renderGuidance(g) {
  // Non-dispute turns (greeting / scoping): coach the rep's next line, no rulebook.
  if (g.mode === "chat") {
    $("#guidance").innerHTML = g.say
      ? `<div class="gcard say-card"><div class="ghead"><span class="gtag">Suggested</span><span class="gtitle">${esc(g.label || "Reply")}</span></div><div class="say"><span class="saylabel">SAY</span>"${esc(g.say)}"</div></div>`
      : `<div class="gcard ready"><p class="gbody">Capture the caller's issue — an unrecognized charge, a subscription still billing, goods not received, or a refund — to see guidance and the governing rules.</p></div>`;
    return;
  }
  // The detected type lives in the header — don't re-announce it every turn. Lead
  // with the single thing the rep needs right now: the line to say next.
  const cards = [];
  if (g.say) cards.push(`<div class="gcard say-card">
    <div class="ghead"><span class="gtag">Say next</span></div>
    <div class="say big">"${esc(g.say)}"</div>
  </div>`);
  if (g.ask?.length) cards.push(`<div class="gcard next">
    <div class="ghead"><span class="gtag">Still need</span><span class="gtitle">Ask the caller</span></div>
    ${checklist(g.ask, "q")}</div>`);
  if (g.todo?.length) cards.push(`<div class="gcard do">
    <div class="ghead"><span class="gtag">Do</span><span class="gtitle">What to do</span></div>
    ${checklist(g.todo, "ok")}</div>`);
  if (g.dont?.length) cards.push(`<div class="gcard dont">
    <div class="dont-label">DO NOT</div>${checklist(g.dont, "no")}</div>`);
  $("#guidance").innerHTML = cards.join("") || '<div class="gcard ready"><p class="gbody">Gathering guidance…</p></div>';
}

async function resolve() {
  const utterance = $("#utterance").value.trim();
  if (!utterance) return;
  const spoken = nextViaVoice; nextViaVoice = false;
  const btn = $("#resolve"); btn.disabled = true; btn.textContent = "…";
  setStatus("Searching…");
  if (!callStart) { callStart = Date.now(); startTimer(); }
  const history = convo.slice();
  convo.push({ role: "user", content: utterance, t: stamp() });
  renderTranscript();
  $("#utterance").value = "";
  $("#hits").innerHTML = '<div class="empty">Retrieving…</div>';
  $("#guidance").innerHTML = '<div class="empty">Thinking…</div>';
  try {
    const r = await (await fetch("/api/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, history, establishedType }),
    })).json();
    if (r.error) throw new Error(r.error);
    const ret = r.retrieval;
    const engine = ret.backend === "moss" ? "Moss" : ret.backend === "bm25" ? "BM25" : ret.backend;
    $("#retmeta").textContent = r.hits.length ? `pulled ${r.hits.length} from ${engine}` : "";
    if (r.utterance && r.utterance !== utterance) convo[convo.length - 1].content = r.utterance;
    // PII redaction surfaced honestly. We keep the label generic ("PII") because the
    // guardrail's per-category guess (card vs phone) isn't always reliable.
    if (r.pii && r.pii.masked) {
      const eng = r.pii.engine === "truefoundry" ? "TrueFoundry" : "local";
      const txt = "🔒 PII redacted · " + eng;
      $("#piiBadge").textContent = txt; $("#piiBadge").style.display = "inline-flex";
      $("#piiHeader").textContent = txt; $("#piiHeader").style.display = "inline-flex";
    } else { $("#piiBadge").style.display = "none"; }
    $("#hits").innerHTML = r.hits.length
      ? r.hits.map((h) => reqCard(h, ret.backend)).join("")
      : '<div class="empty">No rulebook lookup needed for this turn.</div>';
    renderGuidance(r.guidance);
    const g = r.guidance;
    // A real dispute drives the call type and locks the type. The suggested line
    // (dispute guidance OR a greeting/scoping reply) goes into the transcript.
    if (g.mode === "dispute") {
      $("#callType").textContent = g.label || g.dispute_type;
      if (KNOWN_TYPES.includes(g.dispute_type)) establishedType = g.dispute_type;
    }
    const reply = g.say || g.summary || "";
    if (reply) {
      convo.push({ role: "assistant", content: reply, t: stamp() });
      if (spoken) speak(reply); // just the line to say — never announce the dispute type
    }
    setStatus("");
    renderTranscript();
  } catch (e) {
    $("#hits").innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    $("#guidance").innerHTML = ""; setStatus("");
  } finally {
    btn.disabled = false; btn.textContent = "Send";
  }
}

function newCall() {
  convo = []; establishedType = null;
  callStart = null; if (timerInt) { clearInterval(timerInt); timerInt = null; }
  $("#callTimer").textContent = "0:00";
  $("#callType").textContent = "Awaiting caller…";
  renderTranscript();
  $("#utterance").value = "";
  $("#retmeta").textContent = "";
  $("#hits").innerHTML = '<div class="empty">Cited authorities appear here when a dispute is described.</div>';
  $("#guidance").innerHTML = '<div class="empty">Guidance appears here, grounded in the retrieved rulebook.</div>';
  $("#piiBadge").style.display = "none"; $("#piiHeader").style.display = "none";
  setStatus("");
}

$("#resolve").addEventListener("click", resolve);
$("#reset").addEventListener("click", newCall);
$("#utterance").addEventListener("keydown", (e) => { if (e.key === "Enter") resolve(); });

loadHealth();

// --- voice loop (browser Web Speech API; Chrome/Edge) ---
(function setupMic() {
  const mic = document.getElementById("mic");
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) { mic.disabled = true; mic.title = "Voice needs Chrome or Edge"; return; }
  const recog = new Rec();
  recog.lang = "en-US"; recog.interimResults = true; recog.continuous = false;
  let listening = false;
  recog.onresult = (e) => { let t = ""; for (const r of e.results) t += r[0].transcript; $("#utterance").value = t; };
  const stop = () => { listening = false; mic.classList.remove("listening"); };
  recog.onend = () => { stop(); const u = $("#utterance").value.trim(); if (u) { nextViaVoice = true; resolve(); } else setStatus(""); };
  recog.onerror = () => { stop(); setStatus(""); };
  mic.addEventListener("click", () => {
    if (listening) { recog.stop(); return; }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    $("#utterance").value = ""; listening = true; mic.classList.add("listening"); setStatus("Listening…"); recog.start();
  });
})();
