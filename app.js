/* The Rest Is History — world timeline. Canvas renderer: civilisation bars per region (lane),
   podcast episodes overlaid as markers that cluster by decade/century when zoomed out. */
(() => {
'use strict';

const LANES = window.LANES, FAM = window.FAMILIES, T_MIN = window.T_MIN, T_MAX = window.T_MAX;
const EPS = window.EPISODES;
const laneById = Object.fromEntries(LANES.map(l => [l.id, l]));
const $ = s => document.querySelector(s);

const INK = '#1F2A44', ACCENT = '#B8232F', GOLD = '#F2B01E', PAPER = '#FBF8F1', MUTED = '#7A7262', LINE = '#DDD5C3';
const UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Avenir Next", system-ui, sans-serif';
const LABEL_FONT = `600 11px ${UI}`;
const GUT = 150, AXIS = 30, ROWH = 22, DOT = 12, GAP = 4, MAX_SCALE = 90, SURVEY_YEARS = 150;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const cv = $('#tl'), ctx = cv.getContext('2d');
const mini = $('#mini'), mctx = mini.getContext('2d');
const tip = $('#tip'), panel = $('#panel'), panelBody = $('#panel-body');
const audio = $('#audio'), player = $('#player');

let W = 0, H = 0, MW = 0, MH = 0, dpr = 1;
const view = { t0: T_MIN, scale: 0.2, y: 0 };
let vz = 1, fitMode = true, totalH = 0, layoutVersion = 0;
const expanded = new Set();
let selected = null, hovered = null, playing = null, matchSet = null;
let hits = [], dirty = false, anim = null;

/* ---------- data prep ---------- */
for (const ep of EPS) {
  ep.ds = Math.max(ep.s, T_MIN);
  ep.de = Math.min(Math.max(ep.e + 1, ep.ds + 1), T_MAX);
  if (ep.ds >= ep.de) ep.ds = ep.de - 1;
  ep.survey = ep.de - ep.ds > SURVEY_YEARS;
  ep.hay = `${ep.t} ${ep.sr || ''} ${ep.tp} ${ep.d}`.toLowerCase();
}
const THEMATIC = EPS.filter(e => e.th);
for (const L of LANES) {
  L.all = EPS.filter(e => !e.th && e.l === L.id).sort((a, b) => a.ds - b.ds || a.i - b.i);
  L.eps = L.all;
}
const SERIES = {};
for (const ep of EPS) if (ep.sr) (SERIES[ep.sr] = SERIES[ep.sr] || []).push(ep);

/* ---------- helpers ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => n.toLocaleString('en-GB');
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const niceStep = min => STEPS.find(s => s >= min) || 2000;
const X = yr => GUT + (yr - view.t0) * view.scale;
const yearAt = x => view.t0 + (x - GUT) / view.scale;
const visYears = () => (W - GUT) / view.scale;
const minScale = () => (W - GUT) / (T_MAX - T_MIN);

function fmtYear(y) { return y < 0 ? `${num(-y)} BC` : y === 0 ? '1 BC' : y < 1000 ? `AD ${y}` : String(y); }
function fmtRange(s, e) {
  if (s === e) return fmtYear(s);
  if (s < 0 && e < 0) return `${num(-s)}–${num(-e)} BC`;
  if (s < 0) return `${fmtYear(s)} – ${fmtYear(e)}`;
  return `${s < 1000 ? 'AD ' : ''}${s}–${e}`;
}
function fmtCell(a, step) {
  if (step === 1) return fmtYear(a);
  return fmtRange(a, a + step - 1);
}
function fmtDur(s) { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
function fmtDate(d) { return d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

const w10 = new Map();
function m10(text, bold) {
  const k = (bold ? 'b' : 'n') + text;
  let w = w10.get(k);
  if (w === undefined) { ctx.font = `${bold ? 700 : 600} 10px ${UI}`; w = ctx.measureText(text).width; w10.set(k, w); }
  return w;
}
const truncCache = new Map();
function trunc(text, maxW) {
  if (maxW < 14) return '';
  const k = text + '|' + (maxW >> 2);
  let r = truncCache.get(k);
  if (r !== undefined) return r;
  const full = m10(text) * 1.1;
  if (full <= maxW) r = text;
  else {
    let n = Math.max(0, Math.floor(text.length * maxW / full));
    while (n > 0 && m10(text.slice(0, n).trimEnd() + '…') * 1.1 > maxW) n--;
    r = n > 1 ? text.slice(0, n).trimEnd() + '…' : '';
  }
  if (truncCache.size > 8000) truncCache.clear();
  truncCache.set(k, r);
  return r;
}
function rr(x, y, w, h, r) { ctx.beginPath(); if (w > 0 && h > 0) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); }

/* ---------- lane geometry ---------- */
function baseHeight(L) {
  const k0 = clamp(Math.round(1 + Math.sqrt(L.all.length) * 0.5), 2, 8);
  return Math.max(k0 * ROWH + 10, L.rows * 13, 62);
}
function laneMetrics() {
  if (fitMode) {
    const base = LANES.reduce((s, L) => s + baseHeight(L) * (expanded.has(L.id) ? 2 : 1), 0);
    vz = clamp((H - AXIS) / base, 0.3, 1);
  } else vz = 1;
  let y = 0;
  for (const L of LANES) {
    L.h = Math.round(baseHeight(L) * vz * (expanded.has(L.id) ? 2 : 1));
    L.y = y; L.K = Math.max(1, Math.floor((L.h - 4) / ROWH));
    y += L.h;
  }
  totalH = y;
}
function clampView() {
  view.scale = clamp(view.scale, minScale(), MAX_SCALE);
  const pad = 30 / view.scale;
  view.t0 = clamp(view.t0, T_MIN - pad, Math.max(T_MIN - pad, T_MAX + pad - visYears()));
  view.y = clamp(view.y, 0, Math.max(0, totalH - (H - AXIS)));
}

/* ---------- episode layout (per lane, per zoom level) ---------- */
function layoutLane(L) {
  const sc = view.scale, K = L.K;
  const sel = selected && !selected.th && selected.l === L.id && L.eps.includes(selected) ? selected : null;
  const key = `${sc}|${K}|${layoutVersion}|${sel ? sel.i : ''}`;
  if (L.lay && L.lay.key === key) return L.lay;
  const cy = niceStep(34 / sc), cw = cy * sc;
  const rows = Array.from({ length: K }, () => []);
  const items = [];
  const free = (r, a, b, hardOnly) => {
    for (const iv of rows[r]) { if (hardOnly && iv.soft) continue; if (a < iv.b + GAP && iv.a < b + GAP) return false; }
    return true;
  };
  const cells = new Map();
  const toCell = ep => {
    const at = ep.survey || (ep.de - ep.ds) > cy ? ep.ds : (ep.ds + ep.de) / 2;
    const k = Math.floor(at / cy);
    let c = cells.get(k); if (!c) cells.set(k, c = []);
    c.push(ep);
  };
  // 0. the selected episode is always shown on its own, with its label
  if (sel) {
    const a = sel.ds * sc, b = a + (sel.survey ? DOT : Math.max((sel.de - sel.ds) * sc, DOT));
    const it = { type: 'ep', ep: sel, a, b, row: 0 };
    rows[0].push(it); items.push(it);
    if (b - a < 46) rows[0].push({ a: b, b: b + 14 + Math.min(m10(sel.t) * 1.1 + 8, 240), owner: it });
  }
  // 1. long episodes become pills spanning their real extent
  const longRows = Math.max(1, K - 1);
  for (const ep of L.eps) {
    if (ep === sel) continue;
    const w = (ep.de - ep.ds) * sc;
    if (ep.survey || w <= Math.max(cw * 1.5, 44)) { toCell(ep); continue; }
    const a = ep.ds * sc, b = a + w;
    let placed = false;
    for (let r = 0; r < longRows; r++) if (free(r, a, b, true)) {
      const it = { type: 'ep', ep, a, b, row: r, long: true };
      rows[r].push(it); items.push(it); placed = true; break;
    }
    if (!placed) toCell(ep);
  }
  // 2. the rest: individually if the cell has room, otherwise one cluster badge per cell
  const keys = [...cells.keys()].sort((p, q) => p - q);
  for (const k of keys) {
    const mem = cells.get(k);
    let ok = mem.length <= K;
    const snap = rows.map(r => r.length), added = [];
    if (ok) for (const ep of mem) {
      const a = ep.ds * sc;
      const b = a + (ep.survey ? DOT : clamp((ep.de - ep.ds) * sc, DOT, Math.max(cw * 1.5, 44)));
      const want = b + 10 + Math.min(m10(ep.t) * 1.1 + 8, 130);
      let row = -1, soft = false;
      for (let r = 0; r < K && row < 0; r++) if (free(r, a, want, false)) { row = r; soft = true; }
      for (let r = 0; r < K && row < 0; r++) if (free(r, a, b, false)) row = r;
      for (let r = 0; r < K && row < 0; r++) if (free(r, a, b, true)) row = r;
      if (row < 0) { ok = false; break; }
      const it = { type: 'ep', ep, a, b, row };
      rows[row].push(it); added.push(it);
      if (soft) rows[row].push({ a: b, b: want, soft: true });
    }
    if (ok) { items.push(...added); continue; }
    rows.forEach((r, i) => { r.length = snap[i]; });
    if (mem.length === 1) {           // nowhere to put a lone episode: overlay it on the last row
      const ep = mem[0], a = ep.ds * sc;
      const it = { type: 'ep', ep, a, b: a + DOT, row: K - 1 };
      rows[K - 1].push(it); items.push(it); continue;
    }
    const bw = 14 + 7 * String(mem.length).length;
    const a = (k + 0.5) * cw - bw / 2, b = a + bw;
    let row = -1;
    for (let r = K - 1; r >= 0 && row < 0; r--) if (free(r, a, b, false)) row = r;
    for (let r = K - 1; r >= 0 && row < 0; r--) if (free(r, a, b, true)) row = r;
    if (row < 0) row = K - 1;
    const groups = new Map();
    for (const ep of mem) { const g = ep.sr || ep.t; groups.set(g, (groups.get(g) || 0) + 1); }
    const top = [...groups.entries()].sort((p, q) => q[1] - p[1]);
    const label = top[0][0] + (top.length > 1 ? `  +${mem.length - top[0][1]}` : '');
    const it = { type: 'cl', eps: mem, a, b, row, cs: k * cy, cy, label, groups: top };
    rows[row].push(it); items.push(it);
  }
  // 3. labels take whatever room is left to the right of each marker
  for (const row of rows) {
    const hard = row.filter(iv => !iv.soft).sort((p, q) => p.a - q.a);
    hard.forEach((it, i) => {
      if (!it.type) return;
      let next = hard[i + 1], own = 0;
      if (next && next.owner === it) { own = next.b - it.b; next = hard[i + 2]; }
      const avail = Math.max(own, Math.min(next ? next.a - it.b - 10 : 260, 260));
      it.inside = it.type === 'ep' && it.b - it.a >= 46;
      it.labelW = !it.inside && avail >= 34 ? avail : 0;
    });
  }
  return (L.lay = { key, items, cy });
}

/* ---------- drawing ---------- */
function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = cv.parentElement.getBoundingClientRect();
  const keepRange = W ? [view.t0, view.t0 + visYears()] : null;
  W = Math.max(320, r.width); H = Math.max(200, r.height);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const m = mini.getBoundingClientRect();
  MW = m.width; MH = m.height;
  mini.width = Math.round(MW * dpr); mini.height = Math.round(MH * dpr);
  if (keepRange) view.scale = (W - GUT) / (keepRange[1] - keepRange[0]);
  laneMetrics(); clampView(); draw();   // sizing a canvas clears it, so repaint in the same frame
}
function invalidate() { if (!dirty) { dirty = true; requestAnimationFrame(draw); } }

function wrapN(words, n) {
  const total = m10(words.join(' ')), target = total / n, lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && lines.length < n - 1 && m10(t) > target * 1.08) { lines.push(cur); cur = w; } else cur = t;
  }
  lines.push(cur);
  return lines;
}
function wrapW(text, maxW10) {
  const lines = []; let cur = '';
  for (const w of text.split(' ')) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && m10(t) > maxW10) { lines.push(cur); cur = w; } else cur = t;
  }
  lines.push(cur);
  return lines;
}
function fitLabel(name, bw, bh, maxPx) {
  let size = Math.min(maxPx, bh * 0.64, bw / m10(name) * 10);
  if (size >= 8.5) return { lines: [name], size };
  const words = name.split(' ');
  for (let n = 2; n <= 3 && words.length >= n; n++) {
    if (bh < n * 10.5) break;
    const lines = wrapN(words, n);
    const mw = Math.max(...lines.map(l => m10(l)));
    size = Math.min(maxPx, bh * 0.82 / n, bw / mw * 10);
    if (size >= 8.5) return { lines, size };
  }
  return null;
}

