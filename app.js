'use strict';
(() => {
const APP_VERSION = '3.0';
// Im Test-Repo direkt das laufend aktualisierte Datenpaket der bisherigen App lesen
const DATA_URL = location.pathname.startsWith('/gesundheit-neu/') ? '/gesundheit-app/data.enc.json' : 'data.enc.json';
const PREVIEW = !!window.GESUNDHEIT_PREVIEW;

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('gn-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gn-' + k, JSON.stringify(v)); } catch {} }
};

/* ---------- Datum & Zahlen ---------- */
const D = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
const dayDiff = (a, b) => Math.round((D(a) - D(b)) / 864e5);
const fmtDate = (s, o) => D(s).toLocaleDateString('de-DE', o);
const rel = s => { const n = dayDiff(TODAY, s); return n <= 0 ? 'heute' : n === 1 ? 'gestern' : n < 7 ? `vor ${n} Tagen` : fmtDate(s, { day: 'numeric', month: 'short' }); };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

const DIGITS = { 'Schritte': 0, 'bpm': 0, 'Punkte': 0, 'ms': 0, 'Etagen': 0, 'Jahre': 0, 'min': 0, 'kcal': 0, 'Atemzüge/min': 0, 'kg': 1, 'km': 1, '%': 1, 'Index': 1, 'ml/kg/min': 1, 'm/s': 2, 'Verhältnis': 2 };
const nf = (v, min, max) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max }).format(v).replace('-', '−');
function parts(v, unit) {
  if (!Number.isFinite(v)) return { v: '–', u: '' };
  if (unit === 'h') {
    const t = Math.round(Math.abs(v) * 60);
    return t < 60 ? { v: String(t), u: 'min' } : { v: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, u: 'h' };
  }
  const p = DIGITS[unit];
  return { v: nf(v, p ?? 0, p ?? 2), u: unit || '' };
}
const fmt = (v, u) => { const p = parts(v, u); return p.u ? `${p.v} ${p.u}` : p.v; };
const valHTML = (v, u) => { const p = parts(v, u); return `<b>${p.v}${p.u ? `<small>${esc(p.u)}</small>` : ''}</b>`; };
const dur = min => { const t = Math.round(min || 0); return t < 60 ? `${t} min` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} h`; };

/* ---------- Datenmodell ---------- */
let DATA = null, TODAY = null, IS_DEMO = false, sessionKey = null;
const CAT = { 'Körpermaße': 'teal', 'Aktivität': 'orange', 'Schlaf': 'indigo', 'Herz': 'red' };
const HUE = { steps: 'green', distance: 'cyan', intensity: 'orange', energy: 'pink', vo2run: 'cyan', vo2row: 'blue', load: 'amber', chronic: 'orange', acwr: 'violet', sleep: 'indigo', score: 'violet', rest: 'red', hrv: 'blue', stress: 'amber', bbhigh: 'green', bblow: 'teal', bbcharged: 'green', ready: 'teal', weight: 'teal', fat: 'amber', muscle: 'blue', pwv: 'pink' };
const cc = m => 'c-' + (HUE[m?.id] || CAT[m?.category] || 'blue');
// +1: höher ist besser, -1: niedriger ist besser
const GOOD = { hrv: 1, rest: -1, sleep: 1, score: 1, stress: -1, vo2run: 1, vo2row: 1, steps: 1, bbhigh: 1, bbcharged: 1, ready: 1 };
const M = id => DATA.metrics.find(m => m.id === id);
const idx = m => DATA.metrics.indexOf(m);
const last = m => m?.points.at(-1);
const pts = (m, from, to) => m.points.filter(p => p.date >= from && p.date <= to);
// Intensität wird als Wochenziel geführt (Empfehlung: 150 min); in Tagesgrafiken gilt ein Siebtel davon.
const GOAL_DEFAULT = { steps: 8000, sleep: 7.5, intensityWeek: 150 };
const goalFor = id => id === 'intensity' ? store.get('goal-intensityWeek', GOAL_DEFAULT.intensityWeek) / 7 : id in GOAL_DEFAULT ? store.get('goal-' + id, GOAL_DEFAULT[id]) : null;

function prepare(d) {
  d.metrics = d.metrics.filter(m => m && Array.isArray(m.points));
  for (const m of d.metrics) m.points = m.points.filter(p => p && typeof p.date === 'string' && Number.isFinite(p.value)).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  // Leere Einträge (0 Minuten, keine Distanz) ausblenden, z. B. in Connect gelöschte Aktivitäten
  d.activities = (d.activities || []).filter(a => a && typeof a.date === 'string' && (a.durationMinutes > 0 || a.distanceKm > 0)).sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  let max = '';
  for (const m of d.metrics) { const p = m.points.at(-1); if (p && p.date > max) max = p.date; }
  TODAY = (max || iso(new Date())).slice(0, 10);
  return d;
}
// Letzter Wert gegen den Schnitt der 28 Tage davor
function versus(m) {
  const p = last(m); if (!p) return null;
  const base = mean(pts(m, shift(p.date, -28), shift(p.date, -1)).map(x => x.value));
  if (base == null || !base) return null;
  return { base, pct: (p.value - base) / Math.abs(base) * 100 };
}
function deltaHTML(m) {
  const v = versus(m); if (!v) return '';
  if (Math.abs(v.pct) < 2) return '<span class="delta">im Schnitt</span>';
  const dir = GOOD[m.id], cls = dir ? ((v.pct > 0) === (dir > 0) ? 'good' : 'bad') : '';
  return `<span class="delta ${cls}">${v.pct > 0 ? '▲' : '▼'} ${nf(Math.abs(v.pct), 0, 0)} %</span>`;
}

/* ---------- Grafik ---------- */
function spark(points, w = 72, h = 28) {
  if (points.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const vals = points.map(p => p.value), lo = Math.min(...vals), hi = Math.max(...vals), a = points[0].date, span = dayDiff(points.at(-1).date, a) || 1;
  const X = p => 3 + dayDiff(p.date, a) / span * (w - 8), Y = v => h - 4 - (v - lo) / ((hi - lo) || 1) * (h - 8);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  const e = points.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/><circle cx="${X(e).toFixed(1)}" cy="${Y(e.value).toFixed(1)}" r="2.6"/></svg>`;
}
function weekly(points) {
  const map = new Map();
  for (const p of points) { const d = D(p.date), k = shift(p.date, -((d.getDay() + 6) % 7)); (map.get(k) || map.set(k, []).get(k)).push(p.value); }
  return [...map].map(([k, v]) => ({ date: shift(k, 3), week: k, value: mean(v) }));
}
function movingAvg(points, n = 7) {
  return points.map(p => ({ date: p.date, value: mean(points.filter(q => q.date <= p.date && q.date > shift(p.date, -n)).map(q => q.value)) }));
}
let scrub = null;
function chart(m, from, to, opt = {}) {
  let P = pts(m, from, to); const days = dayDiff(to, from) + 1, bar = m.chart === 'bar';
  const wk = days > 100 && P.length > 60; if (wk) P = weekly(P).filter(p => p.date >= from && p.date <= to);
  scrub = null;
  if (!P.length) return { html: '<p class="empty">Keine Werte in diesem Zeitraum.</p>', P, wk };
  const W = 340, H = 200, L = 6, R = 48, T = 12, B = 24, pw = W - L - R, ph = H - T - B;
  const vals = P.map(p => p.value), goal = opt.goal ?? null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (goal != null) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
  const sp = (hi - lo) || Math.abs(hi) * .1 || 1;
  if (bar) lo = Math.min(0, lo); else lo -= sp * .15;
  hi += sp * .15;
  const span = Math.max(1, days - 1);
  const X = p => L + (bar ? (dayDiff(p.date, from) + .5) / days : dayDiff(p.date, from) / span) * pw;
  const Y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
  let s = '<defs><linearGradient id="chartArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c);stop-opacity:.38"/><stop offset="1" style="stop-color:var(--c);stop-opacity:0"/></linearGradient><linearGradient id="chartBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c2)"/><stop offset="1" style="stop-color:var(--c)"/></linearGradient></defs>';
  for (const t of [0, .5, 1]) {
    const v = hi - t * (hi - lo), y = T + t * ph;
    s += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${y}" y2="${y}"/><text x="${L + pw + 6}" y="${y + 4}">${parts(v, m.unit).v}</text>`;
  }
  if (goal != null) s += `<line class="goalLine" x1="${L}" x2="${L + pw}" y1="${Y(goal)}" y2="${Y(goal)}"/>`;
  if (bar) {
    const slots = wk ? days / 7 : days, bw = Math.max(2, Math.min(20, pw / slots * .68));
    s += '<g class="bars" style="fill:url(#chartBar)">' + P.map(p => `<rect x="${(X(p) - bw / 2).toFixed(1)}" y="${Y(p.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, T + ph - Y(p.value)).toFixed(1)}" rx="${Math.min(3, bw / 2)}"/>`).join('') + '</g>';
  } else {
    const d = P.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
    if (P.length > 1) s += `<path class="area" style="fill:url(#chartArea)" d="${d}L${X(P.at(-1)).toFixed(1)} ${T + ph}L${X(P[0]).toFixed(1)} ${T + ph}Z"/><path class="ln" d="${d}"/>`;
    if (opt.avg && P.length > 6) { const A = movingAvg(P); s += `<path class="avg" d="${A.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('')}"/>`; }
    const e = P.at(-1); s += `<circle class="end" cx="${X(e).toFixed(1)}" cy="${Y(e.value).toFixed(1)}" r="4.5"/>`;
  }
  const o = { day: 'numeric', month: 'short' };
  s += `<text x="${L}" y="${H - 5}">${fmtDate(from, o)}</text><text x="${L + pw}" y="${H - 5}" text-anchor="end">${fmtDate(to, o)}</text>`;
  s += `<g id="scrubG" visibility="hidden"><line class="scrubLine" id="scrubLine" y1="${T}" y2="${T + ph}"/><circle class="scrubDot" id="scrubDot" r="5"/></g>`;
  scrub = { W, pts: P.map(p => ({ x: X(p), y: Y(p.value), p })), wk };
  return { html: `<svg class="chart" id="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf ${esc(m.name)}">${s}</svg>`, P, wk };
}
function bindScrub(m, onPick, onReset) {
  const svg = $('#chart'); if (!svg || !scrub) return;
  const move = ev => {
    const r = svg.getBoundingClientRect(), vx = (ev.clientX - r.left) / r.width * scrub.W;
    let best = scrub.pts[0]; for (const q of scrub.pts) if (Math.abs(q.x - vx) < Math.abs(best.x - vx)) best = q;
    $('#scrubG').setAttribute('visibility', 'visible');
    const l = $('#scrubLine'); l.setAttribute('x1', best.x); l.setAttribute('x2', best.x);
    const c = $('#scrubDot'); c.setAttribute('cx', best.x); c.setAttribute('cy', best.y);
    onPick(best.p, scrub.wk);
  };
  const end = () => { $('#scrubG')?.setAttribute('visibility', 'hidden'); onReset(); };
  svg.addEventListener('pointerdown', move); svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', end); svg.addEventListener('pointerleave', end); svg.addEventListener('pointercancel', end);
}
function ring(cls, label, pct, value, sub, go) {
  const r = 34, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct || 0));
  return `<button class="ring ${cls}" data-go="${go}"><svg viewBox="0 0 84 84" aria-hidden="true"><circle class="track" cx="42" cy="42" r="${r}"/><defs><linearGradient id="rg-${go}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--c2)"/><stop offset="1" style="stop-color:var(--c)"/></linearGradient></defs><circle class="prog" style="stroke:url(#rg-${go})" cx="42" cy="42" r="${r}" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}"/><text x="42" y="48" text-anchor="middle">${Math.round((pct || 0) * 100)}%</text></svg><span class="lbl">${esc(label)}</span><span class="val">${value}</span><span class="sub">${esc(sub)}</span></button>`;
}
const EXT = '<svg class="chev ext" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2H2v10h10V9M8 2h4v4M12 2L6.500 7.500"/></svg>';
// Externer Dienst mit eigenem Login; die App gibt dorthin keine Daten und kein Passwort weiter.
const garmlinkRow = () => `<a class="row c-violet" href="https://garmlink.ai/dashboard" target="_blank" rel="noopener noreferrer"><span class="glyph"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8.500 9.500h7M8.500 12.500h4"/></svg></span><span class="main"><span class="name">GarmLink</span><span class="meta">KI-Chat und Dashboard, öffnet mit deinem Login dort</span></span>${EXT}</a>`;
const CHEV = '<svg class="chev" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>';
function metricRow(m, days = 30) {
  const p = last(m);
  return `<button class="row ${cc(m)}" data-go="m-${idx(m)}"><span class="main"><span class="name">${esc(m.name)}</span><span class="meta">${p ? rel(p.date) : 'Keine Daten'}</span></span>${p ? spark(pts(m, shift(p.date, -days), p.date)) : ''}<span class="value">${p ? valHTML(p.value, m.unit) : '<b>–</b>'}${deltaHTML(m)}</span>${CHEV}</button>`;
}

