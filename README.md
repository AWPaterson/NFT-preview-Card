# Key Change Detector

A browser app for DJs and music lovers. Point it at your music folder and it finds:

- **The key of every track**, and **every key change**: where it happens, the key before and after,
  and what kind of modulation it is (e.g. "up a whole step", "relative minor").
- **Sections with no key**: drum intros and outros, percussion breaks, noise, speech or other
  unpitched samples. Silence is labelled separately.

Then build **DJ sets** with a simple player, where each transition shows whether the outgoing track's
**ending key** mixes harmonically with the next track's **starting key** (Camelot rules).

Everything runs locally in the browser. Your music is never uploaded anywhere.

## Features

**Library**
- Choose a folder or drive; every FLAC, WAV and MP3 inside it (including subfolders) is listed.
- Title, artist, album, BPM and stored key are read from tags (ID3, FLAC Vorbis comments, WAV INFO/id3),
  with the file name as a fallback.
- Tracks are analyzed in the background, and results are cached so the next visit is instant.
- Search, sort by key/title/artist/time/BPM, and filter by starting key, "has key changes",
  "has no-key sections" or "no key at all".
- **Show tracks that mix with selected** lists tracks whose starting key fits the selected track's ending key.
- In Chrome and Edge (desktop) the folder is remembered between visits. Other browsers ask for it each visit.
  Sets are always saved.

**Track view**
- Colour-coded timeline over the waveform. No-key sections are striped grey. Click anywhere to play from there.
- A list of key changes and no-key sections, each with a "Hear it" button.
- Section table with confidence and runner-up key, the key from the file's tags for comparison,
  and the **mix-in / mix-out keys**. Export to CSV or JSON.

**Sets**
- Create sets, add tracks with **+** or by dragging them onto a set, and drag to reorder.
- Every transition is rated: same key, ±1, relative, energy boost, or clash.
- "Suggested next tracks" lists library tracks that mix well after the last track in the set.
- Play the whole set in the player bar. Export as an M3U8 playlist (save it in your music folder so the
  paths resolve) or as CSV.

**Player**
- Play/pause, previous/next, seek bar coloured by key section, a live "Now" key display and volume.
  Space toggles playback.

## Running it

It's a static site with no build step and no dependencies. Serve it over HTTP
(ES modules don't load from `file://`):

```sh
npm start              # serves on http://localhost:5173
# or
python3 -m http.server 5173
```

To host it, publish the repository root with GitHub Pages (Settings → Pages → deploy from branch)
or any static host. The folder picker needs a secure context (HTTPS or localhost).

## How the analysis works

`src/analyzer.js` runs in a Web Worker:

1. Mixes to mono and downsamples to ~11 kHz with an anti-aliasing filter.
2. Runs a short-time FFT and keeps only **prominent** spectral peaks (well above the local spectral
   level) between 60 Hz and 2 kHz, so drums and noise don't masquerade as notes.
3. Measures **tonality**: the share of spectral energy in those peaks. Drums and noise score near zero.
4. Estimates how far the recording is tuned from A440 and compensates for it.
5. Folds the peaks into a 12-pitch-class chromagram, pooled into 1-second blocks.
6. Scores each block against 24 major/minor key profiles, weighted by tonality, plus a
   **"no key"** state.
7. **Viterbi decoding** over the 25 states, with a penalty for changing state, gives stable sections.
   A key change needs sustained evidence, not just a borrowed chord.
8. Merges sections shorter than the minimum, re-estimates each section's key from all of its audio,
   refines boundaries, and labels no-key sections as *silence* or *atonal*.

Settings (top right):

| Setting | Effect |
| --- | --- |
| Key change sensitivity | How much evidence is needed before a key change is reported |
| No-key detection | Off / lenient / normal / strict threshold for calling a section keyless |
| Shortest section | Sections shorter than this are merged into a neighbour |
| Key profile | Which major/minor templates to match against |

### Limitations

- Profile-based key detection can confuse closely related keys, especially relative major/minor
  (C major vs A minor) and keys a fifth apart.
- Change points are accurate to within a few seconds.
- The no-key thresholds were tuned on synthetic audio. If real tracks are marked "No key" too often (or
  too rarely), change **No-key detection** in Settings.
- The browser must be able to decode the file. FLAC needs a recent Chrome, Edge, Firefox or Safari.

## Tests

```sh
npm test
```

The tests synthesise music with known keys, key changes, drum loops, noise and silence, and check the
detector's output. They also cover the Camelot mixing rules and filename parsing.

## Project layout

```
index.html               app shell
styles.css               styles (light and dark, desktop and phone)
src/app.js               routing, sidebar, player bar, settings, folder/file input
src/views/libraryView.js virtualised library table
src/views/trackView.js   per-track analysis view
src/views/setView.js     DJ set builder
src/library.js           folder scanning, tag cache, background analysis queue
src/sets.js              DJ sets (IndexedDB)
src/player.js            audio playback and queue
src/analysis.js          decoding, waveform overview, worker plumbing
src/worker.js            runs the analysis off the main thread
src/analyzer.js          key, key-change and no-key detection
src/keys.js              key names, Camelot notation, profiles, modulation descriptions
src/compat.js            harmonic-mixing compatibility
src/metadata.js          ID3 / FLAC / WAV tag reading
src/db.js                IndexedDB helper
src/ui.js                DOM and drawing helpers
src/fft.js               radix-2 FFT
test/                    synthetic-audio test suite
```