function drawBars(L, ly) {
  const rh = L.h / L.rows;
  for (const b of L.bars) {
    let x0 = X(b[1]), x1 = X(b[2]);
    if (x1 < GUT || x0 > W) continue;
    const y0 = ly + b[3] * rh, y1 = ly + b[4] * rh, fam = FAM[b[5]];
    const cx0 = Math.max(x0, GUT - 2), cx1 = Math.min(x1, W + 2);
    ctx.fillStyle = fam.color;
    ctx.fillRect(cx0, y0, cx1 - cx0, y1 - y0);
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1;
    ctx.strokeRect(cx0 + 0.5, y0 + 0.5, cx1 - cx0 - 1, y1 - y0 - 1);
    const vx0 = Math.max(x0, GUT) + 5, vx1 = Math.min(x1, W) - 5, bw = vx1 - vx0, bh = y1 - y0;
    if (bw < 26 || bh < 9.5) continue;
    const caps = b[0] === b[0].toUpperCase() || /^[A-ZÀ-Ý’' ·&-]{4,}/.test(b[0]);
    const f = fitLabel(b[0], bw, bh - 2, fam.soft ? 11.5 : caps ? clamp(bh * 0.42, 11, 20) : 12);
    if (!f) continue;
    ctx.font = `${fam.soft ? 'italic 500' : 600} ${f.size.toFixed(1)}px ${UI}`;
    ctx.fillStyle = fam.soft ? 'rgba(110,100,80,.8)' : 'rgba(35,28,15,.68)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lh = f.size * 1.14, cy = (y0 + y1) / 2 - (f.lines.length - 1) * lh / 2;
    f.lines.forEach((ln, i) => ctx.fillText(ln, (vx0 + vx1) / 2, cy + i * lh + 0.5));
  }
}

function chip(x, cy, text, color) {
  ctx.font = LABEL_FONT;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,253,247,.93)';
  rr(x, cy - 7.5, tw + 9, 15, 4); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 4.5, cy + 0.5);
  return tw + 9;
}

