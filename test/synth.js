// Synthesises simple chord-progression "songs" with known keys for testing.

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// Diatonic triads as scale-degree offsets from the tonic.
const MAJOR_PROG = [
  [0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7], // I IV V I
  [9, 12, 16], [2, 5, 9], [7, 11, 14, 17], [0, 4, 7], // vi ii V7 I
];
const MINOR_PROG = [
  [0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7], // i iv V i
  [8, 12, 15], [3, 7, 10], [7, 11, 14], [0, 3, 7], // VI III V i
];

function midiToHz(m) {
  return 440 * 2 ** ((m - 69) / 12);
}

function addTone(out, rate, startSec, durSec, freq, amp) {
  const start = Math.floor(startSec * rate);
  const len = Math.floor(durSec * rate);
  const harmonics = [1, 0.5, 0.33, 0.25, 0.2];
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.02) * Math.exp(-1.2 * t);
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const f = freq * (h + 1);
      if (f > rate / 2) break;
      s += harmonics[h] * Math.sin(2 * Math.PI * f * t);
    }
    out[start + i] += amp * env * s;
  }
}

/**
 * sections: [{ key: 'D', minor?: bool, seconds }]
 * options: { rate, chordSec, detuneCents, noise }
 */
export function synthSong(sections, options = {}) {
  const rate = options.rate || 44100;
  const chordSec = options.chordSec || 2;
  const detune = (options.detuneCents || 0) / 100;
  const total = sections.reduce((a, s) => a + s.seconds, 0);
  const out = new Float32Array(Math.ceil(total * rate));

  let t0 = 0;
  for (const sec of sections) {
    const tonicMidi = 48 + NOTE[sec.key] + detune; // around C3
    const prog = sec.minor ? MINOR_PROG : MAJOR_PROG;
    const chords = Math.round(sec.seconds / chordSec);
    for (let c = 0; c < chords; c++) {
      const chord = prog[c % prog.length];
      const start = t0 + c * chordSec;
      addTone(out, rate, start, chordSec, midiToHz(tonicMidi + chord[0] - 12), 0.25); // bass
      for (const iv of chord) addTone(out, rate, start, chordSec, midiToHz(tonicMidi + iv), 0.15);
      // simple melody: chord tones an octave up
      for (let n = 0; n < 4; n++) {
        const iv = chord[n % chord.length] + 12;
        addTone(out, rate, start + (n * chordSec) / 4, chordSec / 4, midiToHz(tonicMidi + iv), 0.08);
      }
    }
    t0 += sec.seconds;
  }

  if (options.noise) {
    let seed = 12345;
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] += options.noise * ((seed / 0x7fffffff) * 2 - 1);
    }
  }
  return { samples: out, rate };
}
