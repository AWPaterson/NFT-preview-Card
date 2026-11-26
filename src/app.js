import { fifthsPosition, isMinor } from './keys.js';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  input: $('file-input'),
  reanalyze: $('reanalyze'),
  status: $('status'),
  statusText: $('status-text'),
  statusPct: $('status-pct'),
  progressBar: $('progress-bar'),
  error: $('error'),
  results: $('results'),
  fileName: $('file-name'),
  fileMeta: $('file-meta'),
  summary: $('summary-body'),
  timeline: $('timeline'),
  wave: $('wave'),
  rawStrip: $('raw-strip'),
  hoverTip: $('hover-tip'),
  axis: $('axis'),
  legend: $('legend'),
  player: $('player'),
  changesCard: $('changes-card'),
  changes: $('changes'),
  sections: $('sections'),
  tuningNote: $('tuning-note'),
  exportCsv: $('export-csv'),
  exportJson: $('export-json'),
  optSensitivity: $('opt-sensitivity'),
  optMin: $('opt-min'),
  optProfile: $('opt-profile'),
};

const ACCEPTED = /\.(flac|wav|wave|mp3)$/i;

const state = {
  file: null,
  mono: null,
  sampleRate: 0,
  channels: 0,
  peaks: null,
  result: null,
  objectUrl: null,
  jobId: 0,
};

// ---------- helpers ----------

function formatTime(sec, precise = false) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = precise ? (sec % 60).toFixed(1).padStart(4, '0') : String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function keyColor(key, alpha = 1) {
  const hue = (fifthsPosition(key) * 30 + 250) % 360;
  return isMinor(key) ? `hsla(${hue}, 48%, 44%, ${alpha})` : `hsla(${hue}, 72%, 62%, ${alpha})`;
}

function keyTextColor(key) {
  return isMinor(key) ? '#ffffff' : '#14141c';
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function keyChip(info) {
  return el(
    'span',
    { class: 'key-chip', style: `background:${keyColor(info.key)};color:${keyTextColor(info.key)}` },
    info.name,
    el('span', { class: 'cam' }, info.camelot),
  );
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.status.hidden = true;
}

function setProgress(fraction, message) {
  els.status.hidden = false;
  els.statusText.textContent = message;
  const pct = Math.round(fraction * 100);
  els.statusPct.textContent = `${pct}%`;
  els.progressBar.style.width = `${pct}%`;
}

function currentOptions() {
  return {
    sensitivity: els.optSensitivity.value,
    minSectionSec: Number(els.optMin.value),
    profile: els.optProfile.value,
  };
}

// ---------- file handling ----------

async function handleFile(file) {
  if (!file) return;
  els.error.hidden = true;
  if (!ACCEPTED.test(file.name) && !/audio\/(flac|x-flac|wav|x-wav|wave|mpeg|mp3)/.test(file.type)) {
    showError(`"${file.name}" isn't a supported file. Please choose a FLAC, WAV or MP3 file.`);
    return;
  }

  state.jobId++;
  const job = state.jobId;
  state.file = file;
  state.result = null;
  els.results.hidden = true;
  els.reanalyze.disabled = true;
  setProgress(0, 'Reading file…');

  try {
    const buffer = await file.arrayBuffer();
    if (job !== state.jobId) return;
    setProgress(0.01, 'Decoding audio…');
    const audio = await decode(buffer);
    if (job !== state.jobId) return;

    state.sampleRate = audio.sampleRate;
    state.channels = audio.numberOfChannels;
    state.mono = toMono(audio);
    state.peaks = null;

    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    els.player.src = state.objectUrl;

    await runAnalysis(job);
  } catch (err) {
    if (job !== state.jobId) return;
    console.error(err);
    showError(
      `Couldn't decode "${file.name}". The file may be damaged, or this browser may not support its format` +
      ` (FLAC needs a recent Chrome, Edge, Firefox or Safari).`,
    );
  }
}

async function decode(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    if (ctx.close) ctx.close();
  }
}

function toMono(audio) {
  const n = audio.length;
  const out = new Float32Array(n);
  const chs = audio.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (chs > 1) for (let i = 0; i < n; i++) out[i] /= chs;
  return out;
}

