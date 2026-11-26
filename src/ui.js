// Shared DOM and formatting helpers.
import { fifthsPosition, isMinor } from './keys.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function keyColor(key, alpha = 1) {
  if (key == null) return `hsla(230, 8%, 55%, ${alpha})`;
  const hue = (fifthsPosition(key) * 30 + 250) % 360;
  return isMinor(key) ? `hsla(${hue}, 48%, 44%, ${alpha})` : `hsla(${hue}, 72%, 62%, ${alpha})`;
}

export function keyTextColor(key) {
  return key == null || isMinor(key) ? '#ffffff' : '#14141c';
}

// ---------- key notation ----------
// 'camelot' (6A), 'musical' (G minor) or 'both'.
let notation = 'camelot';
export const NOTATIONS = { camelot: 'Camelot', musical: 'Key', both: 'Both' };

export function setNotation(n) {
  notation = NOTATIONS[n] ? n : 'camelot';
}

export function getNotation() {
  return notation;
}

/** Key as running text in the chosen notation, e.g. "6A", "G minor" or "G minor (6A)". */
export function keyText(info) {
  if (!info) return '…';
  if (info.key == null) return info.kind === 'silence' ? 'Silence' : 'No key';
  if (notation === 'camelot') return info.camelot;
  if (notation === 'musical') return info.name;
  return `${info.name} (${info.camelot})`;
}

/** Short label for tight spaces (canvas, compact chips). */
export function keyShort(info) {
  if (!info) return '…';
  if (info.key == null) return info.kind === 'silence' ? 'Silence' : 'No key';
  if (notation === 'camelot') return info.camelot;
  if (notation === 'musical') return info.short;
  return `${info.short} ${info.camelot}`;
}

/** Sort value for a key in the current notation (wheel order for Camelot, pitch order for names). */
export function keySortValue(info) {
  if (!info || info.key == null) return 99;
  if (notation === 'musical') return (info.key % 12) * 2 + (info.key >= 12 ? 1 : 0);
  const m = /^(\d+)([AB])$/.exec(info.camelot);
  return Number(m[1]) * 2 + (m[2] === 'B' ? 1 : 0);
}

// ---------- confidence ----------
export const CERTAINTY_LABEL = { definite: 'Definite', likely: 'Likely', uncertain: 'Unsure' };

const pct = (p) => `${Math.round(p * 100)}%`;

/** Plain-language confidence, e.g. "Probably 6A (72%), but it might be 11B (20%)". */
export function describeCertainty(info) {
  if (!info || info.key == null || !info.certainty) return info ? keyText(info) : '';
  const alts = (info.alternatives || []).filter((a) => a.probability >= 0.05);
  const main = `${keyText(info)} (${pct(info.confidence)})`;
  const altText = alts.map((a) => `${keyText(a)} (${pct(a.probability)})`).join(' or ');
  if (info.certainty === 'definite') return `Definitely ${main}`;
  if (info.certainty === 'likely') return altText ? `Probably ${main}, but it might be ${altText}` : `Probably ${main}`;
  return altText ? `Unsure: ${main} or ${altText}` : `Unsure: ${main}, weak tonal evidence`;
}

/** A small badge: "Definite", "Likely · or 11B", "Unsure · 6A / 11B". */
export function certaintyBadge(info, { withAlternatives = true } = {}) {
  if (!info || info.key == null || !info.certainty) return null;
  const alt = (info.alternatives || []).filter((a) => a.probability >= 0.05);
  let text = CERTAINTY_LABEL[info.certainty];
  if (withAlternatives && info.certainty === 'likely' && alt[0]) text += ` · or ${keyShort(alt[0])}`;
  if (withAlternatives && info.certainty === 'uncertain') text += ` · ${[info, ...alt.slice(0, 2)].map(keyShort).join(' / ')}`;
  return el('span', { class: `cert-badge cert-${info.certainty}`, title: describeCertainty(info) }, text);
}

/** A coloured pill for a key, or a striped grey pill for "no key"/silence. */
export function keyChip(info, { compact = false, title } = {}) {
  if (!info) return el('span', { class: 'key-chip pending' }, '…');
  if (info.key == null) {
    return el(
      'span',
      { class: `key-chip nokey ${info.kind === 'silence' ? 'silence' : ''}`, title: title || (info.kind === 'silence' ? 'Silence' : 'No key: atonal, percussive or unpitched') },
      info.kind === 'silence' ? 'Silence' : 'No key',
    );
  }
  const uncertain = info.certainty === 'uncertain';
  let main;
  let sub = null;
  if (notation === 'camelot') main = info.camelot;
  else if (notation === 'musical') main = compact ? info.short : info.name;
  else {
    main = compact ? info.short : info.name;
    sub = info.camelot;
  }
  return el(
    'span',
    {
      class: `key-chip ${uncertain ? 'uncertain' : ''}`,
      style: `background:${keyColor(info.key)};color:${keyTextColor(info.key)}`,
      title: title || (info.certainty ? describeCertainty(info) : `${info.name} (${info.camelot})`),
    },
    main,
    sub ? el('span', { class: 'cam' }, sub) : null,
    uncertain ? el('span', { class: 'q', 'aria-label': 'uncertain' }, '?') : null,
  );
}

/** Candidate keys with probability bars, for the track view. */
export function candidateBars(info) {
  const list = [info, ...(info.alternatives || []).filter((c) => c.probability == null || c.probability >= 0.01)].filter((c) => c && c.key != null);
  return el(
    'div',
    { class: 'candidates' },
    list.map((c, i) => {
      const p = i === 0 ? info.confidence : c.probability;
      return el(
        'div',
        { class: 'cand' },
        keyChip({ ...c, certainty: null }, { compact: true }),
        el('span', { class: 'cand-bar' }, el('span', { style: `width:${Math.max(2, Math.round(p * 100))}%;background:${keyColor(c.key)}` })),
        el('span', { class: 'cand-pct' }, pct(p)),
      );
    }),
  );
}

/** Fills a canvas region with diagonal stripes (used for no-key sections). */
export function drawStripes(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  for (let i = x - h; i < x + w; i += 9) {
    ctx.beginPath();
    ctx.moveTo(i, y + h);
    ctx.lineTo(i + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Paints section colours (and stripes for no-key sections) across a canvas strip. */
export function paintSections(ctx, sections, duration, x, y, w, h, alpha = 1) {
  for (const s of sections) {
    const x0 = x + (s.start / duration) * w;
    const x1 = x + (s.end / duration) * w;
    ctx.fillStyle = keyColor(s.key, s.key == null ? alpha * 0.35 : alpha);
    ctx.fillRect(x0, y, x1 - x0, h);
    if (s.key == null && s.kind !== 'silence') drawStripes(ctx, x0, y, x1 - x0, h, keyColor(null, alpha * 0.45));
  }
}

export function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toast(message, ms = 2600) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  // Only the latest message is shown, so rapid actions don't stack up over the page.
  host.replaceChildren();
  const t = el('div', { class: 'toast' }, message);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}
