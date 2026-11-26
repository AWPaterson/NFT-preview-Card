# Key Change Detector

Upload a **FLAC, WAV or MP3** file and find the song's musical key, plus every place the key changes.

- If the song stays in one key, you get that single key.
- If it modulates, you get each **change point** (timestamp), the **key before** and the **key after**,
  and a plain-language description (e.g. "up a whole step", "relative minor").
- A colour-coded **timeline** over the waveform shows each section. Click anywhere to play from that point,
  or use "Hear it" to listen from just before a change.
- A per-section table shows confidence, Camelot notation and the runner-up key. Results export to CSV or JSON.

Everything runs locally in the browser. The audio file is never uploaded anywhere.

## Running it

It's a static site with no build step and no dependencies. It needs to be served over HTTP
(ES modules don't load from `file://`):

```sh
npm start              # serves on http://localhost:5173
# or
python3 -m http.server 5173
```

To host it, publish the repository root with GitHub Pages (Settings → Pages → deploy from branch)
or any static host.

## How it works

`src/analyzer.js` runs in a Web Worker:

1. Mixes to mono and downsamples to ~11 kHz with an anti-aliasing filter.
2. Runs a short-time FFT and picks spectral peaks between 60 Hz and 2 kHz.
3. Estimates how far the recording is tuned from A440 and compensates for it.
4. Folds the peaks into a 12-pitch-class **chromagram**, pooled into 1-second blocks.
5. Correlates the chroma against 24 major/minor **key profiles** (Krumhansl-Kessler, Temperley,
   or a blend of both).
6. Uses **Viterbi decoding** with a key-change penalty, so a key change is reported only when the
   evidence is sustained, not on every borrowed chord.
7. Absorbs sections shorter than the minimum length, re-estimates each section's key from all of
   its audio, and refines each boundary to the best-fitting second.

Settings (under "Analysis settings"):

| Setting | Effect |
| --- | --- |
| Change sensitivity | How much evidence is needed before a key change is reported |
| Shortest section | Sections shorter than this are merged into a neighbour |
| Key profile | Which major/minor templates to match against |

### Limitations

Profile-based key detection can confuse closely related keys, especially relative major/minor
(C major vs A minor) and keys a fifth apart. Change points are accurate to within a few seconds.
Heavily percussive or atonal passages produce low-confidence results.

## Tests

```sh
npm test
```

The tests synthesise chord-progression songs with known keys and key changes (including a
detuned recording, 48 kHz audio with noise, and a short passing section) and check the detector's output.

## Project layout

```
index.html        page markup
styles.css        styles (light and dark)
src/app.js        UI: decoding, waveform/timeline, results, export
src/worker.js     runs the analysis off the main thread
src/analyzer.js   key and key-change detection
src/keys.js       key names, Camelot notation, profiles, modulation descriptions
src/fft.js        radix-2 FFT
test/             synthetic-audio test suite
```
