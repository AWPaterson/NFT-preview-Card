// Key naming, notation and relationships between keys.
// A key is an index 0..23: 0..11 are major keys (tonic pitch class = index),
// 12..23 are minor keys (tonic pitch class = index - 12).

const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

export const KEY_COUNT = 24;

export function isMinor(key) {
  return key >= 12;
}

export function tonic(key) {
  return key % 12;
}

export function keyName(key) {
  return isMinor(key) ? `${MINOR_NAMES[tonic(key)]} minor` : `${MAJOR_NAMES[tonic(key)]} major`;
}

export function shortKeyName(key) {
  return isMinor(key) ? `${MINOR_NAMES[tonic(key)]}m` : MAJOR_NAMES[tonic(key)];
}

// Camelot wheel notation used by DJs (e.g. C major = 8B, A minor = 8A).
export function camelot(key) {
  const relMajorPc = isMinor(key) ? (tonic(key) + 3) % 12 : tonic(key);
  const num = (((relMajorPc * 7) % 12) + 7) % 12 + 1;
  return `${num}${isMinor(key) ? 'A' : 'B'}`;
}

// Position on the circle of fifths (0..11), shared by relative major/minor.
export function fifthsPosition(key) {
  const relMajorPc = isMinor(key) ? (tonic(key) + 3) % 12 : tonic(key);
  return (relMajorPc * 7) % 12;
}

const INTERVAL_NAMES = [
  'unison', 'half step', 'whole step', 'minor third', 'major third', 'perfect fourth',
  'tritone', 'perfect fifth', 'minor sixth', 'major sixth', 'minor seventh', 'major seventh',
];

// Describes a modulation from one key to another in plain language.
export function describeChange(from, to) {
  const up = (tonic(to) - tonic(from) + 12) % 12;
  let movement;
  if (up === 0) movement = 'same tonic';
  else if (up === 6) movement = 'tritone';
  else if (up <= 6) movement = `up a ${INTERVAL_NAMES[up]}`;
  else movement = `down a ${INTERVAL_NAMES[12 - up]}`;

  let relation = null;
  if (isMinor(from) !== isMinor(to)) {
    if (up === 0) relation = 'parallel key';
    else if (!isMinor(from) && up === 9) relation = 'relative minor';
    else if (isMinor(from) && up === 3) relation = 'relative major';
  } else if (up === 7) {
    relation = 'dominant';
  } else if (up === 5) {
    relation = 'subdominant';
  } else if (up === 1 || up === 2) {
    relation = 'truck-driver modulation';
  }
  return { semitones: up <= 6 ? up : up - 12, movement, relation };
}

// Krumhansl-Kessler probe-tone profiles.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Temperley (Kostka-Payne corpus) profiles.
const TP_MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const TP_MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];

function zscore(v) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return v.map((x) => (x - mean) / sd);
}

function blend(a, b) {
  const za = zscore(a);
  const zb = zscore(b);
  return za.map((x, i) => (x + zb[i]) / 2);
}

export const PROFILES = {
  combined: { label: 'Combined (recommended)', major: blend(KK_MAJOR, TP_MAJOR), minor: blend(KK_MINOR, TP_MINOR) },
  krumhansl: { label: 'Krumhansl-Kessler', major: KK_MAJOR, minor: KK_MINOR },
  temperley: { label: 'Temperley', major: TP_MAJOR, minor: TP_MINOR },
};

// Builds 24 zero-mean, unit-norm templates (rotated profiles) for correlation.
export function buildTemplates(profileName = 'combined') {
  const p = PROFILES[profileName] || PROFILES.combined;
  const templates = [];
  for (let k = 0; k < KEY_COUNT; k++) {
    const base = isMinor(k) ? p.minor : p.major;
    const t = new Float64Array(12);
    for (let pc = 0; pc < 12; pc++) t[pc] = base[(pc - tonic(k) + 12) % 12];
    templates.push(normalizeCentered(t));
  }
  return templates;
}

export function normalizeCentered(v) {
  const out = new Float64Array(v.length);
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i];
  mean /= v.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) out[i] /= norm;
  return out;
}

// Pearson correlation of a chroma vector with all 24 key templates.
export function correlateKeys(chroma, templates) {
  const c = normalizeCentered(chroma);
  const scores = new Float64Array(KEY_COUNT);
  let any = false;
  for (let i = 0; i < 12; i++) if (c[i] !== 0) any = true;
  if (!any) return scores;
  for (let k = 0; k < KEY_COUNT; k++) {
    let s = 0;
    const t = templates[k];
    for (let i = 0; i < 12; i++) s += c[i] * t[i];
    scores[k] = s;
  }
  return scores;
}
