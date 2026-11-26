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
const PROMINENCE = 3;

// Bump when the analysis changes so cached library results are recomputed.
export const ANALYZER_VERSION = 3;

const NO_KEY = KEY_COUNT; // index of the "no key" state
const STATES = KEY_COUNT + 1;
// Share of spectral energy in prominent peaks (see extractPeaks): below TONALITY_MIN a
// block counts as unpitched, above TONALITY_FULL as fully pitched.
const TONALITY_MIN = 0.015;
const TONALITY_FULL = 0.05;
const SILENCE_SCORE = 1;
// Entering or leaving a no-key section costs this fraction of the key-change penalty.
const NO_KEY_PENALTY_FACTOR = 0.5;

export const SENSITIVITY_PENALTY = { low: 9, medium: 5, high: 2.5 };
// Score of the "no key" state: a section needs key evidence above this to get a key.
export const NO_KEY_LEVEL = { off: -Infinity, lenient: 0.3, normal: 0.4, strict: 0.5 };

export const DEFAULT_OPTIONS = {
  profile: 'combined',
  sensitivity: 'medium',
  minSectionSec: 12,
  noKey: 'normal',
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
  const prefix = new Float64Array(kMax + 3);
  const LOCAL = 16; // bins either side used for the local spectral mean
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

    prefix[kMin - 1] = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) prefix[k + 1] = prefix[k] + mag[k];
    const total = prefix[kMax + 1] - prefix[kMin];

    // Only peaks that stand well above the local spectral level count as pitched
    // content; broadband noise and drums produce many small peaks that do not.
    const pitches = [];
    const mags = [];
    let tonal = 0;
    const floor = frameMax * 0.005;
    for (let k = kMin; k <= kMax; k++) {
      const b = mag[k];
      if (b <= floor || b < mag[k - 1] || b < mag[k + 1]) continue;
      const lo = Math.max(kMin - 1, k - LOCAL);
      const hi = Math.min(kMax + 1, k + LOCAL);
      const localMean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
      if (b < PROMINENCE * localMean) continue;
      tonal += b;
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
      tonality: total > 0 ? tonal / total : 0,
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
  const tonality = new Float64Array(blockCount);
  const loudFrames = new Float64Array(blockCount);
  const counts = new Float64Array(blockCount);

  let maxRms = 0;
  for (const fr of frames) if (fr.rms > maxRms) maxRms = fr.rms;
  // -40 dB below the loudest frame, and never below about -80 dBFS.
  const silence = Math.max(maxRms * 0.01, 1e-4);

  for (const fr of frames) {
    const b = Math.min(blockCount - 1, Math.floor(fr.time / BLOCK_SEC));
    counts[b]++;
    if (fr.rms < silence) continue;
    loudFrames[b]++;
    tonality[b] += fr.tonality;
    for (let i = 0; i < fr.pitches.length; i++) {
      const m = fr.pitches[i] - tuning;
      const n = Math.round(m);
      const w = Math.cos(Math.PI * (m - n)) ** 2;
      chroma[b][((n % 12) + 12) % 12] += Math.sqrt(fr.mags[i]) * w;
    }
  }

  // audible: the block has sound. pitched: it also has usable pitched content.
  const audible = new Uint8Array(blockCount);
  const pitched = new Uint8Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    audible[b] = counts[b] > 0 && loudFrames[b] / counts[b] >= 0.5 ? 1 : 0;
    if (loudFrames[b] > 0) tonality[b] /= loudFrames[b];
    let total = 0;
    for (let i = 0; i < 12; i++) total += chroma[b][i];
    if (total > 0 && audible[b]) {
      for (let i = 0; i < 12; i++) chroma[b][i] /= total;
      pitched[b] = 1;
    }
  }
  return { chroma, tonality, audible, pitched };
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

function smoothSeries(values, radius) {
  const out = new Float64Array(values.length);
  for (let b = 0; b < values.length; b++) {
    let acc = 0;
    let wsum = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = b + d;
      if (j < 0 || j >= values.length) continue;
      const w = radius + 1 - Math.abs(d);
      acc += values[j] * w;
      wsum += w;
    }
    out[b] = acc / wsum;
  }
  return out;
}

// Emission scores for the 24 keys plus the "no key" state (index NO_KEY).
// Key scores are profile correlations, scaled down when little of the sound is pitched.
function buildEmissions(smoothed, tonality, audible, pitched, templates, noKeyLevel) {
  return smoothed.map((c, t) => {
    const e = new Float64Array(STATES);
    if (!audible[t]) {
      e[NO_KEY] = SILENCE_SCORE;
      return e;
    }
    e[NO_KEY] = noKeyLevel;
    if (!pitched[t]) return e;
    const weight = clamp01((tonality[t] - TONALITY_MIN) / (TONALITY_FULL - TONALITY_MIN));
    const corr = correlateKeys(c, templates);
    for (let k = 0; k < KEY_COUNT; k++) e[k] = corr[k] * weight;
    return e;
  });
}

