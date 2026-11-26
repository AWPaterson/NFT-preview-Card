import assert from 'node:assert/strict';
import { analyzeKeys } from '../src/analyzer.js';
import { camelot, describeChange, keyName } from '../src/keys.js';
import { synthSong } from './synth.js';

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

test('silence → no sections', () => {
  const r = analyzeKeys(new Float32Array(44100 * 5), 44100);
  assert.equal(r.silent, true);
});

test('names for all 24 keys are unique', () => {
  const names = new Set(Array.from({ length: 24 }, (_, k) => keyName(k)));
  assert.equal(names.size, 24);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
