// Key and key-change detection.
//
// Pipeline:
//   1. Downsample the mono signal to ~11 kHz (anti-aliased FIR).
//   2. Short-time FFT; pick spectral peaks between ~60 Hz and ~2 kHz.
//   3. Estimate the recording's tuning offset from A440 and compensate for it.
//   4. Fold peaks into a 12-bin chromagram, pooled into 1-second blocks.
//   5. Correlate (lightly time-smoothed) chroma against 24 major/minor key profiles.
//   6. Viterbi decoding over the 24 keys with a key-change penalty gives stable sections.
//   7. Merge sections that are too short, re-estimate each section's key from all
//      of its audio, and refine the boundary positions.

import { fft } from './fft.js';
import {
  KEY_COUNT, buildTemplates, correlateKeys, keyName, shortKeyName, camelot, describeChange,
} from './keys.js';

const TARGET_RATE = 11025;
const F_MIN = 60;
const F_MAX = 2000;
const BLOCK_SEC = 1;

export const SENSITIVITY_PENALTY = { low: 9, medium: 5, high: 2.5 };

export const DEFAULT_OPTIONS = {
  profile: 'combined',
  sensitivity: 'medium',
  minSectionSec: 12,
};

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function downsample(samples, sampleRate) {
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  if (factor === 1) return { data: samples, rate: sampleRate };

  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.45 / factor; // normalised to the input rate
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  const len = samples.length;
  for (let o = 0; o < outLen; o++) {
    const c = o * factor;
    let acc = 0;
    const lo = c - half;
    if (lo >= 0 && c + half < len) {
      for (let i = 0; i < taps; i++) acc += samples[lo + i] * h[i];
    } else {
      for (let i = 0; i < taps; i++) {
        const idx = lo + i;
        if (idx >= 0 && idx < len) acc += samples[idx] * h[i];
      }
    }
    out[o] = acc;
  }
  return { data: out, rate: sampleRate / factor };
}

function nextPow2(x) {
  let n = 1;
  while (n < x) n <<= 1;
  return n;
}

// Returns per-frame spectral peaks (as fractional MIDI pitch + magnitude) and RMS energy.
function extractPeaks(data, rate, progress) {
  const N = nextPow2(rate * 0.7);
  const hop = N / 4;
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const binHz = rate / N;
  const kMin = Math.max(2, Math.floor(F_MIN / binHz));
  const kMax = Math.min(N / 2 - 2, Math.ceil(F_MAX / binHz));
  const frameCount = data.length >= N ? Math.floor((data.length - N) / hop) + 1 : (data.length > 0 ? 1 : 0);

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(kMax + 2);
  const frames = [];

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const s = start + i < data.length ? data[start + i] : 0;
      energy += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    fft(re, im);

    let frameMax = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      if (mag[k] > frameMax) frameMax = mag[k];
    }

    const pitches = [];
    const mags = [];
    const floor = frameMax * 0.005;
    for (let k = kMin; k <= kMax; k++) {
      const b = mag[k];
      if (b <= floor || b < mag[k - 1] || b < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12);
      const lb = Math.log(b + 1e-12);
      const c = Math.log(mag[k + 1] + 1e-12);
      const denom = a - 2 * lb + c;
      const p = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      const freq = (k + Math.max(-0.5, Math.min(0.5, p))) * binHz;
      pitches.push(69 + 12 * Math.log2(freq / 440));
      mags.push(b);
    }

    frames.push({
      time: (start + N / 2) / rate,
      rms: Math.sqrt(energy / N),
      pitches,
      mags,
    });

    if (progress && f % 64 === 0) progress(0.1 + 0.6 * (f / frameCount), 'Computing spectrum…');
  }
  return { frames, hopSec: hop / rate };
}

