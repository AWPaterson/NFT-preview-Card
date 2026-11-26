// App shell: routing between views, sidebar, player bar, settings and file/folder input.
import { db } from './db.js';
import { Library, supportsFolderHandles, AUDIO_EXT } from './library.js';
import { SetStore } from './sets.js';
import { Player } from './player.js';
import { DEFAULT_OPTIONS } from './analyzer.js';
import { el, formatTime, keyChip, setupCanvas, paintSections, cssVar, toast, setNotation, getNotation } from './ui.js';
import { mountLibraryView } from './views/libraryView.js';
import { mountSetView } from './views/setView.js';
import { mountTrackView } from './views/trackView.js';

const $ = (id) => document.getElementById(id);

const library = new Library();
const sets = new SetStore();
const player = new Player($('audio'));

const state = {
  stack: [],
  view: null,
  mounted: null,
  selectedPath: null,
  activeSetId: null,
  folderStatus: null, // 'prompt' when a saved folder needs permission again
  scan: null,
  libraryView: { search: '', filter: '', sort: 'path', desc: false, matchPath: null, scrollTop: 0 },
};

const ctx = {
  library,
  sets,
  player,
  state,
  go,
  back,
  rerender: () => mount(state.view),
  playTrack,
  openTrack: (track) => go({ type: 'track', path: track.path }),
  addToActiveSet,
  renderLibraryEmpty,
};

// ---------- routing ----------

function sameView(a, b) {
  return a && b && a.type === b.type && a.path === b.path && a.id === b.id;
}

function go(view, { replace = false } = {}) {
  if (sameView(view, state.view)) return;
  if (state.view && !replace) state.stack.push(state.view);
  if (state.stack.length > 30) state.stack.shift();
  mount(view);
}

function back() {
  mount(state.stack.pop() || { type: 'library' });
}

function mount(view) {
  state.mounted?.unmount();
  state.view = view;
  const root = $('view');
  root.replaceChildren();
  root.className = `view view-${view.type}`;
  if (view.type === 'set') {
    state.activeSetId = view.id;
    db.put('kv', view.id, 'activeSetId');
    state.mounted = mountSetView(root, ctx, view);
  } else if (view.type === 'track') {
    state.mounted = mountTrackView(root, ctx, view);
  } else {
    state.mounted = mountLibraryView(root, ctx);
  }
  root.scrollTop = 0;
  renderSidebar();
}

function notify(reason, detail) {
  state.mounted?.update(reason, detail);
}

// ---------- sidebar ----------

function renderSidebar() {
  for (const b of document.querySelectorAll('[data-nav]')) {
    b.classList.toggle('active', state.view?.type === b.dataset.nav);
  }
  $('lib-count').textContent = library.tracks.length ? library.tracks.length : '';
  renderFolderBox();
  renderSetNav();
  renderQueueStatus();
}

function renderFolderBox() {
  const box = $('folder-box');
  box.replaceChildren();
  if (state.scan && !state.scan.done) {
    box.append(el('div', { class: 'folder-line' }, el('span', { class: 'spinner' }), `Scanning ${library.rootName || ''}…`), el('div', { class: 'muted small' }, `${state.scan.processed || 0} of ${state.scan.found} files`));
    return;
  }
  const loaded = library.tracks.some((t) => !t.loose);
  if (loaded) {
    box.append(
      el('div', { class: 'folder-line', title: library.rootName }, el('span', { class: 'folder-icon', 'aria-hidden': 'true' }, '📁'), el('span', { class: 'ellipsis' }, library.rootName)),
      el('div', { class: 'muted small folder-note' }, `${library.tracks.filter((t) => !t.loose).length} tracks from ${new Set(library.tracks.filter((t) => !t.loose).map((t) => t.folder)).size} folders, shown as one list`),
      el(
        'div',
        { class: 'row-gap' },
        el('button', { class: 'link small', type: 'button', onclick: pickFolder }, 'Change folder'),
        library.rootHandle && el('button', { class: 'link small', type: 'button', onclick: rescan }, 'Rescan'),
      ),
    );
  } else if (state.folderStatus === 'prompt') {
    box.append(el('button', { class: 'btn primary block', type: 'button', onclick: reconnect }, `Reconnect “${library.rootName}”`), el('button', { class: 'link small', type: 'button', onclick: pickFolder }, 'Choose a different folder'));
  } else {
    box.append(el('button', { class: 'btn primary block', type: 'button', onclick: pickFolder }, 'Choose music folder'));
  }
}