/* ---------- Ansicht: Heute ---------- */
function viewHeute() {
  let h = `<header class="head"><p class="eyebrow">${fmtDate(TODAY, { weekday: 'long', day: 'numeric', month: 'long' })}</p><h1>Heute</h1></header>`;
  const steps = M('steps'), sleep = M('sleep'), inten = M('intensity');
  const rings = [[steps, 'Schritte', 'steps'], [sleep, 'Schlaf', 'sleep'], [inten, 'Intensität', 'intensity']].filter(x => x[0] && last(x[0]));
  if (rings.length) {
    h += `<section class="card rings" style="grid-template-columns:repeat(${rings.length},1fr)">` + rings.map(([m, label, id]) => {
      const p = last(m), g = goalFor(id);
      if (id === 'intensity') {
        const sum = pts(m, shift(p.date, -6), p.date).reduce((a, x) => a + x.value, 0), wg = store.get('goal-intensityWeek', GOAL_DEFAULT.intensityWeek);
        return ring(cc(m), label, sum / wg, fmt(sum, 'min'), 'letzte 7 Tage', 'm-' + idx(m));
      }
      return ring(cc(m), label, p.value / g, fmt(p.value, m.unit === 'Schritte' ? '' : m.unit), rel(p.date), 'm-' + idx(m));
    }).join('') + '</section>';
  }
  const rec = ['hrv', 'rest', 'score', 'stress', 'bbhigh', 'ready'].map(M).filter(m => m && last(m)).slice(0, 4);
  if (rec.length) h += `<section class="sec"><div class="secHead"><h2>Erholung</h2><small>gegenüber deinen letzten 4 Wochen</small></div><div class="list">${rec.map(m => metricRow(m, 14)).join('')}</div></section>`;
  if (steps && last(steps)) {
    const g = goalFor('steps'), days = [...Array(7)].map((_, i) => shift(TODAY, i - 6)), byDay = new Map(steps.points.map(p => [p.date, p.value]));
    const vals = days.map(d => byDay.get(d)), have = vals.filter(Number.isFinite), top = Math.max(g, ...have, 1) * 1.08, hits = have.filter(v => v >= g).length;
    h += `<section class="sec ${cc(steps)}"><div class="secHead"><h2>Diese Woche</h2><small>Ziel an ${hits} von ${have.length} Tagen</small></div><button class="card tile" data-go="m-${idx(steps)}"><div class="big"><b>${nf(mean(have) || 0, 0, 0)}</b><span>Schritte im Schnitt</span></div><div class="week">${days.map((d, i) => { const v = vals[i]; return `<div class="col${d === TODAY ? ' today' : ''}"><div class="bar${Number.isFinite(v) ? (v >= g ? ' hit' : '') : ' none'}" style="height:${Number.isFinite(v) ? Math.max(3, v / top * 86) : 3}px"></div><span class="d">${fmtDate(d, { weekday: 'narrow' })}</span></div>`; }).join('')}<div class="goal" style="bottom:${(24 + g / top * 86).toFixed(0)}px"></div></div></button></section>`;
  }
  const a = DATA.activities[0];
  if (a) h += `<section class="sec"><div class="secHead"><h2>Letztes Training</h2></div><div class="list">${actRow(a, 0)}</div></section>`;
  if (!rings.length && !rec.length) h += `<section class="sec"><div class="list">${DATA.metrics.slice(0, 8).map(m => metricRow(m)).join('')}</div></section>`;
  return h;
}