// Circular mean of peak deviations from the equal-tempered grid, in semitones (-0.5..0.5).
function estimateTuning(frames) {
  let sx = 0;
  let sy = 0;
  for (const fr of frames) {
    for (let i = 0; i < fr.pitches.length; i++) {
      const d = fr.pitches[i] - Math.round(fr.pitches[i]);
      const w = fr.mags[i];
      sx += w * Math.cos(2 * Math.PI * d);
      sy += w * Math.sin(2 * Math.PI * d);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

function buildBlocks(frames, tuning, duration) {
  const blockCount = Math.max(1, Math.ceil(duration / BLOCK_SEC));
  const chroma = Array.from({ length: blockCount }, () => new Float64Array(12));
  const energy = new Float64Array(blockCount);
  const counts = new Float64Array(blockCount);

  let maxRms = 0;
  for (const fr of frames) if (fr.rms > maxRms) maxRms = fr.rms;
  const silence = maxRms * 0.01; // -40 dB below the loudest frame

  for (const fr of frames) {
    const b = Math.min(blockCount - 1, Math.floor(fr.time / BLOCK_SEC));
    counts[b]++;
    if (fr.rms < silence) continue;
    energy[b] += fr.rms;
    for (let i = 0; i < fr.pitches.length; i++) {
      const m = fr.pitches[i] - tuning;
      const n = Math.round(m);
      const w = Math.cos(Math.PI * (m - n)) ** 2;
      chroma[b][((n % 12) + 12) % 12] += Math.sqrt(fr.mags[i]) * w;
    }
  }

  const active = new Uint8Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    if (counts[b] > 0) energy[b] /= counts[b];
    let total = 0;
    for (let i = 0; i < 12; i++) total += chroma[b][i];
    if (total > 0 && energy[b] > 0) {
      for (let i = 0; i < 12; i++) chroma[b][i] /= total;
      active[b] = 1;
    }
  }
  return { chroma, active, energy };
}

function smoothChroma(chroma, active, radius) {
  const out = [];
  for (let b = 0; b < chroma.length; b++) {
    const acc = new Float64Array(12);
    for (let d = -radius; d <= radius; d++) {
      const j = b + d;
      if (j < 0 || j >= chroma.length || !active[j]) continue;
      const w = radius + 1 - Math.abs(d);
      for (let i = 0; i < 12; i++) acc[i] += chroma[j][i] * w;
    }
    out.push(acc);
  }
  return out;
}

function viterbi(emissions, penalty) {
  const T = emissions.length;
  const score = new Float64Array(KEY_COUNT);
  const back = Array.from({ length: T }, () => new Uint8Array(KEY_COUNT));
  for (let k = 0; k < KEY_COUNT; k++) score[k] = emissions[0][k];

  const next = new Float64Array(KEY_COUNT);
  for (let t = 1; t < T; t++) {
    let best = 0;
    for (let k = 1; k < KEY_COUNT; k++) if (score[k] > score[best]) best = k;
    const switchScore = score[best] - penalty;
    for (let k = 0; k < KEY_COUNT; k++) {
      if (score[k] >= switchScore) {
        next[k] = score[k];
        back[t][k] = k;
      } else {
        next[k] = switchScore;
        back[t][k] = best;
      }
      next[k] += emissions[t][k];
    }
    score.set(next);
  }

  let k = 0;
  for (let j = 1; j < KEY_COUNT; j++) if (score[j] > score[k]) k = j;
  const path = new Uint8Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = k;
    k = back[t][k];
  }
  return path;
}

function pathToSegments(path) {
  const segs = [];
  let start = 0;
  for (let t = 1; t <= path.length; t++) {
    if (t === path.length || path[t] !== path[start]) {
      segs.push({ start, end: t, key: path[start] });
      start = t;
    }
  }
  return segs;
}

function segmentScore(emissions, seg, key) {
  let s = 0;
  for (let t = seg.start; t < seg.end; t++) s += emissions[t][key];
  return s;
}

function mergeAdjacentSame(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.key === s.key) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

function mergeShort(segs, emissions, minBlocks) {
  segs = mergeAdjacentSame(segs);
  while (segs.length > 1) {
    let idx = -1;
    let shortest = Infinity;
    segs.forEach((s, i) => {
      const len = s.end - s.start;
      if (len < minBlocks && len < shortest) {
        shortest = len;
        idx = i;
      }
    });
    if (idx < 0) break;
    const s = segs[idx];
    const prev = segs[idx - 1];
    const next = segs[idx + 1];
    let target;
    if (!prev) target = next;
    else if (!next) target = prev;
    else target = segmentScore(emissions, s, prev.key) >= segmentScore(emissions, s, next.key) ? prev : next;
    if (target === prev) prev.end = s.end;
    else next.start = s.start;
    segs.splice(idx, 1);
    segs = mergeAdjacentSame(segs);
  }
  return segs;
}

function sumChroma(chroma, active, start, end) {
  const acc = new Float64Array(12);
  for (let t = start; t < end; t++) {
    if (!active[t]) continue;
    for (let i = 0; i < 12; i++) acc[i] += chroma[t][i];
  }
  return acc;
}

function rankKeys(scores) {
  return Array.from(scores, (score, key) => ({ key, score })).sort((a, b) => b.score - a.score);
}

function confidenceOf(ranked) {
  const r1 = ranked[0].score;
  const r2 = ranked[1].score;
  return clamp01((r1 - 0.3) / 0.5) * 0.6 + clamp01((r1 - r2) / 0.15) * 0.4;
}

function refineBoundaries(segs, fine, searchRadius) {
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    const lo = Math.max(a.start + 1, b.start - searchRadius);
    const hi = Math.min(b.end - 1, b.start + searchRadius);
    let bestPos = b.start;
    let bestScore = -Infinity;
    for (let pos = lo; pos <= hi; pos++) {
      let s = 0;
      for (let t = lo - 1; t < pos; t++) s += fine[t][a.key];
      for (let t = pos; t <= hi; t++) s += fine[t][b.key];
      if (s > bestScore) {
        bestScore = s;
        bestPos = pos;
      }
    }
    a.end = bestPos;
    b.start = bestPos;
  }
}