function renderSetNav() {
  const nav = $('set-nav');
  nav.replaceChildren();
  if (!sets.sets.length) {
    nav.append(el('li', { class: 'muted small set-nav-empty' }, 'No sets yet'));
    return;
  }
  for (const s of sets.sets) {
    const active = state.view?.type === 'set' && state.view.id === s.id;
    const item = el(
      'li',
      {},
      el(
        'button',
        { class: `nav-item set ${active ? 'active' : ''} ${state.activeSetId === s.id ? 'target' : ''}`, type: 'button', title: state.activeSetId === s.id ? 'The + button adds tracks to this set' : '' },
        el('span', { class: 'ellipsis' }, s.name),
        el('span', { class: 'nav-count' }, s.tracks.length),
      ),
    );
    const btn = item.firstChild;
    btn.addEventListener('click', () => go({ type: 'set', id: s.id }));
    btn.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-track-path')) return;
      e.preventDefault();
      btn.classList.add('drop');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop'));
    btn.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove('drop');
      const t = library.byPath.get(e.dataTransfer.getData('application/x-track-path'));
      if (t) {
        await sets.addTracks(s, [t]);
        toast(`Added “${t.meta.title}” to ${s.name}`);
      }
    });
    nav.append(item);
  }
}

function renderQueueStatus() {
  const box = $('queue-status');
  const st = library.stats();
  const running = library.current || (st.pending && library.paused);
  if (!st.total || (!st.pending && !library.current)) {
    box.hidden = !st.total;
    box.replaceChildren();
    if (st.total) {
      box.append(el('div', { class: 'small muted' }, `All ${st.done} tracks analyzed${st.errors ? ` · ${st.errors} couldn't be decoded` : ''}`));
    }
    return;
  }
  box.hidden = false;
  const pct = st.total ? (st.done / st.total) * 100 : 0;
  box.replaceChildren(
    el('div', { class: 'small' }, library.paused ? 'Analysis paused' : `Analyzing ${st.done + 1} of ${st.total}`),
    el('div', { class: 'progress' }, el('div', { class: 'bar', style: `width:${pct}%` })),
    library.current ? el('div', { class: 'small muted ellipsis' }, library.current.meta.title) : null,
    running || st.pending
      ? el('button', { class: 'link small', type: 'button', onclick: () => library.pause(!library.paused) }, library.paused ? 'Resume' : 'Pause')
      : null,
  );
}

// ---------- folder & files ----------

async function pickFolder() {
  if (supportsFolderHandles) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'music', mode: 'read', startIn: 'music' });
      state.folderStatus = null;
      await library.loadFromHandle(handle);
    } catch (err) {
      if (err.name !== 'AbortError') toast(`Couldn't open that folder: ${err.message}`);
    }
  } else {
    $('folder-input').click();
  }
}

async function reconnect() {
  try {
    const status = await library.restoreHandle(true);
    state.folderStatus = status === 'granted' ? null : status;
    renderSidebar();
  } catch (err) {
    toast(`Couldn't reconnect: ${err.message}`);
  }
}

async function rescan() {
  if (library.rootHandle) await library.loadFromHandle(library.rootHandle);
}

$('folder-input').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files.length) await library.loadFromFileList(files);
  e.target.value = '';
});

async function openFiles(files) {
  const audio = [...files].filter((f) => AUDIO_EXT.test(f.name));
  if (!audio.length) {
    toast('Please choose FLAC, WAV or MP3 files.');
    return;
  }
  const tracks = await library.addLooseFiles(audio);
  if (tracks[0]) {
    library.prioritize(tracks[0]);
    ctx.openTrack(tracks[0]);
  }
}

$('open-files-btn').addEventListener('click', () => $('open-files').click());
$('open-files').addEventListener('change', (e) => {
  openFiles(e.target.files);
  e.target.value = '';
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  openFiles(e.dataTransfer.files);
});

