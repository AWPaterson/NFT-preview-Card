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
  return el(
    'span',
    { class: 'key-chip', style: `background:${keyColor(info.key)};color:${keyTextColor(info.key)}`, title: title || `${info.name} (${info.camelot})` },
    compact ? info.camelot : info.name,
    compact ? null : el('span', { class: 'cam' }, info.camelot),
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