// ---------- analysis ----------

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function analyzeInWorker(samples, sampleRate, options, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = getWorker();
    } catch (err) {
      reject(err);
      return;
    }
    const id = Math.random();
    const onMessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.fraction, e.data.message);
      else {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        if (e.data.type === 'result') resolve(e.data.result);
        else reject(new Error(e.data.message));
      }
    };
    const onError = (e) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      worker = null;
      reject(e.error || new Error(e.message || 'Worker failed'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const copy = samples.slice();
    w.postMessage({ id, samples: copy, sampleRate, options }, [copy.buffer]);
  });
}

async function analyzeOnMainThread(samples, sampleRate, options, onProgress) {
  const { analyzeKeys } = await import('./analyzer.js');
  onProgress(0.05, 'Analyzing…');
  await new Promise((r) => setTimeout(r, 30));
  return analyzeKeys(samples, sampleRate, options);
}

async function runAnalysis(job = state.jobId) {
  const options = currentOptions();
  const onProgress = (f, m) => {
    if (job === state.jobId) setProgress(f, m);
  };
  setProgress(0.02, 'Analyzing…');
  let result;
  try {
    result = await analyzeInWorker(state.mono, state.sampleRate, options, onProgress);
  } catch (err) {
    console.warn('Worker analysis failed, falling back to main thread', err);
    result = await analyzeOnMainThread(state.mono, state.sampleRate, options, onProgress);
  }
  if (job !== state.jobId) return;
  state.result = result;
  els.status.hidden = true;
  els.reanalyze.disabled = false;
  render();
}

// ---------- rendering ----------

function render() {
  const r = state.result;
  const file = state.file;
  els.results.hidden = false;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = [
    formatTime(r.duration),
    `${(state.sampleRate / 1000).toFixed(1)} kHz`,
    state.channels === 1 ? 'mono' : state.channels === 2 ? 'stereo' : `${state.channels} channels`,
    `${(file.size / 1048576).toFixed(1)} MB`,
  ].join(' · ');

  renderSummary(r);
  renderChanges(r);
  renderSections(r);
  renderLegend(r);
  renderAxis(r);
  drawAll();

  els.tuningNote.textContent = r.silent
    ? ''
    : Math.abs(r.tuningCents) < 5
      ? 'This recording is tuned to standard A440.'
      : `This recording is tuned ${Math.abs(r.tuningCents)} cents ${r.tuningCents > 0 ? 'sharp' : 'flat'} of A440; the analysis compensates for that.`;
}

function renderSummary(r) {
  els.summary.replaceChildren();
  if (r.silent) {
    els.summary.append(el('p', { class: 'summary-text' }, 'No musical content was found. The file appears to be silent.'));
    return;
  }
  if (r.changes.length === 0) {
    const s = r.sections[0];
    els.summary.append(
      el('div', { class: 'big-key' }, keyChip(s)),
      el('p', { class: 'summary-text' }, `The whole song stays in ${s.name}. No key changes were detected.`),
    );
    return;
  }
  const journey = el('div', { class: 'journey big-key' });
  r.sections.forEach((s, i) => {
    if (i > 0) journey.append(el('span', { class: 'arrow' }, '→'));
    journey.append(keyChip(s));
  });
  const n = r.changes.length;
  const distinct = new Set(r.sections.map((s) => s.key)).size;
  els.summary.append(
    journey,
    el(
      'p',
      { class: 'summary-text' },
      `${n} key change${n === 1 ? '' : 's'} across ${distinct} key${distinct === 1 ? '' : 's'}. ` +
      `Starts in ${r.sections[0].name} and ends in ${r.sections[r.sections.length - 1].name}. ` +
      `Most of the song is in ${r.overall.name}.`,
    ),
  );
}

function playFrom(t) {
  els.player.currentTime = Math.max(0, t);
  els.player.play().catch(() => {});
}