/* ---------- Ansicht: Trends & Kennzahl ---------- */
function viewTrends() {
  let h = '<header class="head"><h1>Trends</h1><p class="muted">Jede Kennzahl mit dem Verlauf der letzten 30 Tage.</p></header>';
  const cats = [...new Set(DATA.metrics.map(m => m.category || 'Weitere'))];
  for (const c of cats) h += `<section class="sec"><div class="secHead"><h2>${esc(c)}</h2></div><div class="list">${DATA.metrics.filter(m => (m.category || 'Weitere') === c).map(m => metricRow(m)).join('')}</div></section>`;
  return h;
}
const RANGES = [['7 T', 7], ['30 T', 30], ['90 T', 90], ['1 J', 365], ['Alles', 0]];
let range = 30;
function viewMetric(m) {
  const p = last(m), end = p ? p.date : TODAY, first = m.points[0]?.date || end;
  const from = range ? shift(end, -(range - 1)) : first, g = goalFor(m.id);
  const c = chart(m, from, end, { goal: g, avg: m.id === 'weight' });
  const vals = c.P.map(x => x.value), prevFrom = shift(from, -(dayDiff(end, from) + 1));
  const prev = range ? mean(pts(m, prevFrom, shift(from, -1)).map(x => x.value)) : null, avg = mean(vals);
  const ch = prev && avg != null ? (avg - prev) / Math.abs(prev) * 100 : null;
  const stat = (l, v) => `<div class="stat"><span>${l}</span>${v}</div>`;
  const src = [...new Set(m.points.map(x => x.source).filter(Boolean))].join(' · ');
  return `<button class="back" data-back><svg viewBox="0 0 10 16" aria-hidden="true"><path d="M8 1L2 8l6 7"/></svg>Zurück</button>
<header class="head ${cc(m)}"><p class="eyebrow tint">${esc(m.category || '')}</p><h1>${esc(m.name)}</h1></header>
<section class="card sec ${cc(m)}"><div><div class="big" id="selVal">${p ? bigHTML(p.value, m.unit) : '<b>–</b>'}</div><p class="muted" id="selDate" style="font-size:14px">${p ? selLabel(p.date) : 'Keine Daten'}</p></div>${c.html}<div class="seg" role="group" aria-label="Zeitraum">${RANGES.map(([l, n]) => `<button data-range="${n}" aria-pressed="${n === range}">${l}</button>`).join('')}</div>${c.wk ? '<p class="note">Bei langen Zeiträumen zeigt die Grafik Wochenmittel.</p>' : ''}</section>
<section class="card stats">${stat('Durchschnitt', valHTML(avg, m.unit))}${stat('Veränderung', ch == null ? '<b>–</b>' : `<b>${ch > 0 ? '+' : '−'}${nf(Math.abs(ch), 0, 1)}<small>% zum Zeitraum davor</small></b>`)}${stat('Niedrigster', valHTML(vals.length ? Math.min(...vals) : NaN, m.unit))}${stat('Höchster', valHTML(vals.length ? Math.max(...vals) : NaN, m.unit))}${g != null ? stat('Dein Ziel', valHTML(g, m.unit)) : ''}${stat('Messwerte', `<b>${nf(pts(m, from, end).length, 0, 0)}</b>`)}</section>
${src ? `<p class="note">Quelle: ${esc(src)}</p>` : ''}`;
}
const bigHTML = (v, u) => { const p = parts(v, u); return `<b>${p.v}</b><span>${esc(p.u)}</span>`; };
const selLabel = (d, wk) => wk ? `Wochenmittel um den ${fmtDate(d, { day: 'numeric', month: 'long', year: 'numeric' })}` : `${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}`;

