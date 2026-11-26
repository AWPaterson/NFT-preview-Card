// The music library: scanning a folder, reading tags, and analysing every track in the
// background with results cached in IndexedDB.

import { db } from './db.js';
import { readMetadata, META_VERSION } from './metadata.js';
import { analyzeFile } from './analysis.js';
import { ANALYZER_VERSION, DEFAULT_OPTIONS } from './analyzer.js';

export const AUDIO_EXT = /\.(flac|wav|wave|mp3)$/i;

export const supportsFolderHandles = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export function optionsKey(options) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  return `v${ANALYZER_VERSION}|${o.profile}|${o.sensitivity}|${o.minSectionSec}|${o.noKey}`;
}

// Folders that never hold music but do show up on drives (and some can't be read at all).
const SKIP_DIRS = /^(\$RECYCLE\.BIN|System Volume Information|RECYCLER|#recycle|@eaDir|lost\+found)$/i;

/** True for files and folders the scan should ignore (hidden, macOS "._" files, system folders). */
export function isIgnoredName(name, isDir = false) {
  return name.startsWith('.') || (isDir && SKIP_DIRS.test(name));
}

// Walks every subfolder (e.g. a Rekordbox drive's Contents/Artist/Album/…) and yields audio
// files with their path relative to the chosen folder, so the whole tree becomes one flat list.
async function* walkHandle(dir, prefix = '', onSkip) {
  let entries;
  try {
    entries = dir.entries();
    for await (const [name, handle] of entries) {
      if (isIgnoredName(name, handle.kind === 'directory')) continue;
      if (handle.kind === 'directory') yield* walkHandle(handle, `${prefix}${name}/`, onSkip);
      else if (AUDIO_EXT.test(name)) yield { path: prefix + name, handle };
    }
  } catch (err) {
    // A protected or vanished folder must not stop the whole scan.
    onSkip?.(prefix || dir.name, err);
  }
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export class Library extends EventTarget {
  constructor() {
    super();
    this.tracks = [];
    this.byPath = new Map();
    this.rootName = null;
    this.rootHandle = null;
    this.options = { ...DEFAULT_OPTIONS };
    this.scanning = false;
    this.paused = false;
    this.queueRunning = false;
    this.priority = [];
    this.current = null; // track being analysed
    this.currentProgress = 0;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setOptions(options) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const key = optionsKey(this.options);
    for (const t of this.tracks) if (t.analysis && t.optionsKey !== key && t.status === 'done') t.status = 'stale';
    this.emit('changed');
    this.runQueue();
  }

  stats() {
    let done = 0;
    let pending = 0;
    let errors = 0;
    for (const t of this.tracks) {
      if (t.status === 'done') done++;
      else if (t.status === 'error') errors++;
      else pending++;
    }
    return { total: this.tracks.length, done, pending, errors };
  }

  clear() {
    this.tracks = this.tracks.filter((t) => t.loose);
    this.byPath = new Map(this.tracks.map((t) => [t.path, t]));
  }

  /** Scan a folder chosen with showDirectoryPicker(). */
  async loadFromHandle(handle) {
    this.clear();
    this.rootHandle = handle;
    this.rootName = handle.name;
    await db.put('kv', handle, 'rootHandle');
    const found = [];
    this.scanning = true;
    this.emit('scan', { found: 0 });
    const skipped = [];
    for await (const entry of walkHandle(handle, '', (path) => skipped.push(path))) {
      found.push(entry);
      if (found.length % 50 === 0) this.emit('scan', { found: found.length });
    }
    if (skipped.length) console.warn('Folders that could not be read:', skipped);
    await this.addEntries(found.map((e) => ({ path: e.path, getFile: () => e.handle.getFile() })));
  }

  /** Load files from an <input webkitdirectory> selection. */
  async loadFromFileList(files) {
    this.clear();
    this.rootHandle = null;
    const list = [...files].filter((f) => {
      if (!AUDIO_EXT.test(f.name)) return false;
      const parts = (f.webkitRelativePath || f.name).split('/');
      return !parts.some((part, i) => isIgnoredName(part, i < parts.length - 1));
    });
    const first = files[0]?.webkitRelativePath || '';
    this.rootName = first.split('/')[0] || 'Music';
    this.scanning = true;
    this.emit('scan', { found: list.length });
    await this.addEntries(
      list.map((f) => ({
        path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name,
        getFile: async () => f,
      })),
    );
  }

  async addEntries(entries) {
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const key = optionsKey(this.options);
    let processed = 0;
    await mapLimit(entries, 8, async (entry) => {
      try {
        const file = await entry.getFile();
        const sig = `${entry.path}|${file.size}|${file.lastModified}`;
        const cached = await db.get('tracks', sig);
        const meta = cached?.meta?.v === META_VERSION ? cached.meta : await readMetadata(file, entry.path);
        const track = {
          path: entry.path,
          name: entry.path.split('/').pop(),
          folder: entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '',
          getFile: entry.getFile,
          size: file.size,
          sig,
          meta,
          analysis: cached?.analysis || null,
          peaks: cached?.peaks || null,
          optionsKey: cached?.optionsKey || null,
          status: cached?.analysis ? (cached.optionsKey === key ? 'done' : 'stale') : 'pending',
          loose: !!entry.loose,
        };
        if (!cached || cached.meta !== meta) db.put('tracks', { ...(cached || {}), meta }, sig);
        const existing = this.byPath.get(track.path);
        if (existing) Object.assign(existing, track);
        else {
          this.tracks.push(track);
          this.byPath.set(track.path, track);
        }
      } catch (err) {
        console.warn('Skipping', entry.path, err);
      }
      processed++;
      if (processed % 40 === 0) this.emit('scan', { found: entries.length, processed });
    });
    this.tracks.sort((a, b) => a.path.localeCompare(b.path));
    this.scanning = false;
    this.emit('scan', { found: entries.length, processed, done: true });
    this.emit('changed');
    this.runQueue();
  }

  /** Add individual files (drag-and-drop or "Open file"). Returns the tracks. */
  async addLooseFiles(files) {
    const entries = [...files]
      .filter((f) => AUDIO_EXT.test(f.name))
      .map((f) => ({ path: `Added files/${f.name}`, getFile: async () => f, loose: true }));
    if (!entries.length) return [];
    await this.addEntries(entries);
    return entries.map((e) => this.byPath.get(e.path)).filter(Boolean);
  }

  /** Restores the previously chosen folder. Returns 'granted', 'prompt' or null. */
  async restoreHandle(requestPermission = false) {
    if (!supportsFolderHandles) return null;
    const handle = await db.get('kv', 'rootHandle');
    if (!handle) return null;
    this.rootName = handle.name;
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && requestPermission) perm = await handle.requestPermission({ mode: 'read' });
    if (perm === 'granted') {
      await this.loadFromHandle(handle);
      return 'granted';
    }
    return 'prompt';
  }

  async forgetFolder() {
    await db.delete('kv', 'rootHandle');
    this.rootHandle = null;
    this.rootName = null;
    this.clear();
    this.emit('changed');
  }

  needsAnalysis(t) {
    return t.status === 'pending' || t.status === 'stale';
  }

  /** Move a track to the front of the analysis queue. */
  prioritize(track) {
    if (!this.needsAnalysis(track)) return;
    this.priority = [track, ...this.priority.filter((t) => t !== track)];
    this.runQueue(true);
  }

  pause(paused) {
    this.paused = paused;
    this.emit('queue');
    if (!paused) this.runQueue();
  }

  nextInQueue() {
    while (this.priority.length) {
      const t = this.priority.shift();
      if (this.needsAnalysis(t)) return t;
    }
    if (this.paused) return null;
    return this.tracks.find((t) => this.needsAnalysis(t)) || null;
  }

  async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      let track;
      while ((track = this.nextInQueue())) await this.analyzeTrack(track);
    } finally {
      this.queueRunning = false;
      this.current = null;
      this.emit('queue');
    }
  }

  async analyzeTrack(track) {
    const key = optionsKey(this.options);
    this.current = track;
    this.currentProgress = 0;
    const previousStatus = track.status;
    track.status = 'analyzing';
    this.emit('queue');
    this.emit('track', track);
    try {
      const file = await track.getFile();
      const { result, peaks } = await analyzeFile(file, this.options, (fraction, message) => {
        this.currentProgress = fraction;
        this.emit('progress', { track, fraction, message });
      });
      track.analysis = result;
      track.peaks = peaks;
      track.optionsKey = key;
      track.status = 'done';
      if (!track.meta.duration) track.meta.duration = result.duration;
      await db.put('tracks', { meta: track.meta, analysis: result, peaks, optionsKey: key }, track.sig);
    } catch (err) {
      console.warn('Analysis failed for', track.path, err);
      track.status = track.analysis && previousStatus === 'stale' ? 'stale' : 'error';
      track.error = /decod|EncodingError|Unable/i.test(String(err && (err.message || err.name)))
        ? "This browser couldn't decode the file"
        : err.message || String(err);
      if (track.status === 'stale') track.status = 'done';
    }
    this.emit('track', track);
    this.emit('queue');
  }
}
