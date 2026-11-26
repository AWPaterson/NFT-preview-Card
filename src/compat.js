// Harmonic-mixing compatibility between two keys, using Camelot wheel rules.
// Keys are key-info objects ({ key, camelot, ... }) or null for "no key".

export function parseCamelot(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? { num: Number(m[1]), letter: m[2] } : null;
}

const LEVEL_SCORE = { perfect: 4, good: 3, free: 2.5, boost: 2, clash: 0 };

/**
 * How well a track ending in `from` mixes into a track starting in `to`.
 * @returns {{ level: 'perfect'|'good'|'boost'|'free'|'clash', label: string, score: number }}
 */
export function mixCompatibility(from, to) {
  const a = from && parseCamelot(from.camelot);
  const b = to && parseCamelot(to.camelot);
  let level;
  let label;
  if (!a || !b) {
    level = 'free';
    label = 'No key on one side, so any key works';
  } else {
    const d = (b.num - a.num + 12) % 12;
    const same = a.letter === b.letter;
    if (same && d === 0) [level, label] = ['perfect', 'Same key'];
    else if (same && d === 1) [level, label] = ['good', '+1 · energy up'];
    else if (same && d === 11) [level, label] = ['good', '−1 · energy down'];
    else if (!same && d === 0) [level, label] = ['good', 'Relative major/minor'];
    else if (same && d === 2) [level, label] = ['boost', '+2 · energy boost'];
    else if (same && d === 7) [level, label] = ['boost', 'Semitone up'];
    else if ((a.letter === 'A' && d === 1) || (a.letter === 'B' && d === 11)) [level, label] = ['boost', 'Diagonal mix'];
    else [level, label] = ['clash', 'Key clash'];
  }
  return { level, label, score: LEVEL_SCORE[level] };
}
