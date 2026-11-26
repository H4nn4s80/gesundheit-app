'use strict';
/* Coach: KI-Chat über die eigenen Werte. Die Fragen gehen mit dem API-Schlüssel des Nutzers direkt an die
   Anthropic-API. Ohne Bibliothek (reines fetch), weil die App ohne Build-Schritt und mit strenger CSP läuft. */
window.GesundheitCoach = (() => {
const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5-5';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null; // von der App gesetzt: { data, today, goals, demo }
const st = { gen: 0, key: null, keyLoaded: false, msgs: [], view: [], system: null, busy: false, abort: null, live: null, note: '' };

/* ---------- Schlüssel: nur auf diesem Gerät ---------- */
function kv(action, value) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gesundheit-coach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('kv', action === 'get' ? 'readonly' : 'readwrite'), s = tx.objectStore('kv');
      const q = action === 'get' ? s.get('apiKey') : action === 'put' ? s.put(value, 'apiKey') : s.delete('apiKey');
      tx.oncomplete = () => { db.close(); resolve(q.result); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function loadKey() {
  if (st.keyLoaded) return;
  try { st.key = (await kv('get')) || null; } catch { st.key = null; }
  st.keyLoaded = true;
}

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

/* ---------- Anfrage ---------- */
const STATUS = {
  401: 'Der API-Schlüssel wurde abgelehnt. Prüfe ihn unter „Schlüssel ändern“.',
  403: 'Dieser API-Schlüssel darf das Modell nicht verwenden.',
  413: 'Die Anfrage ist zu groß. Starte ein neues Gespräch.',
  429: 'Zu viele Anfragen in kurzer Zeit oder das Limit deines Kontos ist erreicht. Versuch es gleich noch einmal.',
  529: 'Der KI-Dienst ist gerade überlastet. Versuch es in einer Minute noch einmal.'
};
async function ask(question) {
  if (st.busy || !st.key || !question.trim()) return;
  if (!st.system) st.system = PROMPT + '\n\n# Daten\n\n' + buildContext(ctx.data(), ctx.today(), ctx.goals());
  st.msgs.push({ role: 'user', content: question.trim() });
  st.view.push({ role: 'user', text: question.trim() });
  const gen = st.gen;
  st.busy = true; st.live = ''; st.note = ''; st.abort = new AbortController();
  paint(true);
  const blocks = []; let stop = null, failed = '';
  try {
    const res = await fetch(API, {
      method: 'POST', signal: st.abort.signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': st.key, 'anthropic-version': '2026-10-21',
        'anthropic-beta': 'server-side-fallback-2026-07-01', 'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 64000, stream: true, output_config: { effort: 'medium' }, fallbacks: 'default',
        system: [{ type: 'text', text: st.system, cache_control: { type: 'ephemeral' } }], messages: st.msgs
      })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      throw new Error(STATUS[res.status] || (res.status >= 500 ? 'Der KI-Dienst hat einen Fehler gemeldet. Versuch es gleich noch einmal.' : `Die Anfrage wurde abgelehnt${detail ? ': ' + detail : '.'}`));
    }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'content_block_start') blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block));
        else if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index], d = ev.delta; if (!b) continue;
          if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; st.live += d.text; paint(); }
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
          else if (d.type === 'signature_delta') b.signature = d.signature;
        }
        else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason || stop;
        else if (ev.type === 'error') throw new Error(ev.error?.type === 'overloaded_error' ? STATUS[529] : 'Die Antwort wurde vom KI-Dienst abgebrochen. Versuch es noch einmal.');
      }
    }
  } catch (e) {
    failed = e.name === 'AbortError' ? 'Abgebrochen.' : e instanceof TypeError ? 'Keine Verbindung zum KI-Dienst. Prüfe deine Internetverbindung.' : e.message;
  }
  if (gen !== st.gen) return; // Gespräch wurde inzwischen zurückgesetzt
  const text = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('');
  if (!failed && stop === 'refusal') failed = 'Diese Frage hat die KI nicht beantwortet. Formuliere sie anders.';
  if (!failed && !text) failed = 'Es kam keine Antwort an. Versuch es noch einmal.';
  if (failed) {
    // Verlauf bleibt unverändert gültig: die unbeantwortete Frage wird nicht mitgeschickt.
    st.msgs.pop();
    if (st.live) st.view.push({ role: 'assistant', text: st.live });
    st.view.push({ role: 'error', text: failed });
  } else {
    // Antwortblöcke unverändert zurückgeben; nach einem Modellwechsel mitten in der Antwort nur den Text.
    const swapped = blocks.some(b => b && b.type === 'fallback');
    st.msgs.push({ role: 'assistant', content: swapped ? blocks.filter(b => b && b.type === 'text') : blocks.filter(Boolean) });
    st.view.push({ role: 'assistant', text: text + (stop === 'max_tokens' ? '\n\n(Antwort wurde wegen der Längenbegrenzung gekürzt.)' : '') });
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

function html() {
  const head = '<header class="head"><h1>Coach</h1><p class="muted">Fragen zu Training, Schlaf und Erholung, beantwortet aus deinen Werten.</p></header>';
  if (!st.keyLoaded) return head;
  if (!st.key) return head + `<section class="card stack">
<h2>Einmal einrichten</h2>
<p class="note">Der Coach nutzt die KI Claude von Anthropic. Dafür brauchst du einen eigenen API-Schlüssel aus der Anthropic-Konsole (console.anthropic.com → API Keys). Die Nutzung wird dort nach Verbrauch abgerechnet.</p>
<p class="note"><b>Wichtig:</b> Bei jeder Frage sendet die App deine Werte der letzten ${DAYS} Tage, Monatsmittel der gesamten Historie und deine Aktivitäten an Anthropic. Ohne Schlüssel verlässt nichts dein Gerät.</p>
<form id="coachKeyForm" class="stack"><label class="sr" for="coachKey">API-Schlüssel</label><input class="field" id="coachKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" required><button class="primary" type="submit">Schlüssel speichern</button><p class="msg" id="coachKeyMsg" role="status"></p></form>
<p class="note">Der Schlüssel wird nur auf diesem Gerät gespeichert und beim Abmelden gelöscht.</p></section>`;
  let h = head + '<section class="chat" id="coachLog" aria-live="polite">';
  if (!st.view.length && st.live === null) h += `<div class="chips">${EXAMPLES.map(q => `<button class="chip" data-coach-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  for (const m of st.view) h += m.role === 'user' ? `<div class="bubble me">${esc(m.text)}</div>` : m.role === 'error' ? `<div class="bubble err">${esc(m.text)}</div>` : `<div class="bubble ai">${md(m.text)}</div>`;
  if (st.live !== null) h += `<div class="bubble ai" id="coachLive">${st.live ? md(st.live) : '<span class="dots" aria-label="Der Coach denkt nach"><i></i><i></i><i></i></span>'}</div>`;
  h += '</section>';
  h += `<form id="coachForm" class="composer"><label class="sr" for="coachInput">Deine Frage</label><textarea id="coachInput" rows="1" placeholder="Frag deinen Coach …" ${st.busy ? 'disabled' : ''}></textarea>${st.busy ? '<button type="button" class="send stop" id="coachStop" aria-label="Antwort abbrechen"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>' : '<button type="submit" class="send" aria-label="Senden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.500 11.500 12 5l6.500 6.500"/></svg></button>'}</form>`;
  h += `<div class="coachFoot">${st.view.length && !st.busy ? '<button class="link" id="coachNew">Neues Gespräch</button>' : '<span></span>'}<button class="link" id="coachKeyEdit">Schlüssel ändern</button></div>`;
  h += `<p class="note">${ctx.demo() ? 'Beispielmodus: gesendet werden die erfundenen Beispieldaten. ' : ''}Antworten einer KI können Fehler enthalten und ersetzen keinen ärztlichen Rat.</p>`;
  return h;
}
let raf = 0;
function paint(full) {
  const root = $('#coachRoot'); if (!root) return;
  if (full) { cancelAnimationFrame(raf); raf = 0; root.innerHTML = html(); const live = $('#coachLive') || root.querySelector('.bubble:last-of-type'); if (st.view.length || st.live !== null) (live || root).scrollIntoView({ block: 'end', behavior: 'smooth' }); return; }
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; const el = $('#coachLive'); if (!el || st.live === null) return;
    const near = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    el.innerHTML = md(st.live);
    if (near) window.scrollTo(0, document.documentElement.scrollHeight);
  });
}
async function mount() { await loadKey(); paint(true); if (!st.view.length && st.live === null) window.scrollTo(0, 0); }