/* ---------- Ansicht: Aktivitäten ---------- */
const GLYPH = {
  run: '<path d="M3 13h4l2-6 4 12 2-6h6"/>',
  bike: '<circle cx="6" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="M6 16l4-8h5l3 8M10 8H8"/>',
  hike: '<path d="M2 20l7-12 4 6 3-4 6 10z"/>',
  gym: '<path d="M8 12h8M5 8v8M19 8v8M2.500 10v4M21.500 10v4"/>',
  water: '<path d="M2 9c2.500-2 4.500 2 7 0s4.500 2 7 0 4 1 6 0M2 15c2.500-2 4.500 2 7 0s4.500 2 7 0 4 1 6 0"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'
};
function glyph(a) {
  const k = String(a.sportKey || a.sport || '').toLowerCase();
  const g = /run|lauf/.test(k) ? 'run' : /cycl|bik|rad/.test(k) ? 'bike' : /hik|walk|wander|geh|ski|mountain/.test(k) ? 'hike' : /strength|kraft|gym|training/.test(k) ? 'gym' : /row|swim|ruder|schwimm|paddl|kayak/.test(k) ? 'water' : 'other';
  const hue = { run: 'orange', bike: 'green', hike: 'teal', gym: 'violet', water: 'blue', other: 'pink' }[g];
  return `<span class="glyph c-${hue}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[g]}</svg></span>`;
}
function actRow(a, i) {
  const chips = [dur(a.durationMinutes)];
  if (a.distanceKm >= .05) chips.push(`${nf(a.distanceKm, 1, a.distanceKm < 10 ? 2 : 1)} km`);
  if (a.pulse > 0) chips.push(`Ø ${Math.round(a.pulse)} bpm`);
  return `<button class="row" data-go="a-${i}">${glyph(a)}<span class="main"><span class="name">${esc(a.sport || a.name || 'Aktivität')}</span><span class="chips">${chips.map(c => `<span>${c}</span>`).join('')}</span></span><span class="meta">${fmtDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>${CHEV}</button>`;
}
let actShown = 40;
function viewActs() {
  const acts = DATA.activities;
  let h = '<header class="head"><h1>Aktivitäten</h1></header>';
  if (!acts.length) return h + '<p class="empty">Noch keine Aktivitäten vorhanden.</p>';
  const from = shift(TODAY, -27), recent = acts.filter(a => a.date >= from);
  h += `<section class="card stats">${`<div class="stat"><span>Einheiten in 4 Wochen</span><b>${recent.length}</b></div><div class="stat"><span>Trainingszeit</span><b>${dur(recent.reduce((s, a) => s + (a.durationMinutes || 0), 0))}</b></div>`}</section>`;
  let month = null;
  acts.slice(0, actShown).forEach((a, i) => {
    const k = a.date.slice(0, 7);
    if (k !== month) {
      if (month) h += '</div></section>';
      month = k; const ms = acts.filter(x => x.date.startsWith(k));
      h += `<section class="sec"><div class="secHead"><h2>${fmtDate(k + '-15', { month: 'long', year: 'numeric' })}</h2><small>${ms.length} ${ms.length === 1 ? 'Einheit' : 'Einheiten'} · ${dur(ms.reduce((s, x) => s + (x.durationMinutes || 0), 0))}</small></div><div class="list">`;
    }
    h += actRow(a, i);
  });
  h += '</div></section>';
  if (acts.length > actShown) h += `<button class="btn" data-more>Ältere Aktivitäten anzeigen</button>`;
  return h;
}
const ACT_FIELDS = [
  ['durationMinutes', 'Dauer', v => dur(v)], ['movingMinutes', 'In Bewegung', v => dur(v)], ['distanceKm', 'Distanz', v => nf(v, 1, 2) + ' km'],
  ['avgSpeedKmh', 'Ø Geschwindigkeit', v => nf(v, 1, 1) + ' km/h'], ['maxSpeedKmh', 'Höchstgeschwindigkeit', v => nf(v, 1, 1) + ' km/h'],
  ['pulse', 'Ø Puls', v => Math.round(v) + ' bpm'], ['maxPulse', 'Höchster Puls', v => Math.round(v) + ' bpm'], ['calories', 'Kalorien', v => nf(v, 0, 0) + ' kcal'],
  ['elevationGain', 'Anstieg', v => nf(v, 0, 0) + ' m'], ['elevationLoss', 'Abstieg', v => nf(v, 0, 0) + ' m'], ['steps', 'Schritte', v => nf(v, 0, 0)],
  ['avgPower', 'Ø Leistung', v => nf(v, 0, 0) + ' W'], ['normPower', 'Normalisierte Leistung', v => nf(v, 0, 0) + ' W'], ['maxPower', 'Höchstleistung', v => nf(v, 0, 0) + ' W'],
  ['trainingLoad', 'Trainingsbelastung', v => nf(v, 0, 0)], ['aerobicTE', 'Aerober Effekt', v => nf(v, 1, 1)], ['anaerobicTE', 'Anaerober Effekt', v => nf(v, 1, 1)],
  ['moderateMinutes', 'Moderate Minuten', v => nf(v, 0, 0) + ' min'], ['vigorousMinutes', 'Intensive Minuten', v => nf(v, 0, 0) + ' min']
];
function viewAct(a) {
  let stats = '';
  if (/run|lauf/i.test(String(a.sportKey || a.sport)) && a.distanceKm > .2 && a.durationMinutes > 0) {
    const pace = (a.movingMinutes || a.durationMinutes) / a.distanceKm, s = Math.round(pace * 60);
    stats += `<div class="stat"><span>Ø Pace</span><b>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}<small>min/km</small></b></div>`;
  }
  for (const [k, l, f] of ACT_FIELDS) if (Number.isFinite(a[k]) && a[k] > 0) stats += `<div class="stat"><span>${l}</span><b>${f(a[k])}</b></div>`;
  return `<button class="back" data-back><svg viewBox="0 0 10 16" aria-hidden="true"><path d="M8 1L2 8l6 7"/></svg>Zurück</button>
<header class="head"><p class="eyebrow">${fmtDate(a.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${typeof a.time === 'string' ? ' · ' + esc(a.time.slice(0, 5)) : ''}</p><h1>${esc(a.sport || a.name || 'Aktivität')}</h1>${a.name && a.name !== a.sport ? `<p class="muted">${esc(a.name)}</p>` : ''}</header>
<section class="card stats">${stats || '<p class="empty">Keine Details vorhanden.</p>'}</section>${typeof a.teLabel === 'string' ? `<p class="note">Trainingseffekt: ${esc(a.teLabel)}</p>` : ''}`;
}