function keyInfo(key) {
  return { key, name: keyName(key), short: shortKeyName(key), camelot: camelot(key) };
}

/**
 * Detects the key of an audio signal over time.
 * @param {Float32Array} samples mono PCM samples
 * @param {number} sampleRate
 * @param {object} [options] { profile, sensitivity: 'low'|'medium'|'high', minSectionSec }
 * @param {(fraction:number, message:string)=>void} [progress]
 */
export function analyzeKeys(samples, sampleRate, options = {}, progress) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const duration = samples.length / sampleRate;
  const report = progress || (() => {});

  report(0.02, 'Resampling…');
  const { data, rate } = downsample(samples, sampleRate);

  const { frames } = extractPeaks(data, rate, report);
  report(0.72, 'Estimating tuning…');
  const tuning = estimateTuning(frames);

  report(0.78, 'Building chromagram…');
  const { chroma, active } = buildBlocks(frames, tuning, duration);
  const blockCount = chroma.length;
  const templates = buildTemplates(opts.profile);

  if (!active.some((a) => a)) {
    return { duration, tuningCents: 0, silent: true, sections: [], changes: [], timeline: [], blockSec: BLOCK_SEC, overall: null };
  }

  report(0.84, 'Scoring keys…');
  const smooth = smoothChroma(chroma, active, 3);
  const fine = smoothChroma(chroma, active, 1);
  const emissions = smooth.map((c, t) => (active[t] ? correlateKeys(c, templates) : new Float64Array(KEY_COUNT)));
  const fineEm = fine.map((c, t) => (active[t] ? correlateKeys(c, templates) : new Float64Array(KEY_COUNT)));

  report(0.9, 'Finding key changes…');
  const penalty = SENSITIVITY_PENALTY[opts.sensitivity] ?? SENSITIVITY_PENALTY.medium;
  const minBlocks = Math.max(1, Math.round(opts.minSectionSec / BLOCK_SEC));
  let segs = pathToSegments(viterbi(emissions, penalty));
  segs = mergeShort(segs, emissions, minBlocks);

  // Re-estimate each section's key from all of its audio until stable.
  for (let iter = 0; iter < 5; iter++) {
    let changed = false;
    for (const s of segs) {
      const ranked = rankKeys(correlateKeys(sumChroma(chroma, active, s.start, s.end), templates));
      if (ranked[0].score > 0 && ranked[0].key !== s.key) {
        s.key = ranked[0].key;
        changed = true;
      }
    }
    const before = segs.length;
    segs = mergeShort(segs, emissions, minBlocks);
    if (!changed && segs.length === before) break;
  }

  refineBoundaries(segs, fineEm, 8);

  // Leading/trailing silence belongs to the neighbouring section.
  segs[0].start = 0;
  segs[segs.length - 1].end = blockCount;

  const sections = segs.map((s) => {
    const ranked = rankKeys(correlateKeys(sumChroma(chroma, active, s.start, s.end), templates));
    return {
      start: s.start * BLOCK_SEC,
      end: Math.min(duration, s.end * BLOCK_SEC),
      ...keyInfo(s.key),
      confidence: confidenceOf(ranked),
      alternatives: ranked.slice(1, 3).map((r) => ({ ...keyInfo(r.key), score: r.score })),
    };
  });

  const changes = [];
  for (let i = 1; i < sections.length; i++) {
    const from = sections[i - 1];
    const to = sections[i];
    changes.push({
      time: to.start,
      from: keyInfo(from.key),
      to: keyInfo(to.key),
      ...describeChange(from.key, to.key),
    });
  }

  // Overall key: whole-song estimate, plus the key that occupies the most time.
  const globalRanked = rankKeys(correlateKeys(sumChroma(chroma, active, 0, blockCount), templates));
  const timeByKey = new Map();
  for (const s of sections) timeByKey.set(s.key, (timeByKey.get(s.key) || 0) + (s.end - s.start));
  const dominantKey = [...timeByKey.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const timeline = fineEm.map((e, t) => {
    if (!active[t]) return { time: t * BLOCK_SEC, key: null, score: 0 };
    let k = 0;
    for (let j = 1; j < KEY_COUNT; j++) if (e[j] > e[k]) k = j;
    return { time: t * BLOCK_SEC, key: k, score: e[k] };
  });

  report(1, 'Done');
  return {
    duration,
    tuningCents: Math.round(tuning * 100),
    silent: false,
    blockSec: BLOCK_SEC,
    overall: {
      ...keyInfo(dominantKey),
      wholeSong: { ...keyInfo(globalRanked[0].key), confidence: confidenceOf(globalRanked) },
    },
    sections,
    changes,
    timeline,
  };
}