function renderChanges(r) {
  els.changes.replaceChildren();
  if (r.silent) {
    els.changesCard.hidden = true;
    return;
  }
  els.changesCard.hidden = false;
  if (r.changes.length === 0) {
    els.changes.append(el('li', {}, el('p', { class: 'no-changes' }, `No key changes. The song is in ${r.sections[0].name} throughout.`)));
    return;
  }
  for (const c of r.changes) {
    const desc = [c.movement, c.relation].filter(Boolean).join(' · ');
    els.changes.append(
      el(
        'li',
        { class: 'change' },
        el('span', { class: 'change-time' }, formatTime(c.time)),
        el('div', { class: 'journey' }, keyChip(c.from), el('span', { class: 'arrow' }, '→'), keyChip(c.to)),
        el('span', { class: 'change-desc' }, desc),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => playFrom(c.time - 5) }, '▶ Hear it'),
      ),
    );
  }
}

function renderSections(r) {
  els.sections.replaceChildren();
  r.sections.forEach((s, i) => {
    const pct = Math.round(s.confidence * 100);
    const alt = s.alternatives[0];
    els.sections.append(
      el(
        'tr',
        { 'data-index': i },
        el('td', {}, i + 1),
        el('td', {}, `${formatTime(s.start)} – ${formatTime(s.end)}`),
        el('td', {}, keyChip(s)),
        el('td', {}, s.camelot),
        el('td', {}, el('span', { class: 'conf' }, el('span', { class: 'conf-bar' }, el('div', { style: `width:${pct}%` })), `${pct}%`)),
        el('td', { class: 'runner' }, alt ? alt.name : '–'),
        el('td', {}, el('button', { class: 'play-btn', type: 'button', 'aria-label': `Play section ${i + 1}`, onclick: () => playFrom(s.start) }, '▶')),
      ),
    );
  });
}

function renderLegend(r) {
  els.legend.replaceChildren();
  const seen = new Set();
  for (const s of r.sections) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    els.legend.append(keyChip(s));
  }
}

function renderAxis(r) {
  els.axis.replaceChildren();
  const d = r.duration;
  const steps = [5, 10, 15, 30, 60, 120, 300];
  const width = els.timeline.clientWidth || 600;
  const target = Math.max(2, Math.floor(width / 80));
  const step = steps.find((s) => d / s <= target) || 600;
  for (let t = 0; t <= d - step * 0.5; t += step) {
    els.axis.append(el('span', { style: `left:${(t / d) * 100}%` }, formatTime(t)));
  }
  els.axis.append(el('span', { style: 'left:100%' }, formatTime(d)));
}

function computePeaks(width) {
  const data = state.mono;
  const per = data.length / width;
  const mins = new Float32Array(width);
  const maxs = new Float32Array(width);
  let globalMax = 1e-9;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * per);
    const end = Math.min(data.length, Math.floor((x + 1) * per));
    let lo = 0;
    let hi = 0;
    const stride = Math.max(1, Math.floor((end - start) / 400));
    for (let i = start; i < end; i += stride) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[x] = lo;
    maxs[x] = hi;
    globalMax = Math.max(globalMax, -lo, hi);
  }
  return { width, mins, maxs, globalMax };
}