/* ---------- Ansicht: Körper ---------- */
function viewBody() {
  let h = '<header class="head"><h1>Körper</h1></header>';
  const body = DATA.metrics.filter(m => m.category === 'Körpermaße' && last(m)), w = M('weight') && last(M('weight')) ? M('weight') : body[0];
  if (!w) return h + '<p class="empty">Noch keine Körperwerte vorhanden.</p>';
  const p = last(w), from = shift(p.date, -89), c = chart(w, from, p.date, { avg: true });
  const now = mean(pts(w, shift(p.date, -6), p.date).map(x => x.value));
  const ago = n => { const v = mean(pts(w, shift(p.date, -n - 6), shift(p.date, -n)).map(x => x.value)); return v == null ? '<b>–</b>' : `<b>${now - v > 0 ? '+' : '−'}${nf(Math.abs(now - v), 1, 1)}<small>${esc(w.unit)}</small></b>`; };
  h += `<section class="card sec ${cc(w)}"><div><p class="eyebrow tint">${esc(w.name)}</p><div class="big" id="selVal">${bigHTML(p.value, w.unit)}</div><p class="muted" id="selDate" style="font-size:14px">${selLabel(p.date)}</p></div>${c.html}<p class="note">Gepunktete Linie: Mittel über 7 Tage. Letzte 90 Tage.</p><div class="stats"><div class="stat"><span>In 30 Tagen</span>${ago(30)}</div><div class="stat"><span>In 90 Tagen</span>${ago(90)}</div></div></section>`;
  const rest = body.filter(m => m !== w);
  h += `<section class="sec"><div class="secHead"><h2>Zusammensetzung</h2></div><div class="list">${[w, ...rest].map(m => metricRow(m, 90)).join('')}</div></section>`;
  return h;
}