function drawItems(L, ly) {
  const lay = layoutLane(L), sc = view.scale, off = GUT - view.t0 * sc;
  const rowH = (L.h - 4) / L.K;
  for (const it of lay.items) {
    const x = it.a + off, w = it.b - it.a;
    const cy = ly + 2 + it.row * rowH + rowH / 2;
    if (it.type === 'cl') {
      if (x + w + it.labelW + 14 < GUT || x > W) continue;
      const sel = selected && it.eps.includes(selected);
      ctx.fillStyle = ACCENT; rr(x, cy - 8.5, w, 17, 8.5); ctx.fill();
      ctx.strokeStyle = sel ? GOLD : '#fff'; ctx.lineWidth = sel ? 2.5 : 1.25; ctx.stroke();
      ctx.font = `700 10.5px ${UI}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(it.eps.length), x + w / 2, cy + 0.5);
      let hw = w;
      if (it.labelW) { const t = trunc(it.label, it.labelW - 9); if (t) hw += 3 + chip(x + w + 3, cy, t, '#7A1620'); }
      hits.push({ x, y: cy - 9, w: hw, h: 18, it });
      continue;
    }
    const ep = it.ep, wEnd = ep.survey ? X(ep.de) : 0;
    if (Math.max(x + w + it.labelW + 14, wEnd) < GUT || x > W) continue;
    const sel = ep === selected, hov = hovered && hovered.ep === ep;
    const fill = ep === playing ? ACCENT : INK;
    if (ep.survey) {                       // whisker shows the full span of a survey episode
      ctx.strokeStyle = sel || hov ? fill : 'rgba(31,42,68,.38)'; ctx.lineWidth = sel || hov ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(x + 6, cy); ctx.lineTo(wEnd, cy); ctx.moveTo(wEnd, cy - 4); ctx.lineTo(wEnd, cy + 4); ctx.stroke();
    }
    let hw = w;
    if (w > DOT + 1) {
      const px = Math.max(x, GUT - 20), pr = Math.max(px + 1, Math.min(x + w, W + 20));
      const wide = w > 150;              // wide spans go light so the backdrop stays readable
      ctx.fillStyle = wide ? (hov || sel ? 'rgba(255,253,247,.97)' : 'rgba(255,253,247,.86)') : fill;
      rr(px, cy - 7.5, pr - px, 15, 7.5); ctx.fill();
      ctx.strokeStyle = sel ? GOLD : wide ? fill : 'rgba(255,255,255,.9)'; ctx.lineWidth = sel ? 2.5 : wide ? 1.25 : 1; ctx.stroke();
      if (wide && x > GUT - 8) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x + 7.5, cy, 4, 0, Math.PI * 2); ctx.fill(); }
      if (it.inside) {
        const tx = Math.max(x + (wide ? 9 : 0), GUT) + 7, t = trunc(ep.t, Math.min(x + w, W) - tx - 6);
        if (t) { ctx.font = LABEL_FONT; ctx.fillStyle = wide ? fill : '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, tx, cy + 0.5); }
      }
    } else {
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x + 6, cy, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = sel ? GOLD : '#fff'; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.stroke();
    }
    if (it.labelW) { const t = trunc(ep.t, it.labelW - 9); if (t) hw += 3 + chip(x + w + 3, cy, t, INK); }
    hits.push({ x: Math.max(x, GUT), y: cy - 9, w: hw - (Math.max(x, GUT) - x), h: 18, it });
  }
}

function band(ep, fill, stroke) {
  const L = laneById[ep.l]; if (!L || ep.th) return;
  const ly = AXIS + L.y - view.y, x0 = Math.max(X(ep.ds), GUT - 2), x1 = Math.min(Math.max(X(ep.de), X(ep.ds) + 3), W + 2);
  if (x1 < GUT || x0 > W) return;
  ctx.fillStyle = fill; ctx.fillRect(x0, ly, x1 - x0, L.h);
  ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.strokeRect(x0, ly + 0.75, x1 - x0, L.h - 1.5);
}

function drawAxis() {
  const sc = view.scale;
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, AXIS);
  const step = niceStep(84 / sc);
  const minor = step % 5 === 0 ? step / 5 : step % 2 === 0 ? step / 2 : step;
  const a = yearAt(GUT), b = yearAt(W);
  ctx.strokeStyle = '#B9AF9A'; ctx.lineWidth = 1; ctx.beginPath();
  for (let y = Math.ceil(a / minor) * minor; y <= b; y += minor) {
    const x = Math.round(X(y)) + 0.5, major = y % step === 0;
    ctx.moveTo(x, AXIS - (major ? 9 : 4)); ctx.lineTo(x, AXIS);
  }
  ctx.stroke();
  ctx.font = `600 11px ${UI}`; ctx.fillStyle = '#5E5747'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let y = Math.ceil(a / step) * step; y <= b; y += step) {
    const lab = y < 0 ? `${-y} BC` : y === 0 ? 'BC | AD' : String(y);
    ctx.fillText(lab, X(y) + 4, AXIS / 2 - 2);
  }
  ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(0, AXIS - 0.5); ctx.lineTo(W, AXIS - 0.5); ctx.stroke();
}

function drawGutter() {
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, GUT, H);
  ctx.save(); ctx.beginPath(); ctx.rect(0, AXIS, GUT, H - AXIS); ctx.clip();
  for (const L of LANES) {
    const ly = AXIS + L.y - view.y;
    if (ly > H || ly + L.h < AXIS) continue;
    const hov = hovered && hovered.lane === L;
    if (hov) { ctx.fillStyle = '#F3EEE2'; ctx.fillRect(0, ly, GUT, L.h); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const top = Math.max(ly, AXIS) + 4, room = ly + L.h - top;   // labels stick to the top while the lane scrolls
    const nameLines = wrapW(L.name, (GUT - 34) / 1.3);
    let y = top + 13;
    ctx.font = `700 12.5px ${UI}`; ctx.fillStyle = '#26221B';
    for (const ln of nameLines) { if (y - top < room) ctx.fillText(ln, 12, y); y += 15; }
    if (L.sub && room > y - top + 26) {
      ctx.font = `500 10px ${UI}`; ctx.fillStyle = MUTED;
      for (const ln of wrapW(L.sub, GUT - 28)) { if (room > y - top + 14) ctx.fillText(ln, 12, y - 2); y += 12; }
    }
    if (room > y - top + 4) {
      const n = L.eps.length;
      ctx.font = `600 10.5px ${UI}`; ctx.fillStyle = n ? ACCENT : '#B5AD9B';
      ctx.fillText(matchSet ? `${n} of ${L.all.length}` : `${n} episode${n === 1 ? '' : 's'}`, 12, y);
    }
    ctx.font = `600 10px ${UI}`; ctx.fillStyle = hov ? INK : '#B5AD9B'; ctx.textAlign = 'right';
    if (room > 16) ctx.fillText(expanded.has(L.id) ? '–' : '+', GUT - 9, top + 12);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, ly + L.h - 0.5); ctx.lineTo(GUT, ly + L.h - 0.5); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, GUT, AXIS);
  ctx.font = `600 10px ${UI}`; ctx.fillStyle = MUTED; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('REGION', 12, AXIS / 2 - 1);
  ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(GUT - 0.5, 0); ctx.lineTo(GUT - 0.5, H); ctx.moveTo(0, AXIS - 0.5); ctx.lineTo(GUT, AXIS - 0.5); ctx.stroke();
  // vertical scroll thumb
  const vh = H - AXIS;
  if (totalH > vh + 1) {
    const th = Math.max(30, vh * vh / totalH), ty = AXIS + (vh - th) * view.y / (totalH - vh);
    ctx.fillStyle = 'rgba(31,42,68,.28)'; rr(W - 7, ty + 2, 4, th - 4, 2); ctx.fill();
  }
}

function draw() {
  dirty = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  hits = [];
  const vis = LANES.filter(L => { const ly = AXIS + L.y - view.y; return ly < H && ly + L.h > AXIS; });
  ctx.save(); ctx.beginPath(); ctx.rect(GUT, AXIS, W - GUT, H - AXIS); ctx.clip();
  for (const L of vis) drawBars(L, AXIS + L.y - view.y);
  // gridlines + lane separators
  const step = niceStep(84 / view.scale);
  ctx.strokeStyle = 'rgba(40,30,10,.07)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let y = Math.ceil(yearAt(GUT) / step) * step; y <= yearAt(W); y += step) { const x = Math.round(X(y)) + 0.5; ctx.moveTo(x, AXIS); ctx.lineTo(x, H); }
  ctx.stroke();
  ctx.strokeStyle = PAPER; ctx.lineWidth = 3; ctx.beginPath();
  for (const L of vis) { const y = AXIS + L.y - view.y + L.h; ctx.moveTo(GUT, y); ctx.lineTo(W, y); }
  ctx.stroke();
  if (hovered && hovered.ep && hovered.ep !== selected) band(hovered.ep, 'rgba(31,42,68,.10)', 'rgba(31,42,68,.45)');
  if (selected) band(selected, 'rgba(242,176,30,.24)', GOLD);
  for (const L of vis) {
    const ly = AXIS + L.y - view.y;
    ctx.save(); ctx.beginPath(); ctx.rect(GUT, Math.max(ly, AXIS), W - GUT, L.h); ctx.clip();
    drawItems(L, ly);
    ctx.restore();
  }
  ctx.restore();
  drawAxis(); drawGutter(); drawMini();
}

/* ---------- overview strip ---------- */
const mx = yr => GUT + (yr - T_MIN) / (T_MAX - T_MIN) * (MW - GUT - 8);
function drawMini() {
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, MW, MH);
  const BIN = 4, n = Math.ceil((MW - GUT) / BIN), bins = new Float32Array(n + 1);
  let total = 0;
  for (const L of LANES) for (const ep of L.eps) {
    const i = Math.floor((mx(ep.survey ? ep.ds : (ep.ds + ep.de) / 2) - GUT) / BIN);
    if (i >= 0 && i <= n) { bins[i]++; total++; }
  }
  const max = Math.max(1, ...bins);
  mctx.fillStyle = 'rgba(31,42,68,.72)';
  for (let i = 0; i <= n; i++) if (bins[i]) {
    const h = Math.max(2, Math.sqrt(bins[i] / max) * (MH - 16));
    mctx.fillRect(GUT + i * BIN, MH - h, BIN - 1, h);
  }
  mctx.font = `600 9.5px ${UI}`; mctx.fillStyle = '#8C8472'; mctx.textAlign = 'left'; mctx.textBaseline = 'top';
  for (let y = -3000; y <= 2000; y += 500) mctx.fillText(y < 0 ? `${-y} BC` : y === 0 ? 'AD' : String(y), mx(y) + 3, 3);
  mctx.fillStyle = 'rgba(140,132,114,.5)';
  for (let y = -3000; y <= 2000; y += 500) mctx.fillRect(Math.round(mx(y)), 0, 1, MH);
  mctx.font = `600 10px ${UI}`; mctx.fillStyle = MUTED; mctx.textBaseline = 'middle';
  mctx.fillText('EPISODES OVER TIME', 12, MH / 2 - 6);
  mctx.font = `500 10px ${UI}`;
  mctx.fillText(matchSet ? `${total} matching` : `${total} placed`, 12, MH / 2 + 8);
  const a = clamp(mx(view.t0), GUT, MW), b = clamp(mx(view.t0 + visYears()), GUT, MW);
  mctx.fillStyle = 'rgba(184,35,47,.13)'; mctx.fillRect(a, 0, Math.max(3, b - a), MH);
  mctx.strokeStyle = ACCENT; mctx.lineWidth = 1.5; mctx.strokeRect(a + 0.75, 0.75, Math.max(3, b - a) - 1.5, MH - 1.5);
}
{
  let drag = false;
  const go = e => {
    const r = mini.getBoundingClientRect();
    const yr = T_MIN + (e.clientX - r.left - GUT) / (MW - GUT - 8) * (T_MAX - T_MIN);
    anim = null; view.t0 = yr - visYears() / 2; clampView(); invalidate();
  };
  mini.addEventListener('pointerdown', e => { drag = true; mini.setPointerCapture(e.pointerId); go(e); });
  mini.addEventListener('pointermove', e => { if (drag) go(e); });
  mini.addEventListener('pointerup', () => { drag = false; });
}

/* ---------- navigation ---------- */
function animateTo(a, b, y) {
  const span = clamp(b - a, (W - GUT) / MAX_SCALE, T_MAX - T_MIN);
  const mid = (a + b) / 2; a = mid - span / 2; b = mid + span / 2;
  const from = { a: view.t0, b: view.t0 + visYears(), y: view.y };
  const to = { a, b, y: y === undefined ? view.y : y };
  if (reduceMotion) { apply(1); return; }
  const t0 = performance.now(), D = 420;
  anim = { id: t0 };
  const me = anim;
  function apply(k) {
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    // interpolate the span geometrically so zooming feels even
    const s0 = from.b - from.a, s1 = to.b - to.a, s = s0 * Math.pow(s1 / s0, e);
    const m = (from.a + from.b) / 2 + ((to.a + to.b) / 2 - (from.a + from.b) / 2) * e;
    view.scale = (W - GUT) / s; view.t0 = m - s / 2; view.y = from.y + (to.y - from.y) * e;
    clampView(); invalidate();
  }
  (function tick(now) {
    if (anim !== me) return;
    const k = Math.min(1, (now - t0) / D);
    apply(k);
    if (k < 1) requestAnimationFrame(tick); else anim = null;
  })(t0);
}
function zoomAt(x, factor) {
  anim = null;
  const yr = yearAt(x);
  view.scale = clamp(view.scale * factor, minScale(), MAX_SCALE);
  view.t0 = yr - (x - GUT) / view.scale;
  clampView(); invalidate();
}
function zoomBy(f) { const c = view.t0 + visYears() / 2, s = visYears() / f; animateTo(c - s / 2, c + s / 2); }
function laneYFor(L) {
  const vh = H - AXIS;
  if (L.y >= view.y && L.y + L.h <= view.y + vh) return view.y;
  return clamp(L.y - (vh - L.h) / 2, 0, Math.max(0, totalH - vh));
}
function focusEpisode(ep) {
  if (ep.th) return;
  const L = laneById[ep.l], span = ep.de - ep.ds;
  const want = ep.survey ? span * 1.5 : Math.max(span * 6, 30);
  const cur = visYears(), mid = ep.survey ? ep.ds + span / 2 : (ep.ds + ep.de) / 2;
  const inView = ep.ds >= view.t0 && Math.min(ep.de, ep.ds + cur * 0.6) <= view.t0 + cur;
  const y = laneYFor(L);
  if (cur <= want * 1.6 && inView) { if (y !== view.y) animateTo(view.t0, view.t0 + cur, y); return; }
  const s = Math.min(cur, want);
  animateTo(mid - s / 2, mid + s / 2, y);
}

/* ---------- pointer / wheel / keys ---------- */
function hitAt(x, y) {
  if (x < GUT || y < AXIS) return null;
  for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (x >= h.x - 2 && x <= h.x + h.w + 2 && y >= h.y && y <= h.y + h.h) return h.it; }
  return null;
}
function laneAt(y) { const yy = y - AXIS + view.y; return y < AXIS ? null : LANES.find(L => yy >= L.y && yy < L.y + L.h) || null; }
function barAt(x, y) {
  const L = laneAt(y); if (!L) return null;
  const yr = yearAt(x), r = (y - AXIS + view.y - L.y) / L.h * L.rows;
  for (let i = L.bars.length - 1; i >= 0; i--) { const b = L.bars[i]; if (yr >= b[1] && yr < b[2] && r >= b[3] && r < b[4]) return { bar: b, lane: L }; }
  return null;
}
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = clamp(x + 14, 4, W - tw - 4) + 'px';
  tip.style.top = (y + 18 + th > H ? y - th - 10 : y + 18) + 'px';
}
function epTip(ep) {
  return `<span class="k">${esc(fmtRange(ep.s, ep.e))} · ${esc(laneById[ep.l].name)}</span><b>${ep.n ? ep.n + '. ' : ''}${esc(ep.t)}</b><span class="l">${esc(ep.tp)}</span>`;
}
function clTip(it) {
  const L = it.groups.slice(0, 5).map(([g, n]) => `<span class="l">${esc(g)}${n > 1 ? ` <b>×${n}</b>` : ''}</span>`).join('');
  return `<span class="k">${esc(fmtCell(it.cs, it.cy))}</span><b>${it.eps.length} episodes</b>${L}${it.groups.length > 5 ? `<span class="l">+ ${it.groups.length - 5} more…</span>` : ''}`;
}
{
  let down = null;
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect();
    down = { x: e.clientX, y: e.clientY, t0: view.t0, vy: view.y, moved: false, lx: e.clientX - r.left, ly: e.clientY - r.top };
    cv.setPointerCapture(e.pointerId); anim = null; hideHint();
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true; cv.classList.add('dragging'); tip.hidden = true;
      if (down.lx >= GUT) view.t0 = down.t0 - dx / view.scale;
      view.y = down.vy - dy; clampView(); invalidate();
      return;
    }
    const it = hitAt(x, y);
    let h = null;
    if (it) { h = it.type === 'ep' ? { ep: it.ep } : { cl: it }; showTip(it.type === 'ep' ? epTip(it.ep) : clTip(it), x, y); }
    else if (x < GUT && y >= AXIS) { const L = laneAt(y); if (L) h = { lane: L }; tip.hidden = true; }
    else {
      const b = barAt(x, y);
      if (b) showTip(`<span class="k">${esc(b.lane.name)} · ${esc(FAM[b.bar[5]].name)}</span><b>${esc(b.bar[0])}</b><span class="l">${esc(fmtRange(b.bar[1], Math.min(b.bar[2], 2026)))}</span>`, x, y);
      else tip.hidden = true;
    }
    cv.classList.toggle('pointing', !!h);
    const same = (hovered && h) ? (hovered.ep === h.ep && hovered.lane === h.lane && hovered.cl === h.cl) : hovered === h;
    if (!same) { hovered = h; invalidate(); }
  });
  cv.addEventListener('pointerup', e => {
    cv.classList.remove('dragging');
    const d = down; down = null;
    if (!d || d.moved) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const it = hitAt(x, y);
    if (it && it.type === 'ep') select(it.ep, false);
    else if (it) openCluster(it);
    else if (x < GUT && y >= AXIS) { const L = laneAt(y); if (L) { expanded.has(L.id) ? expanded.delete(L.id) : expanded.add(L.id); laneMetrics(); clampView(); invalidate(); } }
  });
  cv.addEventListener('pointerleave', () => { tip.hidden = true; if (hovered) { hovered = null; invalidate(); } });
  cv.addEventListener('dblclick', e => { const r = cv.getBoundingClientRect(); if (e.clientX - r.left > GUT && !hitAt(e.clientX - r.left, e.clientY - r.top)) { const yr = yearAt(e.clientX - r.left), s = visYears() / 2.2; animateTo(yr - s / 2, yr + s / 2); } });
  cv.addEventListener('wheel', e => {
    e.preventDefault(); hideHint(); tip.hidden = true;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.shiftKey || x < GUT) { view.y += (e.deltaY || e.deltaX) * unit; anim = null; clampView(); invalidate(); }
    else if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { view.t0 += e.deltaX * unit / view.scale; anim = null; clampView(); invalidate(); }
    else zoomAt(Math.max(x, GUT), Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0022)));
  }, { passive: false });
}
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('#q').focus(); }
  else if (k === 'Escape') { if (!$('#legend').hidden) toggleLegend(false); else closePanel(); }
  else if (k === '+' || k === '=') zoomBy(1.8);
  else if (k === '-' || k === '_') zoomBy(1 / 1.8);
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { const d = visYears() * 0.25 * (k === 'ArrowLeft' ? -1 : 1); animateTo(view.t0 + d, view.t0 + d + visYears()); e.preventDefault(); }
  else if (k === 'ArrowUp' || k === 'ArrowDown') { view.y += k === 'ArrowUp' ? -80 : 80; clampView(); invalidate(); e.preventDefault(); }
});
function hideHint() { $('#hint').classList.add('gone'); }

/* ---------- side panel ---------- */
function openPanel(html) {
  panelBody.innerHTML = html; panel.scrollTop = 0;
  if (panel.hidden) { panel.hidden = false; resize(); }
}
function closePanel() {
  if (panel.hidden) return;
  panel.hidden = true; selected = null; history.replaceState(null, '', location.pathname + location.search); resize();
}
function metaLine(ep) {
  return `${ep.th ? 'Thematic' : esc(fmtRange(ep.s, ep.e))}${ep.th ? '' : ' · ' + esc(laneById[ep.l].name)} · ${fmtDur(ep.dur)}`;
}
function listHtml(eps, cur) {
  return `<ul class="list">${eps.map(ep => `<li class="${ep === cur ? 'cur' : ''}">
    <button class="row" data-ep="${ep.i}"><span class="t">${ep.n ? ep.n + '. ' : ''}${esc(ep.t)}</span><span class="m">${metaLine(ep)}</span></button>
    <button class="play" data-play="${ep.i}" aria-label="Play ${esc(ep.t)}" title="Play">▶</button></li>`).join('')}</ul>`;
}
function contextBars(ep) {
  if (ep.th || ep.survey) return [];
  const mid = (ep.ds + ep.de) / 2, out = [];
  for (const b of laneById[ep.l].bars) if (b[1] <= mid && mid < b[2] && !out.includes(b[0])) out.push(b[0]);
  return out.slice(-3);
}
function showEpisode(ep) {
  const L = laneById[ep.l], ser = ep.sr ? SERIES[ep.sr] : null;
  const civ = contextBars(ep).map(n => `<span class="chip civ">${esc(n)}</span>`).join('');
  const conf = ep.th ? 'No single period or place — not placed on the timeline.'
    : ep.c === 'h' ? '' : `Placement inferred from the description (${ep.c === 'm' ? 'medium' : 'low'} confidence).`;
  openPanel(`
    <p class="kicker">${ep.n ? 'Episode ' + ep.n : 'Bonus'} · ${esc(fmtDate(ep.date))} · ${fmtDur(ep.dur)}</p>
    <h2>${esc(ep.t)}</h2>
    <div class="place">${ep.th ? '<span class="chip where">Thematic</span>' : `<span class="chip when">${esc(fmtRange(ep.s, ep.e))}</span><span class="chip where">${esc(L.name)}</span>`}</div>
    ${civ ? `<div class="place then"><span class="lead">Then in the region</span>${civ}</div>` : ''}
    ${conf ? `<p class="note">${conf}</p>` : ''}
    <div class="actions">
      <button class="btn primary" data-play="${ep.i}">▶ Play episode</button>
      ${ep.th ? '' : `<button class="btn" data-focus="${ep.i}">Show on timeline</button>`}
    </div>
    <p class="desc">${esc(ep.d)}</p>
    <p class="links">Also on <a href="https://open.spotify.com/search/${encodeURIComponent('The Rest Is History ' + ep.t)}/episodes" target="_blank" rel="noopener">Spotify ↗</a> ·
      <a href="https://therestishistory.com/episodes" target="_blank" rel="noopener">therestishistory.com ↗</a></p>
    ${ser ? `<p class="sect">Series · ${esc(ep.sr)} · ${ser.length} episodes</p>${listHtml(ser, ep)}` : ''}`);
}
function showList(kicker, title, eps, grouped) {
  let body;
  if (!eps.length) body = '<p class="empty">No episodes.</p>';
  else if (grouped) {
    const g = new Map();
    for (const ep of eps) { const k = ep.sr || ''; if (!g.has(k)) g.set(k, []); g.get(k).push(ep); }
    body = [...g.entries()].map(([k, l]) => (k ? `<p class="grp">${esc(k)}</p>` : g.size > 1 ? '<p class="grp">Single episodes</p>' : '') + listHtml(l, selected)).join('');
  } else body = listHtml(eps, selected);
  openPanel(`<p class="kicker">${esc(kicker)}</p><h2>${esc(title)}</h2>${body}`);
}
function select(ep, focus) {
  selected = ep; showEpisode(ep);
  history.replaceState(null, '', '#ep=' + (ep.n || 'i' + ep.i));
  if (focus) focusEpisode(ep);
  invalidate();
}
function openCluster(it) {
  const L = laneById[it.eps[0].l];
  selected = null;
  showList(`${L.name} · ${fmtCell(it.cs, it.cy)}`, `${it.eps.length} episodes`, [...it.eps].sort((a, b) => a.ds - b.ds || a.i - b.i), true);
  const lo = Math.min(...it.eps.map(e => e.ds)), hi = Math.max(...it.eps.map(e => e.survey ? e.ds + 1 : e.de));
  const span = Math.max(hi - lo, 1) * 1.6 + 2;
  if (span < visYears() * 0.8) animateTo((lo + hi) / 2 - span / 2, (lo + hi) / 2 + span / 2, laneYFor(L));
  invalidate();
}
function play(ep) {
  playing = ep;
  if (audio.dataset.i !== String(ep.i)) { audio.src = ep.a; audio.dataset.i = ep.i; }
  $('#now-title').textContent = (ep.n ? ep.n + '. ' : '') + ep.t;
  if (player.hidden) { player.hidden = false; resize(); }
  audio.play().catch(() => {});
  invalidate();
}
panelBody.addEventListener('click', e => {
  const b = e.target.closest('[data-ep],[data-play],[data-focus]'); if (!b) return;
  if (b.dataset.play !== undefined) play(EPS[+b.dataset.play]);
  else if (b.dataset.focus !== undefined) focusEpisode(EPS[+b.dataset.focus]);
  else select(EPS[+b.dataset.ep], true);
});
$('#panel-close').addEventListener('click', closePanel);
$('#player-close').addEventListener('click', () => { audio.pause(); player.hidden = true; playing = null; resize(); });
$('#now-title').addEventListener('click', () => { if (playing) select(playing, true); });

/* ---------- search, toolbar ---------- */
function setQuery(q) {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  matchSet = terms.length ? new Set(EPS.filter(ep => terms.every(t => ep.hay.includes(t)))) : null;
  for (const L of LANES) L.eps = matchSet ? L.all.filter(ep => matchSet.has(ep)) : L.all;
  layoutVersion++;
  $('#qcount').textContent = matchSet ? `${matchSet.size} / ${EPS.length}` : '';
  if (matchSet) {
    selected = null;
    const res = [...matchSet].sort((a, b) => (a.th - b.th) || a.ds - b.ds || a.i - b.i);
    showList('Search', `${res.length} episode${res.length === 1 ? '' : 's'} matching “${q.trim()}”`, res, false);
  }
  invalidate();
}
{
  let t;
  $('#q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => setQuery(e.target.value), 140); });
}
$('#eras').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const [a, z] = b.dataset.range.split(',').map(Number); animateTo(a, z); hideHint(); });
$('#btn-in').addEventListener('click', () => zoomBy(1.8));
$('#btn-out').addEventListener('click', () => zoomBy(1 / 1.8));
$('#btn-fit').addEventListener('click', e => {
  fitMode = !fitMode; e.currentTarget.setAttribute('aria-pressed', fitMode);
  laneMetrics(); clampView(); invalidate();
});
$('#btn-thematic').addEventListener('click', () => { selected = null; showList('Not on the timeline', `${THEMATIC.length} thematic episodes`, THEMATIC, false); invalidate(); });
$('#n-thematic').textContent = THEMATIC.length;
function toggleLegend(on) {
  const el = $('#legend'); el.hidden = on === undefined ? !el.hidden : !on;
  $('#btn-legend').setAttribute('aria-expanded', !el.hidden);
}
$('#btn-legend').addEventListener('click', () => toggleLegend());
$('#legend').innerHTML = `
  <h3>Episodes</h3>
  <ul>
    <li><span class="mk"><span class="dot"></span></span>One episode, at the year it covers</li>
    <li><span class="mk"><span class="pill"></span></span>Episode spanning several years</li>
    <li><span class="mk"><span class="cl">12</span></span>Cluster — click to zoom in &amp; list</li>
  </ul>
  <h3>Civilizations by language family</h3>
  <ul>${Object.values(FAM).filter(f => !f.hidden).map(f => `<li><span class="sw" style="background:${f.color}"></span>${esc(f.name)}</li>`).join('')}</ul>
  <p>Backdrop adapted from the “World History Timeline – Decade by Decade” chart. Episode periods and regions are inferred from titles and descriptions. Click a region name to enlarge its lane.</p>`;

/* ---------- boot ---------- */
new ResizeObserver(resize).observe(cv.parentElement);
window.addEventListener('resize', resize);
resize();
view.scale = minScale(); view.t0 = T_MIN; clampView();
{
  const m = /^#ep=(i?)(\d+)$/.exec(location.hash);
  const ep = m && (m[1] ? EPS[+m[2]] : EPS.find(e => e.n === +m[2]));
  if (ep) select(ep, true);
}
setTimeout(hideHint, 9000);
invalidate();
window.__tl = { view, LANES, EPS, select, animateTo, hits: () => hits };
})();