function setupCanvas(canvas) {
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawWave() {
  const r = state.result;
  if (!r || !state.mono) return;
  const { ctx, w, h } = setupCanvas(els.wave);
  const d = r.duration;
  ctx.clearRect(0, 0, w, h);

  // Section backgrounds
  for (const s of r.sections) {
    const x0 = (s.start / d) * w;
    const x1 = (s.end / d) * w;
    ctx.fillStyle = keyColor(s.key, 0.32);
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = keyColor(s.key, 0.95);
    ctx.fillRect(x0, 0, x1 - x0, 22);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, 22);
    ctx.clip();
    ctx.fillStyle = keyTextColor(s.key);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = x1 - x0 > 90 ? `${s.name} · ${s.camelot}` : s.short;
    ctx.fillText(label, x0 + 6, 11);
    ctx.restore();
  }

  // Waveform
  const cols = Math.max(1, Math.floor(w));
  if (!state.peaks || state.peaks.width !== cols) state.peaks = computePeaks(cols);
  const { mins, maxs, globalMax } = state.peaks;
  const top = 26;
  const mid = top + (h - top) / 2;
  const amp = ((h - top) / 2 - 4) / globalMax;
  ctx.fillStyle = cssVar('--wave');
  for (let x = 0; x < cols; x++) {
    const y0 = mid - maxs[x] * amp;
    const y1 = mid - mins[x] * amp;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }

  // Change markers
  ctx.strokeStyle = cssVar('--playhead');
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  for (const c of r.changes) {
    const x = Math.round((c.time / d) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 22);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Playhead
  const t = els.player.currentTime || 0;
  if (t > 0) {
    const x = (t / d) * w;
    ctx.fillStyle = cssVar('--playhead');
    ctx.fillRect(x - 1, 0, 2, h);
  }
}

function drawRawStrip() {
  const r = state.result;
  if (!r) return;
  const { ctx, w, h } = setupCanvas(els.rawStrip);
  ctx.clearRect(0, 0, w, h);
  const d = r.duration;
  for (const b of r.timeline) {
    if (b.key == null) continue;
    const x0 = (b.time / d) * w;
    const x1 = (Math.min(d, b.time + r.blockSec) / d) * w;
    ctx.fillStyle = keyColor(b.key, 0.35 + 0.65 * Math.max(0, Math.min(1, b.score)));
    ctx.fillRect(x0, 0, x1 - x0 + 0.5, h);
  }
}

function drawAll() {
  drawWave();
  drawRawStrip();
}

function highlightPlayingSection() {
  const r = state.result;
  if (!r) return;
  const t = els.player.currentTime;
  const idx = r.sections.findIndex((s) => t >= s.start && t < s.end);
  for (const row of els.sections.children) row.classList.toggle('playing', Number(row.dataset.index) === idx && t > 0);
}

// ---------- interaction ----------

function timeAt(clientX) {
  const rect = els.timeline.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return { frac, time: frac * (state.result ? state.result.duration : 0), rect };
}

els.timeline.addEventListener('click', (e) => {
  if (!state.result) return;
  playFrom(timeAt(e.clientX).time);
});

els.timeline.addEventListener('mousemove', (e) => {
  const r = state.result;
  if (!r) return;
  const { frac, time } = timeAt(e.clientX);
  const s = r.sections.find((sec) => time >= sec.start && time < sec.end) || r.sections[r.sections.length - 1];
  els.hoverTip.hidden = false;
  els.hoverTip.style.left = `${Math.max(8, Math.min(92, frac * 100))}%`;
  els.hoverTip.textContent = s ? `${formatTime(time)} · ${s.name}` : formatTime(time);
});
els.timeline.addEventListener('mouseleave', () => {
  els.hoverTip.hidden = true;
});

let raf = 0;
function tick() {
  drawWave();
  highlightPlayingSection();
  raf = els.player.paused ? 0 : requestAnimationFrame(tick);
}
els.player.addEventListener('play', () => {
  if (!raf) raf = requestAnimationFrame(tick);
});
els.player.addEventListener('seeked', tick);
els.player.addEventListener('timeupdate', () => {
  if (els.player.paused) tick();
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.result) return;
    renderAxis(state.result);
    drawAll();
  }, 100);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawAll);

els.input.addEventListener('change', () => {
  handleFile(els.input.files[0]);
  els.input.value = '';
});

['dragenter', 'dragover'].forEach((type) =>
  window.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragging');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop' || e.target === document.documentElement || !e.relatedTarget) els.dropzone.classList.remove('dragging');
  }),
);
window.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

els.reanalyze.addEventListener('click', async () => {
  if (!state.mono) return;
  state.jobId++;
  els.reanalyze.disabled = true;
  els.error.hidden = true;
  try {
    await runAnalysis(state.jobId);
  } catch (err) {
    showError(`Analysis failed: ${err.message}`);
    els.reanalyze.disabled = false;
  }
});

// ---------- export ----------

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName() {
  return (state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'song') + '-keys';
}

els.exportCsv.addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const rows = [['section', 'start_sec', 'end_sec', 'start', 'end', 'key', 'camelot', 'confidence', 'runner_up']];
  r.sections.forEach((s, i) =>
    rows.push([i + 1, s.start.toFixed(1), s.end.toFixed(1), formatTime(s.start), formatTime(s.end), s.name, s.camelot, s.confidence.toFixed(2), s.alternatives[0]?.name ?? '']),
  );
  const csv = rows.map((row) => row.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  download(`${baseName()}.csv`, 'text/csv', csv);
});

els.exportJson.addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const { timeline, ...rest } = r;
  download(`${baseName()}.json`, 'application/json', JSON.stringify({ file: state.file.name, ...rest }, null, 2));
});