function renderLibraryEmpty() {
  const reconnecting = state.folderStatus === 'prompt';
  return el(
    'div',
    { class: 'card hero' },
    el('h2', {}, reconnecting ? `Welcome back` : 'Your music library'),
    el(
      'p',
      { class: 'muted' },
      reconnecting
        ? `Your browser needs permission again to read “${library.rootName}”.`
        : 'Choose the folder (or drive) that holds your music. Every FLAC, WAV and MP3 inside it, including subfolders, is listed and analyzed for key, key changes and keyless sections. Your files never leave this device.',
    ),
    el(
      'div',
      { class: 'row-gap wrap center' },
      reconnecting
        ? el('button', { class: 'btn primary', type: 'button', onclick: reconnect }, `Reconnect “${library.rootName}”`)
        : el('button', { class: 'btn primary', type: 'button', onclick: pickFolder }, 'Choose music folder'),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => $('open-files').click() }, 'Open individual files'),
    ),
    el('p', { class: 'muted small' }, 'You can also drag audio files anywhere onto this page.'),
    !supportsFolderHandles
      ? el('p', { class: 'muted small' }, 'This browser will ask for the folder each visit. Chrome and Edge on desktop can remember it. Your sets are always saved.')
      : null,
  );
}

// ---------- sets ----------

async function activeSet() {
  let set = sets.get(state.activeSetId);
  if (!set) {
    set = sets.sets[sets.sets.length - 1] || (await sets.create());
    state.activeSetId = set.id;
    db.put('kv', set.id, 'activeSetId');
  }
  return set;
}

async function addToActiveSet(tracks) {
  const set = await activeSet();
  const fresh = tracks.filter((t) => !set.tracks.some((e) => e.path === t.path));
  if (!fresh.length) {
    toast(`Already in ${set.name}`);
    return;
  }
  await sets.addTracks(set, fresh);
  toast(fresh.length === 1 ? `Added “${fresh[0].meta.title}” to ${set.name}` : `Added ${fresh.length} tracks to ${set.name}`);
}

$('new-set').addEventListener('click', async () => {
  const set = await sets.create();
  go({ type: 'set', id: set.id });
  requestAnimationFrame(() => {
    const input = document.querySelector('.set-name');
    input?.focus();
    input?.select();
  });
});

document.querySelector('[data-nav="library"]').addEventListener('click', () => go({ type: 'library' }));

// ---------- player bar ----------

function playTrack(track, { queue, context, startAt = 0 } = {}) {
  if (!track) return;
  if (track.status === 'error') {
    toast("This browser can't play that file.");
    return;
  }
  player.play(track, { queue, context, startAt });
}

let lastPlaying = false;
let barRaf = 0;

function updatePlayerBar() {
  const t = player.track;
  $('pb-title').textContent = t ? t.meta.title : 'Nothing playing';
  $('pb-sub').textContent = t ? t.meta.artist || t.folder : '';
  $('pb-play').textContent = player.playing ? '❚❚' : '▶';
  $('pb-play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  $('pb-time').textContent = formatTime(player.currentTime);
  $('pb-dur').textContent = formatTime(player.duration);
  const bar = $('pb-bar');
  bar.setAttribute('aria-valuemax', String(Math.round(player.duration)));
  bar.setAttribute('aria-valuenow', String(Math.round(player.currentTime)));
  bar.setAttribute('aria-valuetext', `${formatTime(player.currentTime)} of ${formatTime(player.duration)}`);
  const sec = player.currentSection();
  const keyBox = $('pb-key');
  const keyId = sec ? `${sec.key}|${sec.kind}` : t ? (t.analysis ? 'none' : 'pending') : '';
  if (keyBox.dataset.k !== keyId) {
    keyBox.dataset.k = keyId;
    keyBox.replaceChildren(sec ? keyChip(sec) : t ? el('span', { class: 'muted small' }, t.analysis ? '–' : 'Analyzing…') : '');
  }
  drawSeek();
}

function drawSeek() {
  const canvas = $('pb-canvas');
  const { ctx: g, w, h } = setupCanvas(canvas);
  g.clearRect(0, 0, w, h);
  const d = player.duration;
  const a = player.track?.analysis;
  const y = h / 2 - 4;
  g.fillStyle = cssVar('--surface-2');
  g.fillRect(0, y, w, 8);
  if (a && d) paintSections(g, a.sections, a.duration, 0, y, w, 8, 0.85);
  if (d) {
    const x = (player.currentTime / d) * w;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x, y, w - x, 8);
    g.fillStyle = cssVar('--text');
    g.beginPath();
    g.arc(Math.max(6, Math.min(w - 6, x)), h / 2, 6, 0, Math.PI * 2);
    g.fill();
  }
}

player.addEventListener('track', () => {
  updatePlayerBar();
  notify('player-track');
  const t = player.track;
  if (t && !t.analysis) library.prioritize(t);
  document.title = t ? `${t.meta.title} · Key Change Detector` : 'Key Change Detector';
});
player.addEventListener('state', () => {
  if (player.playing !== lastPlaying) {
    lastPlaying = player.playing;
    notify('player-playstate');
  }
  if (!barRaf) {
    barRaf = requestAnimationFrame(() => {
      barRaf = 0;
      updatePlayerBar();
      notify('player');
    });
  }
});
player.addEventListener('error', () => toast("Couldn't play this file in this browser."));