function viterbi(emissions, penalty, noKeyPenalty) {
  const T = emissions.length;
  const score = new Float64Array(STATES);
  const back = Array.from({ length: T }, () => new Uint8Array(STATES));
  for (let k = 0; k < STATES; k++) score[k] = emissions[0][k];

  const next = new Float64Array(STATES);
  for (let t = 1; t < T; t++) {
    let bestKey = 0;
    for (let k = 1; k < KEY_COUNT; k++) if (score[k] > score[bestKey]) bestKey = k;
    for (let k = 0; k < STATES; k++) {
      let s = score[k];
      let from = k;
      if (k === NO_KEY) {
        if (score[bestKey] - noKeyPenalty > s) {
          s = score[bestKey] - noKeyPenalty;
          from = bestKey;
        }
      } else {
        if (score[bestKey] - penalty > s) {
          s = score[bestKey] - penalty;
          from = bestKey;
        }
        if (score[NO_KEY] - noKeyPenalty > s) {
          s = score[NO_KEY] - noKeyPenalty;
          from = NO_KEY;
        }
      }
      next[k] = s + emissions[t][k];
      back[t][k] = from;
    }
    score.set(next);
  }

  let k = 0;
  for (let j = 1; j < STATES; j++) if (score[j] > score[k]) k = j;
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

// Converts key correlations into probabilities. A lower temperature makes the
// probabilities more decisive for the same gap between the top keys.
const SOFTMAX_TEMP = 0.04;

function keyProbabilities(ranked) {
  const top = ranked[0].score;
  let sum = 0;
  const exps = ranked.map((r) => {
    const e = Math.exp((r.score - top) / SOFTMAX_TEMP);
    sum += e;
    return e;
  });
  return ranked.map((r, i) => ({ ...r, probability: exps[i] / sum }));
}

/**
 * Rates how sure we are of `key` for a stretch of audio:
 *  - definite:  the key clearly beats every alternative and the audio is strongly tonal
 *  - likely:    it wins, but an alternative (often the relative or a neighbouring key) is plausible
 *  - uncertain: two or more keys are about equally plausible, or the tonal evidence is weak
 * `agreement` is the share of seconds whose own best key matches; a key that keeps
 * flipping second-to-second drops one level.
 */
export function rateKey(probabilities, key, agreement = 1) {
  const entry = probabilities.find((p) => p.key === key) || probabilities[0];
  const p = entry.probability;
  const r = entry.score;
  let level = p >= 0.8 && r >= 0.6 ? 2 : p >= 0.6 && r >= 0.45 ? 1 : 0;
  if (agreement < 0.5 && level > 0) level--;
  return { confidence: p, certainty: ['uncertain', 'likely', 'definite'][level] };
}

function confidenceOf(ranked) {
  return rateKey(keyProbabilities(ranked), ranked[0].key).confidence;
}

function candidatesFor(probabilities, key, count = 3) {
  const first = probabilities.find((p) => p.key === key) || probabilities[0];
  const rest = probabilities.filter((p) => p !== first).slice(0, count - 1);
  return [first, ...rest].map((p) => ({ ...keyInfo(p.key), probability: p.probability, score: p.score }));
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

export function keyInfo(key) {
  return { key, name: keyName(key), short: shortKeyName(key), camelot: camelot(key) };
}

export function noKeyInfo(kind) {
  return {
    key: null,
    kind,
    name: kind === 'silence' ? 'Silence' : 'No key',
    short: kind === 'silence' ? 'Silence' : 'No key',
    camelot: '—',
  };
}

function emptyResult(duration, kind) {
  const section = { start: 0, end: duration, ...noKeyInfo(kind), confidence: 0, alternatives: [], pitchedShare: 0 };
  return {
    version: ANALYZER_VERSION,
    duration,
    tuningCents: 0,
    silent: kind === 'silence',
    blockSec: BLOCK_SEC,
    overall: null,
    startKey: null,
    endKey: null,
    sections: duration > 0 ? [section] : [],
    changes: [],
    transitions: [],
    timeline: [],
  };
}

/**
 * Detects the key of an audio signal over time, including sections with no key.
 * @param {Float32Array} samples mono PCM samples
 * @param {number} sampleRate
 * @param {object} [options] { profile, sensitivity, minSectionSec, noKey: 'off'|'lenient'|'normal'|'strict' }
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
  const { chroma, tonality, audible, pitched } = buildBlocks(frames, tuning, duration);
  const blockCount = chroma.length;
  const templates = buildTemplates(opts.profile);

  if (!audible.some((a) => a)) return emptyResult(duration, 'silence');

  report(0.84, 'Scoring keys…');
  const noKeyLevel = NO_KEY_LEVEL[opts.noKey] ?? NO_KEY_LEVEL.normal;
  const emissions = buildEmissions(smoothChroma(chroma, pitched, 3), smoothSeries(tonality, 3), audible, pitched, templates, noKeyLevel);
  const fineEm = buildEmissions(smoothChroma(chroma, pitched, 1), smoothSeries(tonality, 1), audible, pitched, templates, noKeyLevel);

  report(0.9, 'Finding key changes…');
  const penalty = SENSITIVITY_PENALTY[opts.sensitivity] ?? SENSITIVITY_PENALTY.medium;
  const minBlocks = Math.max(1, Math.round(opts.minSectionSec / BLOCK_SEC));
  let segs = pathToSegments(viterbi(emissions, penalty, penalty * NO_KEY_PENALTY_FACTOR));
  segs = mergeShort(segs, emissions, minBlocks);

  // Re-estimate each keyed section's key from all of its audio until stable.
  for (let iter = 0; iter < 5; iter++) {
    let changed = false;
    for (const s of segs) {
      if (s.key === NO_KEY) continue;
      const ranked = rankKeys(correlateKeys(sumChroma(chroma, pitched, s.start, s.end), templates));
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
  segs[0].start = 0;
  segs[segs.length - 1].end = blockCount;

  const sections = segs.map((s) => {
    let audibleCount = 0;
    let pitchedCount = 0;
    for (let t = s.start; t < s.end; t++) {
      audibleCount += audible[t];
      pitchedCount += pitched[t];
    }
    const base = { start: s.start * BLOCK_SEC, end: Math.min(duration, s.end * BLOCK_SEC) };
    if (s.key === NO_KEY) {
      const kind = audibleCount < (s.end - s.start) / 2 ? 'silence' : 'atonal';
      return { ...base, ...noKeyInfo(kind), confidence: 0, certainty: null, candidates: [], alternatives: [], pitchedShare: pitchedCount / (s.end - s.start) };
    }
    const probs = keyProbabilities(rankKeys(correlateKeys(sumChroma(chroma, pitched, s.start, s.end), templates)));
    let agree = 0;
    let counted = 0;
    for (let t = s.start; t < s.end; t++) {
      if (!pitched[t]) continue;
      counted++;
      // Agreement over the ~7 s smoothed scores: individual chords pull 1-second
      // estimates around, so a near-tie with the best key still counts.
      let best = 0;
      for (let k = 1; k < KEY_COUNT; k++) if (emissions[t][k] > emissions[t][best]) best = k;
      if (emissions[t][s.key] >= emissions[t][best] - 0.03) agree++;
    }
    const agreement = counted ? agree / counted : 0;
    const candidates = candidatesFor(probs, s.key);
    return {
      ...base,
      ...keyInfo(s.key),
      kind: 'key',
      ...rateKey(probs, s.key, agreement),
      agreement,
      candidates,
      alternatives: candidates.slice(1),
    };
  });

  // Every boundary between sections, and the subset that are real key changes
  // (consecutive keyed sections with different keys, possibly across a no-key gap).
  const transitions = [];
  const changes = [];
  let lastKeyed = null;
  sections.forEach((s, i) => {
    if (i > 0) {
      const prev = sections[i - 1];
      transitions.push({ time: s.start, from: pick(prev), to: pick(s) });
    }
    if (s.key == null) return;
    if (lastKeyed && lastKeyed.key !== s.key) {
      changes.push({
        time: s.start,
        from: keyInfo(lastKeyed.key),
        to: keyInfo(s.key),
        acrossNoKey: sections[i - 1].key == null,
        ...describeChange(lastKeyed.key, s.key),
      });
    }
    lastKeyed = s;
  });

  const keyed = sections.filter((s) => s.key != null);
  let overall = null;
  if (keyed.length) {
    const globalRanked = rankKeys(correlateKeys(sumChroma(chroma, pitched, 0, blockCount), templates));
    const timeByKey = new Map();
    for (const s of keyed) timeByKey.set(s.key, (timeByKey.get(s.key) || 0) + (s.end - s.start));
    const dominantKey = [...timeByKey.entries()].sort((a, b) => b[1] - a[1])[0][0];
    overall = { ...keyInfo(dominantKey), wholeSong: { ...keyInfo(globalRanked[0].key), confidence: confidenceOf(globalRanked) } };
  }

  const timeline = fineEm.map((e, t) => {
    let k = 0;
    for (let j = 1; j < STATES; j++) if (e[j] > e[k]) k = j;
    if (k === NO_KEY) return { time: t * BLOCK_SEC, key: null, score: 0, silent: !audible[t] };
    return { time: t * BLOCK_SEC, key: k, score: e[k] };
  });

  report(1, 'Done');
  return {
    version: ANALYZER_VERSION,
    duration,
    tuningCents: Math.round(tuning * 100),
    silent: false,
    blockSec: BLOCK_SEC,
    overall,
    startKey: keyed.length ? sectionKey(keyed[0]) : null,
    endKey: keyed.length ? sectionKey(keyed[keyed.length - 1]) : null,
    sections,
    changes,
    transitions,
    timeline,
  };
}

// A section's key with its certainty, for mix-in / mix-out display.
function sectionKey(s) {
  return { ...keyInfo(s.key), confidence: s.confidence, certainty: s.certainty, alternatives: s.alternatives };
}

function pick(s) {
  return { key: s.key, kind: s.kind, name: s.name, short: s.short, camelot: s.camelot };
}