/* ---------- Ansicht: Mehr ---------- */
function viewMehr() {
  const built = DATA.built ? new Date(DATA.built) : null;
  const g = id => store.get('goal-' + id, GOAL_DEFAULT[id]);
  return `<header class="head"><h1>Mehr</h1></header>
<section class="sec"><div class="secHead"><h2>Tagesziele</h2></div><form class="card form" id="goalForm">
<label for="goal-steps">Schritte pro Tag<input id="goal-steps" type="number" inputmode="numeric" min="1000" max="60000" step="500" value="${g('steps')}"></label>
<label for="goal-sleep">Schlaf in Stunden<input id="goal-sleep" type="number" inputmode="decimal" min="4" max="12" step="0.25" value="${g('sleep')}"></label>
<label for="goal-intensityWeek">Intensitätsminuten pro Woche<input id="goal-intensityWeek" type="number" inputmode="numeric" min="30" max="1500" step="10" value="${g('intensityWeek')}"></label>
</form></section>
<section class="sec"><div class="secHead"><h2>Verknüpfungen</h2></div><div class="list">${garmlinkRow()}</div></section>
<section class="sec"><div class="secHead"><h2>Daten</h2></div><div class="card stack">
<p>${IS_DEMO ? 'Du siehst erfundene Beispieldaten.' : `Stand ${built && !isNaN(built) ? built.toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' }) : fmtDate(TODAY, { dateStyle: 'long' })}`}</p>
<p class="note">${nf(DATA.metrics.length, 0, 0)} Kennzahlen, ${nf(DATA.activities.length, 0, 0)} Aktivitäten.</p>
${(DATA.notes || []).length ? `<details class="notes"><summary>Hinweise zu den Daten</summary><p class="note">${esc(DATA.notes.join(' '))}</p></details>` : ''}
${IS_DEMO ? '' : '<button class="btn" id="refreshBtn">Neue Daten laden</button>'}<p class="note" id="refreshMsg" role="status"></p></div></section>
<section class="sec"><div class="secHead"><h2>Zugang</h2></div><div class="card stack">
<p class="note">${IS_DEMO ? 'Im Beispielmodus wird nichts gespeichert oder geladen.' : 'Die Werte werden nur auf diesem Gerät entschlüsselt. Beim Abmelden wird der gespeicherte Schlüssel gelöscht.'}</p>
<button class="btn danger" id="logoutBtn">${IS_DEMO ? 'Beispielmodus beenden' : 'Abmelden und sperren'}</button></div></section>
<p class="note">Gesundheit ${APP_VERSION}</p>`;
}

/* ---------- Navigation ---------- */
const Coach = window.GesundheitCoach;
Coach.init({ data: () => DATA, today: () => TODAY, demo: () => IS_DEMO, goals: () => ({ steps: goalFor('steps'), sleep: goalFor('sleep'), intensityWeek: store.get('goal-intensityWeek', GOAL_DEFAULT.intensityWeek) }) });
const TABS = { heute: viewHeute, trends: viewTrends, aktivitaeten: viewActs, koerper: viewBody, coach: Coach.view, mehr: viewMehr };
let tab = 'heute'; const scrollPos = {};
function route() {
  if (!DATA) return;
  const h = location.hash.slice(1) || 'heute', view = $('#view');
  let html, isDetail = false;
  const mm = /^m-(\d+)$/.exec(h), am = /^a-(\d+)$/.exec(h);
  if (mm && DATA.metrics[+mm[1]]) { html = viewMetric(DATA.metrics[+mm[1]]); isDetail = true; }
  else if (am && DATA.activities[+am[1]]) { html = viewAct(DATA.activities[+am[1]]); isDetail = true; }
  else { tab = TABS[h] ? h : 'heute'; html = TABS[tab](); }
  view.innerHTML = html;
  for (const a of document.querySelectorAll('.tabs a')) a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  window.scrollTo(0, isDetail ? 0 : (scrollPos[tab] || 0));
  if (tab === 'coach' && !isDetail) Coach.mount();
  const reset = m => () => { const p = last(m); if (p && $('#selVal')) { $('#selVal').innerHTML = bigHTML(p.value, m.unit); $('#selDate').textContent = selLabel(p.date); } };
  const pick = m => (p, wk) => { $('#selVal').innerHTML = bigHTML(p.value, m.unit); $('#selDate').textContent = selLabel(p.date, wk); };
  if (mm && isDetail) { const m = DATA.metrics[+mm[1]]; bindScrub(m, pick(m), reset(m)); }
  if (tab === 'koerper' && !isDetail) { const m = M('weight') && last(M('weight')) ? M('weight') : DATA.metrics.find(x => x.category === 'Körpermaße' && last(x)); if (m) bindScrub(m, pick(m), reset(m)); }
}
function go(h) { if (!/^[ma]-/.test(location.hash.slice(1))) scrollPos[tab] = window.scrollY; location.hash = h; }
document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-go],[data-back],[data-range],[data-more],.tabs a,#logoutBtn,#refreshBtn');
  if (!t) return;
  if (t.matches('.tabs a')) { if (t.dataset.tab === tab && location.hash.slice(1) === tab) window.scrollTo({ top: 0, behavior: 'smooth' }); else if (!/^[ma]-/.test(location.hash.slice(1))) scrollPos[tab] = window.scrollY; if (t.dataset.tab !== tab) scrollPos[t.dataset.tab] = 0; return; }
  if (t.dataset.go) go(t.dataset.go);
  else if ('back' in t.dataset) location.hash = tab;
  else if (t.dataset.range != null) { range = +t.dataset.range; const y = window.scrollY; route(); window.scrollTo(0, y); }
  else if ('more' in t.dataset) { actShown += 60; const y = window.scrollY; route(); window.scrollTo(0, y); }
  else if (t.id === 'logoutBtn') logout();
  else if (t.id === 'refreshBtn') refresh();
});
document.addEventListener('change', ev => {
  const m = /^goal-(steps|sleep|intensityWeek)$/.exec(ev.target.id || ''); if (!m) return;
  const v = parseFloat(ev.target.value); if (Number.isFinite(v) && v > 0) store.set('goal-' + m[1], v); else ev.target.value = store.get('goal-' + m[1], GOAL_DEFAULT[m[1]]);
});
document.addEventListener('submit', ev => { if (ev.target.id === 'goalForm') ev.preventDefault(); });
window.addEventListener('hashchange', route);

/* ---------- Verschlüsselung (Format gesundheit-v1) ---------- */
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const keyId = e => `${e.salt}:${e.iterations}`;
async function loadEnvelope() {
  const r = await fetch(DATA_URL, { cache: 'no-store' }); if (!r.ok) throw new Error('Datenpaket nicht verfügbar');
  const e = await r.json();
  if (e.format !== 'gesundheit-v1' || e.algorithm !== 'AES-GCM-256' || e.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(e.iterations) || e.iterations < 600000 || e.iterations > 5000000) throw new Error('Ungültiges Datenpaket');
  return e;
}
async function deriveKey(password, e) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(e.salt), iterations: e.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decrypt(key, e) {
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: new TextEncoder().encode('gesundheit-v1'), tagLength: 128 }, key, unb64(e.ciphertext)));
  const d = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(d.metrics) || !Array.isArray(d.activities)) throw new Error('Datenformat nicht unterstützt');
  return d;
}
// Gemerkter Zugang: der Schlüssel liegt nicht exportierbar in IndexedDB, das Passwort wird nie gespeichert.
function idb(action, value) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gesundheit-neu', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('keys', action === 'get' ? 'readonly' : 'readwrite'), s = tx.objectStore('keys');
      const q = action === 'get' ? s.get('device') : action === 'put' ? s.put(value, 'device') : s.delete('device');
      tx.oncomplete = () => { db.close(); resolve(q.result); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function start(data, demoMode) {
  Coach.reset();
  DATA = prepare(data); IS_DEMO = !!demoMode;
  $('#lock').hidden = true; $('#app').hidden = false; $('#demoBar').hidden = !IS_DEMO;
  route();
}
function showLock(msg = '') {
  DATA = null; sessionKey = null; $('#app').hidden = true; $('#view').innerHTML = ''; $('#lock').hidden = false; $('#lockMsg').textContent = msg; $('#password').value = '';
}
async function logout() {
  await Coach.forget();
  if (!IS_DEMO) { try { await idb('delete'); } catch {} }
  if (PREVIEW) { location.hash = 'heute'; return; }
  history.replaceState(null, '', location.pathname); showLock();
}
async function refresh() {
  const msg = $('#refreshMsg'); msg.textContent = 'Wird geladen …';
  try { const e = await loadEnvelope(); const d = await decrypt(sessionKey, e); DATA = prepare(d); route(); $('#refreshMsg').textContent = 'Daten sind aktuell.'; }
  catch (err) { if (err.name === 'OperationError') { try { await idb('delete'); } catch {} showLock('Das Datenpaket wurde neu verschlüsselt. Bitte Passwort eingeben.'); } else msg.textContent = 'Laden nicht möglich. Bitte Verbindung prüfen.'; }
}
$('#unlockForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#unlock'), msg = $('#lockMsg'); btn.disabled = true; msg.textContent = 'Wird entschlüsselt …';
  try {
    if (!crypto.subtle) throw new Error('WebCrypto fehlt');
    const e = await loadEnvelope(), key = await deriveKey($('#password').value, e), d = await decrypt(key, e);
    sessionKey = key;
    try { if ($('#remember').checked) await idb('put', { id: keyId(e), key }); else await idb('delete'); } catch {}
    msg.textContent = ''; $('#password').value = ''; start(d, false);
  } catch (err) {
    msg.textContent = err.name === 'OperationError' ? 'Das Passwort stimmt nicht.' : 'Entsperren nicht möglich. Bitte Verbindung prüfen.';
  } finally { btn.disabled = false; }
});
$('#demoBtn').addEventListener('click', () => start(demo(), true));

async function boot() {
  if (PREVIEW) { start(demo(), true); return; }
  // Aufräumen: gespeicherter PIN-Zugang der früheren App-Version wird nicht mehr gebraucht.
  // Aufräumen: die beendete Testversion unter /gesundheit-neu/ (gleiche Adresse, eigener Service Worker) abmelden.
  try { for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname.startsWith('/gesundheit-neu/')) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) if (/^gesundheit-v2-[0-4]$/.test(k)) await caches.delete(k); } catch {}
  try { indexedDB.deleteDatabase('gesundheit-zugang'); } catch {}
  if ('serviceWorker' in navigator && /^https:$|^http:$/.test(location.protocol)) {
    // Neue Version: sobald der neue Service Worker übernimmt, einmal neu laden, damit alle Dateien zusammenpassen.
    const hadController = !!navigator.serviceWorker.controller; let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // Auf dem iPhone startet die installierte App oft nicht neu, sondern wird nur wieder angezeigt: dann nach Updates sehen.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  try {
    const rec = await idb('get');
    if (rec?.key) { const e = await loadEnvelope(); if (keyId(e) === rec.id) { const d = await decrypt(rec.key, e); sessionKey = rec.key; start(d, false); return; } await idb('delete'); }
  } catch {}
  showLock();
}

/* ---------- Beispieldaten ---------- */
function demo() {
  let s = 7031980;
  const rnd = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const g = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.15;
  const N = 400, today = iso(new Date()), days = [...Array(N)].map((_, i) => shift(today, i - N + 1));
  const mk = (id, name, category, unit, chart, source, f, skip = 0) => ({ id, name, category, unit, chart, points: days.map((date, i) => rnd() < skip ? null : { date, value: f(i, D(date).getDay()), source }).filter(Boolean) });
  const fit = i => i / N, wave = i => Math.sin(i / 23);
  const sleepV = days.map((_, i) => Math.max(4.6, 7.15 + g() * .75 + (D(days[i]).getDay() % 6 === 0 ? .5 : 0)));
  const loadV = days.map(() => 0), acts = [];
  const sports = [['Laufen', 'running', 46, 8.6, 148], ['Radfahren', 'cycling', 95, 38, 132], ['Krafttraining', 'strength_training', 52, 0, 108], ['Wandern', 'hiking', 170, 11.5, 112], ['Rudern', 'indoor_rowing', 32, 6.8, 141]];
  days.forEach((date, i) => {
    const wd = D(date).getDay(), pr = wd === 0 || wd === 6 ? .62 : .36;
    if (rnd() > pr) return;
    const r = rnd(), sp = sports[(wd === 0 || wd === 6) && r < .35 ? 3 : r < .45 ? 0 : r < .7 ? 1 : r < .9 ? 2 : 4], k = 1 + g() * .22;
    const durationMinutes = Math.round(sp[2] * k), distanceKm = +(sp[3] * k * (1 + g() * .05)).toFixed(2), pulse = Math.round(sp[4] + g() * 7), load = Math.round(durationMinutes * (pulse - 70) / 42);
    loadV[i] = load;
    acts.push({ id: 'demo-' + i, date, time: `${String(wd === 0 || wd === 6 ? 9 + Math.floor(rnd() * 3) : 17 + Math.floor(rnd() * 3)).padStart(2, '0')}:${String(Math.floor(rnd() * 12) * 5).padStart(2, '0')}`, sport: sp[0], sportKey: sp[1], durationMinutes, movingMinutes: Math.round(durationMinutes * .96), distanceKm, pulse, maxPulse: pulse + 18 + Math.round(rnd() * 10), calories: Math.round(durationMinutes * (pulse - 60) / 9), elevationGain: sp[1] === 'hiking' ? Math.round(620 * k) : sp[1] === 'cycling' ? Math.round(410 * k) : sp[1] === 'running' ? Math.round(70 * k) : 0, avgSpeedKmh: distanceKm ? +(distanceKm / durationMinutes * 60).toFixed(1) : 0, trainingLoad: load, aerobicTE: +Math.min(5, 1.8 + load / 90).toFixed(1) });
  });
  const acute = i => loadV.slice(Math.max(0, i - 6), i + 1).reduce((a, b) => a + b, 0), chronic = i => loadV.slice(Math.max(0, i - 27), i + 1).reduce((a, b) => a + b, 0) / 4;
  const trained = i => loadV[i] > 0;
  const metrics = [
    mk('steps', 'Schritte', 'Aktivität', 'Schritte', 'bar', 'Garmin', (i, wd) => Math.round(Math.max(1800, 8300 + (wd === 6 ? 2600 : wd === 0 ? 900 : 0) + (trained(i) ? 2400 : 0) + g() * 2300) * (i === N - 1 ? .78 : 1))),
    mk('intensity', 'Intensitätsminuten', 'Aktivität', 'min', 'bar', 'Garmin', i => trained(i) ? Math.round(Math.max(8, loadV[i] * .45 + g() * 8)) : Math.round(Math.max(0, 3 + g() * 5))),
    mk('energy', 'Aktive Energie', 'Aktivität', 'kcal', 'bar', 'Garmin', i => Math.round(Math.max(180, 420 + loadV[i] * 4.2 + g() * 110))),
    mk('vo2run', 'VO₂max Laufen', 'Aktivität', 'ml/kg/min', 'line', 'Garmin', i => +(47.2 + fit(i) * 2.1 + wave(i) * .3 + g() * .2).toFixed(1), .7),
    mk('load', 'Trainingsbelastung 7 Tage', 'Aktivität', 'Punkte', 'line', 'Garmin', i => acute(i)),
    mk('acwr', 'Belastungsverhältnis', 'Aktivität', 'Verhältnis', 'line', 'Garmin', i => +(acute(i) / Math.max(60, chronic(i))).toFixed(2)),
    mk('sleep', 'Schlafdauer', 'Schlaf', 'h', 'bar', 'Garmin', i => +sleepV[i].toFixed(2)),
    mk('score', 'Schlafqualität', 'Schlaf', 'Punkte', 'line', 'Garmin', i => Math.round(Math.max(42, Math.min(96, 78 + (sleepV[i] - 7.15) * 11 + g() * 6)))),
    mk('rest', 'Ruhepuls', 'Herz', 'bpm', 'line', 'Garmin', i => Math.round(55.5 - fit(i) * 3 + wave(i) * 1.2 + (trained(i - 1) ? 1.2 : 0) + g() * 1.6)),
    mk('hrv', 'Herzfrequenzvariabilität', 'Herz', 'ms', 'line', 'Garmin', i => Math.round(54 + fit(i) * 7 - wave(i) * 3 - (trained(i - 1) ? 3 : 0) + (sleepV[i] - 7.15) * 4 + g() * 5)),
    mk('stress', 'Stress', 'Herz', 'Punkte', 'line', 'Garmin', i => Math.round(Math.max(12, 31 - fit(i) * 4 + wave(i) * 3 + g() * 6))),
    mk('bbhigh', 'Body Battery Höchstwert', 'Herz', 'Punkte', 'line', 'Garmin', i => Math.round(Math.max(35, Math.min(100, 80 + (sleepV[i] - 7.15) * 13 + g() * 7)))),
    mk('weight', 'Gewicht', 'Körpermaße', 'kg', 'line', 'Withings', i => +(82.6 - fit(i) * 3.1 + Math.sin(i / 41) * .5 + g() * .32).toFixed(1), .18),
    mk('fat', 'Körperfett', 'Körpermaße', '%', 'line', 'Withings', i => +(21.4 - fit(i) * 2.3 + g() * .35).toFixed(1), .18),
    mk('muscle', 'Muskelmasse', 'Körpermaße', 'kg', 'line', 'Withings', i => +(61.2 + fit(i) * .7 + g() * .25).toFixed(1), .18)
  ];
  return { built: new Date().toISOString(), notes: ['Alle Werte sind erfunden.'], metrics, activities: acts };
}

boot();
})();
