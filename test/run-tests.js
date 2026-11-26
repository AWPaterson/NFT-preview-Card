import assert from 'node:assert/strict';
import { analyzeKeys } from '../src/analyzer.js';
import { camelot, describeChange, keyName } from '../src/keys.js';
import { mixCompatibility } from '../src/compat.js';
import { guessFromFilename, guessFromPath } from '../src/metadata.js';
import { isIgnoredName } from '../src/library.js';
import { synthSong, synthDrums, synthNoise, concat, mix, synthAlternating } from './synth.js';

let failures = 0;
function test(name, fn) {
  const t = Date.now();
  try {
    fn();
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function summary(r) {
  return r.sections.map((s) => `${s.name} [${s.start.toFixed(0)}-${s.end.toFixed(0)}s]`).join(' → ');
}

console.log('keys');
test('camelot notation', () => {
  assert.equal(camelot(0), '8B'); // C major
  assert.equal(camelot(21), '8A'); // A minor
  assert.equal(camelot(7), '9B'); // G major
  assert.equal(camelot(11), '1B'); // B major
  assert.equal(camelot(12 + 4), '9A'); // E minor
});
test('change descriptions', () => {
  assert.equal(describeChange(0, 2).movement, 'up a whole step');
  assert.equal(describeChange(0, 21).relation, 'relative minor');
  assert.equal(describeChange(0, 12).relation, 'parallel key');
  assert.equal(describeChange(0, 7).relation, 'dominant');
  assert.equal(describeChange(4, 0).movement, 'down a major third');
});

console.log('mixing');
test('Camelot mixing rules', () => {
  const k = (camelot) => ({ camelot });
  assert.equal(mixCompatibility(k('8A'), k('8A')).level, 'perfect');
  assert.equal(mixCompatibility(k('8A'), k('9A')).level, 'good');
  assert.equal(mixCompatibility(k('12B'), k('1B')).level, 'good');
  assert.equal(mixCompatibility(k('8A'), k('8B')).level, 'good');
  assert.equal(mixCompatibility(k('8A'), k('10A')).level, 'boost');
  assert.equal(mixCompatibility(k('8A'), k('9B')).level, 'boost');
  assert.equal(mixCompatibility(k('9B'), k('2B')).level, 'clash');
  assert.equal(mixCompatibility(null, k('2B')).level, 'free');
});
test('artist/title from file names', () => {
  assert.deepEqual(guessFromFilename('04 - Grid Unit - Drum Tool.wav'), { artist: 'Grid Unit', title: 'Drum Tool' });
  assert.deepEqual(guessFromFilename('golden.mp3'), { title: 'golden' });
});

test('Rekordbox Contents/Artist/Album layout gives artist and album', () => {
  assert.deepEqual(guessFromPath('Contents/Nova Lane/Night Moves/01 Midnight Drive.mp3'), { artist: 'Nova Lane', album: 'Night Moves' });
  assert.deepEqual(guessFromPath('USB/Contents/UnknownArtist/UnknownAlbum/x.mp3'), { artist: '', album: '' });
  assert.deepEqual(guessFromPath('House/Deep/x.mp3'), {});
});
test('hidden, macOS ._ and system folders are skipped', () => {
  assert.ok(isIgnoredName('._Midnight Drive.mp3'));
  assert.ok(isIgnoredName('System Volume Information', true));
  assert.ok(isIgnoredName('$RECYCLE.BIN', true));
  assert.ok(!isIgnoredName('Contents', true));
  assert.ok(!isIgnoredName('PIONEER', true));
});

console.log('analyzer');
test('single key song → one section in C major', () => {
  const { samples, rate } = synthSong([{ key: 'C', seconds: 64 }]);
  const r = analyzeKeys(samples, rate);
  assert.equal(r.sections.length, 1, summary(r));
  assert.equal(r.sections[0].name, 'C major');
  assert.equal(r.changes.length, 0);
  assert.equal(r.overall.name, 'C major');
});

test('minor key song → A minor', () => {
  const { samples, rate } = synthSong([{ key: 'A', minor: true, seconds: 64 }]);
  const r = analyzeKeys(samples, rate);
  assert.equal(r.sections.length, 1, summary(r));
  assert.equal(r.sections[0].name, 'A minor');
});

test('key change C major → D major at 48 s', () => {
  const { samples, rate } = synthSong([{ key: 'C', seconds: 48 }, { key: 'D', seconds: 48 }]);
  const r = analyzeKeys(samples, rate);
  assert.equal(r.sections.length, 2, summary(r));
  assert.equal(r.changes[0].from.name, 'C major');
  assert.equal(r.changes[0].to.name, 'D major');
  assert.ok(Math.abs(r.changes[0].time - 48) <= 3, `change at ${r.changes[0].time}s`);
  assert.equal(r.changes[0].movement, 'up a whole step');
});

test('two changes: E♭ major → E minor → B♭ major (48 kHz, noisy)', () => {
  const { samples, rate } = synthSong(
    [{ key: 'Eb', seconds: 40 }, { key: 'E', minor: true, seconds: 40 }, { key: 'Bb', seconds: 40 }],
    { rate: 48000, noise: 0.05 },
  );
  const r = analyzeKeys(samples, rate);
  assert.deepEqual(r.sections.map((s) => s.name), ['E♭ major', 'E minor', 'B♭ major'], summary(r));
  assert.ok(Math.abs(r.changes[0].time - 40) <= 3, `change 1 at ${r.changes[0].time}s`);
  assert.ok(Math.abs(r.changes[1].time - 80) <= 3, `change 2 at ${r.changes[1].time}s`);
});

test('detuned recording (+40 cents) still detected as G major', () => {
  const { samples, rate } = synthSong([{ key: 'G', seconds: 48 }], { detuneCents: 40 });
  const r = analyzeKeys(samples, rate);
  assert.equal(r.sections.length, 1, summary(r));
  assert.equal(r.sections[0].name, 'G major');
  assert.ok(Math.abs(r.tuningCents - 40) <= 8, `tuning ${r.tuningCents}`);
});

test('section shorter than minimum is absorbed', () => {
  const { samples, rate } = synthSong([{ key: 'C', seconds: 40 }, { key: 'F#', seconds: 6 }, { key: 'C', seconds: 40 }]);
  const r = analyzeKeys(samples, rate, { minSectionSec: 12 });
  assert.equal(r.sections.length, 1, summary(r));
});

test('silence → a single silent section, no key', () => {
  const r = analyzeKeys(new Float32Array(44100 * 5), 44100);
  assert.equal(r.silent, true);
  assert.equal(r.overall, null);
  assert.equal(r.sections[0].kind, 'silence');
});

console.log('confidence');
test('clear key is rated definite', () => {
  const r = analyzeKeys(synthSong([{ key: 'C', seconds: 48 }]).samples, 44100);
  assert.equal(r.sections[0].certainty, 'definite');
  assert.ok(r.sections[0].confidence > 0.9);
  assert.equal(r.startKey.certainty, 'definite');
  assert.equal(r.sections[0].candidates[0].camelot, '8B');
});

test('C major / A minor ambiguity is rated uncertain with both keys offered', () => {
  const r = analyzeKeys(synthAlternating([48, 52, 55, 60], [45, 57, 60, 64], 48), 44100);
  const s = r.sections[0];
  assert.equal(s.certainty, 'uncertain');
  const top2 = s.candidates.slice(0, 2).map((c) => c.camelot).sort();
  assert.deepEqual(top2, ['8A', '8B']);
  const total = s.candidates.reduce((a, c) => a + c.probability, 0);
  assert.ok(total <= 1.0001 && total > 0.9);
});

test('power chords (no thirds) are not rated definite', () => {
  const r = analyzeKeys(synthAlternating([40, 47, 52], [45, 52, 57], 48), 44100);
  assert.notEqual(r.sections[0].certainty, 'definite');
});

console.log('no-key detection');
test('drum loop alone → no key', () => {
  const r = analyzeKeys(synthDrums(40), 44100);
  assert.equal(r.sections.length, 1, summary(r));
  assert.equal(r.sections[0].kind, 'atonal');
  assert.equal(r.overall, null);
  assert.equal(r.startKey, null);
});

test('white noise → no key', () => {
  const r = analyzeKeys(synthNoise(30), 44100);
  assert.deepEqual(r.sections.map((s) => s.kind), ['atonal'], summary(r));
});

test('tonal music over drums keeps its key', () => {
  const song = synthSong([{ key: 'F', seconds: 48 }]).samples;
  const r = analyzeKeys(mix(song, synthDrums(48)), 44100);
  assert.deepEqual(r.sections.map((s) => s.name), ['F major'], summary(r));
});

test('noisy, drum-heavy tonal music is not marked as no key', () => {
  const song = synthSong([{ key: 'E', minor: true, seconds: 60 }], { noise: 0.12 }).samples;
  const r = analyzeKeys(mix(song, synthDrums(60), 1.2), 44100);
  assert.deepEqual(r.sections.map((s) => s.name), ['E minor'], summary(r));
});

test('drum intro → B♭ major → noise break → B♭ major → drum outro', () => {
  const a = synthSong([{ key: 'Bb', seconds: 40 }]).samples;
  const b = synthSong([{ key: 'Bb', seconds: 30 }]).samples;
  const r = analyzeKeys(concat(synthDrums(30), mix(a, synthDrums(40), 0.7), synthNoise(20, 44100, 0.2), b, synthDrums(24)), 44100);
  assert.deepEqual(r.sections.map((s) => s.name), ['No key', 'B♭ major', 'No key', 'B♭ major', 'No key'], summary(r));
  assert.ok(Math.abs(r.sections[1].start - 30) <= 3, `key starts at ${r.sections[1].start}`);
  assert.ok(Math.abs(r.sections[2].start - 70) <= 3, `break starts at ${r.sections[2].start}`);
  assert.equal(r.changes.length, 0, 'same key either side of the break is not a key change');
  assert.equal(r.transitions.length, 4);
  assert.equal(r.startKey.name, 'B♭ major');
  assert.equal(r.endKey.name, 'B♭ major');
});

test('key change across an atonal break is still reported', () => {
  const a = synthSong([{ key: 'C', seconds: 36 }]).samples;
  const b = synthSong([{ key: 'A', minor: true, seconds: 36 }]).samples;
  const r = analyzeKeys(concat(a, synthDrums(20), b), 44100);
  assert.deepEqual(r.sections.map((s) => s.name), ['C major', 'No key', 'A minor'], summary(r));
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].acrossNoKey, true);
  assert.equal(r.endKey.name, 'A minor');
});

test('silent gap is labelled silence, not atonal', () => {
  const a = synthSong([{ key: 'D', seconds: 30 }]).samples;
  const r = analyzeKeys(concat(a, new Float32Array(44100 * 15), a), 44100);
  assert.deepEqual(r.sections.map((s) => s.kind), ['key', 'silence', 'key'], summary(r));
});

test('no-key detection can be turned off', () => {
  const song = synthSong([{ key: 'G', seconds: 40 }]).samples;
  const r = analyzeKeys(concat(synthDrums(20), song), 44100, { noKey: 'off' });
  assert.deepEqual(r.sections.map((s) => s.name), ['G major'], summary(r));
});

test('names for all 24 keys are unique', () => {
  const names = new Set(Array.from({ length: 24 }, (_, k) => keyName(k)));
  assert.equal(names.size, 24);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
