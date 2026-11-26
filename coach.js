'use strict';
/* Coach: KI-Chat über die eigenen Werte. Wahlweise mit Claude (Anthropic) oder ChatGPT (OpenAI); die Fragen gehen
   mit dem jeweiligen API-Schlüssel des Nutzers direkt an den Anbieter. Ohne Bibliothek (reines fetch), weil die App
   ohne Build-Schritt und mit strenger CSP läuft. */
window.GesundheitCoach = (() => {
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PROVIDERS = {
  claude: { label: 'Claude', company: 'Anthropic', console: 'console.anthropic.com → API Keys', keyHint: 'sk-ant-…', keyTest: /^sk-ant-[\w-]{20,}$/, keyMsg: 'Das sieht nicht nach einem Anthropic-Schlüssel aus. Er beginnt mit „sk-ant-“.' },
  openai: { label: 'ChatGPT', company: 'OpenAI', console: 'platform.openai.com → API keys', keyHint: 'sk-…', keyTest: /^sk-(?!ant-)[\w-]{20,}$/, keyMsg: 'Das sieht nicht nach einem OpenAI-Schlüssel aus. Er beginnt mit „sk-“.' }
};
const CLAUDE_MODEL = 'claude-opus-5-5';

let ctx = null; // von der App gesetzt: { data, today, goals, demo }
// turns: Gesprächsverlauf unabhängig vom Anbieter. Claude-Antworten behalten ihre Originalblöcke, damit sie unverändert zurückgehen.
const st = { gen: 0, loaded: false, provider: 'claude', keys: { claude: null, openai: null }, openaiModel: null, openaiModels: null,
  turns: [], view: [], system: null, busy: false, abort: null, live: null };

/* ---------- Einstellungen: nur auf diesem Gerät ---------- */
function kv(action, key, value) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gesundheit-coach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('kv', action === 'get' ? 'readonly' : 'readwrite'), s = tx.objectStore('kv');
      const q = action === 'get' ? s.get(key) : action === 'put' ? s.put(value, key) : action === 'clear' ? s.clear() : s.delete(key);
      tx.oncomplete = () => { db.close(); resolve(q.result); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const KEYNAME = { claude: 'apiKey', openai: 'apiKey-openai' }; // „apiKey“ stammt aus Version 2.7 (nur Claude)
async function load() {
  if (st.loaded) return;
  try {
    st.keys.claude = (await kv('get', KEYNAME.claude)) || null;
    st.keys.openai = (await kv('get', KEYNAME.openai)) || null;
    st.openaiModel = (await kv('get', 'openaiModel')) || null;
    const p = await kv('get', 'provider'); if (PROVIDERS[p]) st.provider = p;
  } catch {}
  st.loaded = true;
}
const save = (k, v) => kv('put', k, v).catch(() => {});

/* ---------- Werte für die KI aufbereiten ---------- */
const DAYS = 60, ACT_DAYS = 120;
const D = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
const num = v => Number.isFinite(v) ? String(+v.toFixed(2)) : '';

function buildContext(data, today, goals) {
  const L = [], ms = data.metrics, from = shift(today, -(DAYS - 1));
  L.push(`Heute ist ${D(today).toLocaleDateString('de-DE', { weekday: 'long' })}, ${today}. Datenstand: ${data.fetched_at || data.built || 'unbekannt'}.`);
  L.push(`Ziele: ${goals.steps} Schritte pro Tag, ${goals.sleep} h Schlaf pro Nacht, ${goals.intensityWeek} Intensitätsminuten pro Woche.`);
  if ((data.notes || []).length) L.push('Hinweise zur Datenlage: ' + data.notes.join(' '));

  L.push('\n## Kennzahlen (id | Name | Einheit | Bereich | Werte von–bis | Anzahl)');
  for (const m of ms) L.push(`${m.id} | ${m.name} | ${m.unit === 'h' ? 'Stunden (dezimal)' : m.unit} | ${m.category} | ${m.points[0]?.date || '–'}–${m.points.at(-1)?.date || '–'} | ${m.points.length}`);

  L.push(`\n## Tageswerte der letzten ${DAYS} Tage (CSV, leer = kein Wert)`);
  const maps = ms.map(m => new Map(m.points.filter(p => p.date >= from).map(p => [p.date, p.value])));
  L.push('datum,' + ms.map(m => m.id).join(','));
  for (let i = 0; i < DAYS; i++) {
    const d = shift(from, i), row = maps.map(mp => num(mp.get(d)));
    if (row.some(Boolean)) L.push(d + ',' + row.join(','));
  }

  L.push('\n## Monatsmittel der gesamten Historie (CSV, Mittel der vorhandenen Tageswerte)');
  const months = [...new Set(ms.flatMap(m => m.points.map(p => p.date.slice(0, 7))))].sort();
  L.push('monat,' + ms.map(m => m.id).join(','));
  const monthly = ms.map(m => { const o = {}; for (const p of m.points) { const k = p.date.slice(0, 7); (o[k] ||= []).push(p.value); } return o; });
  for (const k of months) L.push(k + ',' + monthly.map(o => o[k] ? num(o[k].reduce((a, b) => a + b, 0) / o[k].length) : '').join(','));

  const hrv = ms.find(m => m.id === 'hrv');
  const notes = (hrv?.points || []).filter(p => p.date >= shift(today, -13) && p.note);
  if (notes.length) { L.push('\n## HRV-Status der letzten 14 Tage'); for (const p of notes) L.push(`${p.date}: ${p.note}`); }

  const tr = (data.training || []).filter(t => t && t.date).slice(0, 20);
  if (tr.length) { L.push('\n## Trainingsstatus (neueste zuerst)'); for (const t of tr) L.push(JSON.stringify(t)); }

  const ss = (data.sleepSchedule || []).filter(s => s.date >= shift(today, -20));
  if (ss.length) { L.push('\n## Schlafzeiten der letzten 21 Tage (Datum = Aufwachtag)'); for (const s of ss) L.push(`${s.date}: ${String(s.start).slice(11, 16)}–${String(s.end).slice(11, 16)}`); }

  const acts = (data.activities || []), recentFrom = shift(today, -(ACT_DAYS - 1));
  L.push(`\n## Aktivitäten der letzten ${ACT_DAYS} Tage (eine Zeile je Einheit)`);
  for (const a of acts.filter(a => a.date >= recentFrom)) {
    const o = {};
    for (const [k, v] of Object.entries(a)) if (k !== 'laps' && k !== 'id' && v !== null && v !== '' && v !== 0 && !(Array.isArray(v) && !v.length)) o[k] = v;
    L.push(JSON.stringify(o));
  }
  const older = {};
  for (const a of acts.filter(a => a.date < recentFrom)) {
    const k = a.date.slice(0, 7) + ' ' + (a.sport || 'Aktivität'), o = (older[k] ||= { n: 0, min: 0, km: 0 });
    o.n++; o.min += a.durationMinutes || 0; o.km += a.distanceKm || 0;
  }
  const ok = Object.keys(older).sort();
  if (ok.length) { L.push('\n## Ältere Aktivitäten je Monat und Sportart (Anzahl, Stunden, km)'); for (const k of ok) L.push(`${k}: ${older[k].n}, ${num(older[k].min / 60)} h, ${num(older[k].km)} km`); }
  return L.join('\n');
}

const PROMPT = `Du bist der persönliche Gesundheits- und Trainingscoach in einer privaten App. Du sprichst mit der Person, deren Garmin- und Withings-Daten unten stehen, und beantwortest ihre Fragen zu Training, Schlaf, Erholung und Körperwerten.

Antworte auf Deutsch in der Du-Form, konkret und so kurz, wie die Frage es erlaubt. Die Antwort wird auf einem Handy gelesen: meist genügen ein paar Sätze oder eine kurze Liste, Tabellen passen dort nicht. Beginne mit der Antwort selbst.

Stütze dich auf die Daten unten und nenne die Werte und Daten, auf die du dich beziehst, damit die Person es nachprüfen kann. Rechne Durchschnitte und Vergleiche selbst aus den Tageswerten nach. Der aktuelle Tag ist oft noch unvollständig; behandle ihn entsprechend.

Die Daten enthalten Tageswerte und Zusammenfassungen je Aktivität. Sekundenverläufe einzelner Einheiten, Rennprognosen, persönliche Rekorde und Ernährung sind nicht enthalten. Reichen die Daten für eine Frage nicht aus, sag das offen und sag, was du stattdessen daraus ablesen kannst.

Du gibst Einschätzungen und Empfehlungen für Training und Alltag, aber keine medizinischen Diagnosen. Deuten Werte auf etwas hin, das ärztlich abgeklärt werden sollte, sag das klar.`;

/* ---------- Anfragen ---------- */
const STATUS = {
  401: 'Der API-Schlüssel wurde abgelehnt. Prüfe ihn unter „Schlüssel ändern“.',
  403: 'Dieser API-Schlüssel darf das Modell nicht verwenden.',
  404: 'Das gewählte Modell ist für deinen Schlüssel nicht verfügbar. Wähle unten ein anderes.',
  413: 'Die Anfrage ist zu groß. Starte ein neues Gespräch.',
  429: 'Zu viele Anfragen in kurzer Zeit oder das Guthaben deines Kontos ist aufgebraucht. Versuch es gleich noch einmal.',
  529: 'Der KI-Dienst ist gerade überlastet. Versuch es in einer Minute noch einmal.'
};
async function httpError(res) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch {}
  return new Error(STATUS[res.status] || (res.status >= 500 ? 'Der KI-Dienst hat einen Fehler gemeldet. Versuch es gleich noch einmal.' : `Die Anfrage wurde abgelehnt${detail ? ': ' + detail : '.'}`));
}
async function* sse(res) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}
const onText = t => { st.live += t; paint(); };

async function askClaude(signal) {
  const messages = st.turns.map(t => t.role === 'user' ? { role: 'user', content: t.text }
    : { role: 'assistant', content: t.provider === 'claude' && t.blocks ? t.blocks : t.text });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': st.keys.claude, 'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 64000, stream: true, output_config: { effort: 'medium' }, fallbacks: 'default',
      system: [{ type: 'text', text: st.system, cache_control: { type: 'ephemeral' } }], messages })
  });
  if (!res.ok) throw await httpError(res);
  const blocks = []; let stop = null;
  for await (const ev of sse(res)) {
    if (ev.type === 'content_block_start') blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block));
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index], d = ev.delta; if (!b) continue;
      if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; onText(d.text); }
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    }
    else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason || stop;
    else if (ev.type === 'error') throw new Error(ev.error?.type === 'overloaded_error' ? STATUS[529] : 'Die Antwort wurde vom KI-Dienst abgebrochen. Versuch es noch einmal.');
  }
  if (stop === 'refusal') throw new Error('Diese Frage hat die KI nicht beantwortet. Formuliere sie anders.');
  const text = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('');
  // Antwortblöcke unverändert zurückgeben; nach einem Modellwechsel mitten in der Antwort nur den Text.
  const swapped = blocks.some(b => b && b.type === 'fallback');
  return { text, cut: stop === 'max_tokens', blocks: swapped ? blocks.filter(b => b && b.type === 'text') : blocks.filter(Boolean) };
}