$('pb-play').addEventListener('click', () => player.toggle());
$('pb-prev').addEventListener('click', () => player.prev());
$('pb-next').addEventListener('click', () => player.next());
$('pb-volume').addEventListener('input', (e) => {
  player.audio.volume = Number(e.target.value);
});

(() => {
  const bar = $('pb-bar');
  let dragging = false;
  const seekTo = (e) => {
    const r = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    player.seek(frac * player.duration);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!player.track) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    seekTo(e);
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragging) seekTo(e);
  });
  bar.addEventListener('pointerup', () => {
    dragging = false;
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') player.seek(player.currentTime + 5);
    else if (e.key === 'ArrowLeft') player.seek(player.currentTime - 5);
    else return;
    e.preventDefault();
  });
})();

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag) || e.target.isContentEditable) return;
  if (e.key === ' ') {
    e.preventDefault();
    player.toggle();
  }
});

// ---------- key notation ----------

function renderNotation() {
  for (const b of document.querySelectorAll('[data-notation]')) {
    const on = b.dataset.notation === getNotation();
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

for (const b of document.querySelectorAll('[data-notation]')) {
  b.addEventListener('click', () => {
    if (b.dataset.notation === getNotation()) return;
    setNotation(b.dataset.notation);
    db.put('kv', getNotation(), 'notation');
    renderNotation();
    $('pb-key').dataset.k = '';
    updatePlayerBar();
    mount(state.view);
  });
}

// ---------- settings ----------

const settingsDialog = $('settings');
$('settings-btn').addEventListener('click', () => {
  const form = settingsDialog.querySelector('form');
  for (const [k, v] of Object.entries(library.options)) if (form.elements[k]) form.elements[k].value = String(v);
  settingsDialog.showModal();
});
settingsDialog.addEventListener('close', async () => {
  if (settingsDialog.returnValue !== 'save') return;
  const form = settingsDialog.querySelector('form');
  const options = {
    sensitivity: form.elements.sensitivity.value,
    noKey: form.elements.noKey.value,
    minSectionSec: Number(form.elements.minSectionSec.value),
    profile: form.elements.profile.value,
  };
  await db.put('kv', options, 'options');
  library.setOptions(options);
  toast('Settings saved. Re-analyzing in the background.');
});

// ---------- library events ----------

let sidebarTimer = 0;
function scheduleSidebar() {
  if (sidebarTimer) return;
  sidebarTimer = setTimeout(() => {
    sidebarTimer = 0;
    renderSidebar();
  }, 150);
}

library.addEventListener('scan', (e) => {
  state.scan = e.detail;
  if (e.detail.done && !e.detail.found) toast(`No FLAC, WAV or MP3 files were found in “${library.rootName}”.`, 5000);
  scheduleSidebar();
});
library.addEventListener('changed', () => {
  notify('library');
  scheduleSidebar();
});
library.addEventListener('queue', scheduleSidebar);
library.addEventListener('track', (e) => {
  const t = e.detail;
  notify('track', t);
  if (t.status === 'done' && sets.sets.some((s) => s.tracks.some((x) => x.path === t.path))) sets.refreshTrack(t);
  if (t === player.track) updatePlayerBar();
});
library.addEventListener('progress', (e) => notify('progress', e.detail));
sets.addEventListener('changed', (e) => {
  renderSetNav();
  notify('sets', e.detail);
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    notify('resize');
    drawSeek();
  }, 120);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  notify('resize');
  drawSeek();
});

// ---------- start ----------

(async function init() {
  setNotation((await db.get('kv', 'notation')) || 'camelot');
  renderNotation();
  const saved = await db.get('kv', 'options');
  library.options = { ...DEFAULT_OPTIONS, ...(saved || {}) };
  state.activeSetId = (await db.get('kv', 'activeSetId')) || null;
  await sets.load();
  mount({ type: 'library' });
  updatePlayerBar();
  try {
    state.folderStatus = await library.restoreHandle(false);
    if (state.folderStatus === 'granted') state.folderStatus = null;
  } catch (err) {
    console.warn('Could not restore the music folder', err);
  }
  renderSidebar();
  if (state.view.type === 'library') state.mounted.update('library');
})();