document.addEventListener('submit', async ev => {
  if (ev.target.id === 'coachForm') { ev.preventDefault(); const q = $('#coachInput').value; if (q.trim()) ask(q); }
  else if (ev.target.id === 'coachKeyForm') {
    ev.preventDefault(); const v = $('#coachKey').value.trim(), msg = $('#coachKeyMsg');
    if (!/^sk-ant-[\w-]{20,}$/.test(v)) { msg.textContent = 'Das sieht nicht nach einem Anthropic-Schlüssel aus. Er beginnt mit „sk-ant-“.'; return; }
    try { await kv('put', v); st.key = v; paint(true); } catch { msg.textContent = 'Der Schlüssel konnte auf diesem Gerät nicht gespeichert werden.'; }
  }
});
document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-coach-q],#coachNew,#coachStop,#coachKeyEdit'); if (!t) return;
  if (t.dataset.coachQ) ask(t.dataset.coachQ);
  else if (t.id === 'coachStop') st.abort?.abort();
  else if (t.id === 'coachNew') { reset(); paint(true); }
  else if (t.id === 'coachKeyEdit' && !st.busy) { try { await kv('delete'); } catch {} st.key = null; reset(); paint(true); }
});
document.addEventListener('keydown', ev => {
  if (ev.target.id === 'coachInput' && ev.key === 'Enter' && !ev.shiftKey && matchMedia('(pointer: fine)').matches) { ev.preventDefault(); $('#coachForm').requestSubmit(); }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'coachInput') { ev.target.style.height = 'auto'; ev.target.style.height = Math.min(ev.target.scrollHeight, 140) + 'px'; }
});

function reset() { st.gen++; st.abort?.abort(); st.msgs = []; st.view = []; st.system = null; st.live = null; st.busy = false; }
async function forget() { reset(); st.key = null; try { await kv('delete'); } catch {} }

return { init(c) { ctx = c; }, mount, reset, forget, view: () => '<div id="coachRoot" class="coach"></div>', _context: buildContext, _md: md };
})();