async function askOpenAI(signal) {
  const messages = [{ role: 'system', content: st.system }, ...st.turns.map(t => ({ role: t.role, content: t.text }))];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.keys.openai },
    body: JSON.stringify({ model: st.openaiModel, stream: true, messages })
  });
  if (!res.ok) throw await httpError(res);
  let text = '', finish = null;
  for await (const ev of sse(res)) {
    if (ev.error) throw new Error('Die Antwort wurde vom KI-Dienst abgebrochen. Versuch es noch einmal.');
    const c = ev.choices?.[0]; if (!c) continue;
    const d = c.delta?.content; if (d) { text += d; onText(d); }
    if (c.finish_reason) finish = c.finish_reason;
  }
  if (finish === 'content_filter') throw new Error('Diese Frage hat die KI nicht beantwortet. Formuliere sie anders.');
  return { text, cut: finish === 'length' };
}

// Modelle des OpenAI-Kontos laden und die für einen Chat geeigneten anbieten (nichts für Bild, Ton, Suche usw.).
async function openaiModels(key) {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + key } });
  if (!res.ok) throw await httpError(res);
  const all = (await res.json()).data || [];
  return all.filter(m => /^(gpt-|chatgpt-|chat-latest|o\d)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|embedding|search|instruct|moderation|codex|computer|vision|-\d{4}-\d{2}-\d{2}$)/.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0)).map(m => m.id);
}
const pickModel = list => list.includes('chat-latest') ? 'chat-latest' : list[0] || null;

async function ask(question) {
  const q = question.trim(), provider = st.provider;
  if (st.busy || !q || !st.keys[provider] || (provider === 'openai' && !st.openaiModel)) return;
  if (!st.system) st.system = PROMPT + '\n\n# Daten\n\n' + buildContext(ctx.data(), ctx.today(), ctx.goals());
  st.turns.push({ role: 'user', text: q });
  st.view.push({ role: 'user', text: q });
  const gen = st.gen;
  st.busy = true; st.live = ''; st.abort = new AbortController();
  paint(true);
  let out = null, failed = '';
  try {
    out = provider === 'claude' ? await askClaude(st.abort.signal) : await askOpenAI(st.abort.signal);
    if (!out.text) failed = 'Es kam keine Antwort an. Versuch es noch einmal.';
  } catch (e) {
    failed = e.name === 'AbortError' ? 'Abgebrochen.' : e instanceof TypeError ? 'Keine Verbindung zum KI-Dienst. Prüfe deine Internetverbindung.' : e.message;
  }
  if (gen !== st.gen) return; // Gespräch wurde inzwischen zurückgesetzt
  const by = PROVIDERS[provider].label;
  if (failed) {
    // Die unbeantwortete Frage wird nicht mitgeschickt, damit der Verlauf gültig bleibt.
    st.turns.pop();
    if (st.live) st.view.push({ role: 'assistant', text: st.live, by });
    st.view.push({ role: 'error', text: failed });
  } else {
    st.turns.push({ role: 'assistant', text: out.text, provider, blocks: out.blocks });
    st.view.push({ role: 'assistant', text: out.text + (out.cut ? '\n\n(Antwort wurde wegen der Längenbegrenzung gekürzt.)' : ''), by });
  }
  st.busy = false; st.live = null; st.abort = null;
  paint(true);
}

/* ---------- Anzeige ---------- */
function md(src) {
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  let out = '', list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd(); let m;
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { close(); out += `<p><b>${inline(m[1])}</b></p>`; }
    else if (!line.trim()) close();
    else { close(); out += `<p>${inline(line)}</p>`; }
  }
  close();
  return out;
}
const EXAMPLES = ['Bin ich heute erholt genug für ein hartes Training?', 'Wie habe ich diese Woche geschlafen?', 'Fasse meine Trainingsbelastung des letzten Monats zusammen.', 'Wie hat sich meine HRV im Vergleich zum Schlaf entwickelt?', 'Was fällt dir an meinen Körperwerten der letzten Wochen auf?'];


function setupCard(p) {
  const P = PROVIDERS[p];
  return `<section class="card stack">
<h2>${P.label} einrichten</h2>
<p class="note">Dafür brauchst du einen eigenen API-Schlüssel von ${P.company} (${P.console}). Die Nutzung wird dort nach Verbrauch abgerechnet${p === 'openai' ? '; ein ChatGPT-Abo allein reicht dafür nicht' : ''}.</p>
<p class="note"><b>Wichtig:</b> Bei jeder Frage sendet die App deine Werte der letzten ${DAYS} Tage, Monatsmittel der gesamten Historie und deine Aktivitäten an ${P.company}. Ohne Schlüssel verlässt nichts dein Gerät.</p>
<form id="coachKeyForm" class="stack"><label class="sr" for="coachKey">API-Schlüssel</label><input class="field" id="coachKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${P.keyHint}" required><button class="primary" type="submit" id="coachKeySave">Schlüssel speichern</button><p class="msg" id="coachKeyMsg" role="status"></p></form>
<p class="note">Der Schlüssel wird nur auf diesem Gerät gespeichert und beim Abmelden gelöscht.</p></section>`;
}
function html() {
  let h = '<header class="head"><h1>Coach</h1><p class="muted">Fragen zu Training, Schlaf und Erholung, beantwortet aus deinen Werten.</p></header>';
  if (!st.loaded) return h;
  const p = st.provider;
  h += `<div class="seg" role="group" aria-label="KI wählen">${Object.entries(PROVIDERS).map(([k, P]) => `<button data-coach-provider="${k}" aria-pressed="${k === p}" ${st.busy ? 'disabled' : ''}>${P.label}</button>`).join('')}</div>`;
  if (!st.keys[p]) return h + setupCard(p);
  if (p === 'openai' && !st.openaiModel) return h + '<p class="note">Modelle werden geladen …</p>';
  h += '<section class="chat" id="coachLog" aria-live="polite">';
  if (!st.view.length && st.live === null) h += `<div class="chips">${EXAMPLES.map(q => `<button class="chip" data-coach-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  for (const m of st.view) h += m.role === 'user' ? `<div class="bubble me">${esc(m.text)}</div>` : m.role === 'error' ? `<div class="bubble err">${esc(m.text)}</div>` : `<div class="bubble ai"><span class="by">${esc(m.by)}</span>${md(m.text)}</div>`;
  if (st.live !== null) h += `<div class="bubble ai" id="coachLive">${st.live ? md(st.live) : '<span class="dots" aria-label="Der Coach denkt nach"><i></i><i></i><i></i></span>'}</div>`;
  h += '</section>';
  h += `<form id="coachForm" class="composer"><label class="sr" for="coachInput">Deine Frage</label><textarea id="coachInput" rows="1" placeholder="Frag ${PROVIDERS[p].label} …" ${st.busy ? 'disabled' : ''}></textarea>${st.busy ? '<button type="button" class="send stop" id="coachStop" aria-label="Antwort abbrechen"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>' : '<button type="submit" class="send" aria-label="Senden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.500 11.500 12 5l6.500 6.500"/></svg></button>'}</form>`;
  h += `<div class="coachFoot">${st.view.length && !st.busy ? '<button class="link" id="coachNew">Neues Gespräch</button>' : '<span></span>'}<button class="link" id="coachKeyEdit">Schlüssel ändern</button></div>`;
  if (p === 'openai') h += `<label class="modelPick" for="coachModel"><span>Modell</span><select id="coachModel" ${st.busy ? 'disabled' : ''}>${(st.openaiModels || [st.openaiModel]).map(m => `<option ${m === st.openaiModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>`;
  else h += `<p class="note">Modell: Claude Opus 5.5</p>`;
  h += `<p class="note">${ctx.demo() ? 'Beispielmodus: gesendet werden die erfundenen Beispieldaten. ' : ''}Antworten einer KI können Fehler enthalten und ersetzen keinen ärztlichen Rat.</p>`;
  return h;
}
let raf = 0;
function paint(full) {
  const root = $('#coachRoot'); if (!root) return;
  if (full) { cancelAnimationFrame(raf); raf = 0; root.innerHTML = html(); const live = $('#coachLive') || [...root.querySelectorAll('.bubble')].pop(); if (live) live.scrollIntoView({ block: 'end', behavior: 'smooth' }); return; }
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; const el = $('#coachLive'); if (!el || st.live === null) return;
    const near = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    el.innerHTML = md(st.live);
    if (near) window.scrollTo(0, document.documentElement.scrollHeight);
  });
}
// Liste der OpenAI-Modelle einmal je Sitzung nachladen (für die Auswahl); ein gespeichertes Modell bleibt gewählt.
async function ensureModels() {
  if (st.provider !== 'openai' || !st.keys.openai || st.openaiModels) return;
  try {
    st.openaiModels = await openaiModels(st.keys.openai);
    if (!st.openaiModel || !st.openaiModels.includes(st.openaiModel)) { st.openaiModel = pickModel(st.openaiModels); if (st.openaiModel) save('openaiModel', st.openaiModel); }
  } catch { if (!st.openaiModels && st.openaiModel) st.openaiModels = [st.openaiModel]; }
  paint(true);
}
async function mount() { await load(); paint(true); if (!st.view.length && st.live === null) window.scrollTo(0, 0); ensureModels(); }

document.addEventListener('submit', async ev => {
  if (ev.target.id === 'coachForm') { ev.preventDefault(); const q = $('#coachInput').value; if (q.trim()) ask(q); }
  else if (ev.target.id === 'coachKeyForm') {
    ev.preventDefault();
    const p = st.provider, v = $('#coachKey').value.trim(), msg = $('#coachKeyMsg'), btn = $('#coachKeySave');
    if (!PROVIDERS[p].keyTest.test(v)) { msg.textContent = PROVIDERS[p].keyMsg; return; }
    if (p === 'openai') {
      // Schlüssel gleich prüfen und dabei die verfügbaren Modelle holen.
      btn.disabled = true; msg.textContent = 'Schlüssel wird geprüft …';
      try {
        const list = await openaiModels(v);
        if (!list.length) throw new Error('Mit diesem Schlüssel ist kein Chat-Modell verfügbar.');
        st.openaiModels = list; st.openaiModel = st.openaiModel && list.includes(st.openaiModel) ? st.openaiModel : pickModel(list);
        save('openaiModel', st.openaiModel);
      } catch (e) { btn.disabled = false; msg.textContent = e instanceof TypeError ? 'Keine Verbindung zu OpenAI. Prüfe deine Internetverbindung.' : e.message === STATUS[401] ? 'OpenAI hat diesen Schlüssel abgelehnt. Prüfe, ob du ihn vollständig kopiert hast.' : e.message; return; }
    }
    try { await kv('put', KEYNAME[p], v); st.keys[p] = v; paint(true); } catch { msg.textContent = 'Der Schlüssel konnte auf diesem Gerät nicht gespeichert werden.'; btn.disabled = false; }
  }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'coachModel') { st.openaiModel = ev.target.value; save('openaiModel', st.openaiModel); }
});
document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-coach-q],[data-coach-provider],#coachNew,#coachStop,#coachKeyEdit'); if (!t) return;
  if (t.dataset.coachQ) ask(t.dataset.coachQ);
  else if (t.dataset.coachProvider && !st.busy) { st.provider = t.dataset.coachProvider; save('provider', st.provider); paint(true); ensureModels(); }
  else if (t.id === 'coachStop') st.abort?.abort();
  else if (t.id === 'coachNew') { reset(); paint(true); }
  else if (t.id === 'coachKeyEdit' && !st.busy) {
    const p = st.provider; try { await kv('delete', KEYNAME[p]); } catch {}
    st.keys[p] = null; if (p === 'openai') st.openaiModels = null; paint(true);
  }
});
document.addEventListener('keydown', ev => {
  if (ev.target.id === 'coachInput' && ev.key === 'Enter' && !ev.shiftKey && matchMedia('(pointer: fine)').matches) { ev.preventDefault(); $('#coachForm').requestSubmit(); }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'coachInput') { ev.target.style.height = 'auto'; ev.target.style.height = Math.min(ev.target.scrollHeight, 140) + 'px'; }
});

function reset() { st.gen++; st.abort?.abort(); st.turns = []; st.view = []; st.system = null; st.live = null; st.busy = false; }
async function forget() { reset(); st.keys = { claude: null, openai: null }; st.openaiModel = null; st.openaiModels = null; st.loaded = false; try { await kv('clear'); } catch {} }

return { init(c) { ctx = c; }, mount, reset, forget, view: () => '<div id="coachRoot" class="coach"></div>', _context: buildContext, _md: md };
})();
