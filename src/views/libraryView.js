// The library browser: searchable, sortable, virtualised track table.
import { el, formatTime, keyChip } from '../ui.js';
import { mixCompatibility, parseCamelot } from '../compat.js';

const ROW_HEIGHT = 48;

const COLUMNS = [
  { id: 'play', label: '', sortable: false },
  { id: 'title', label: 'Title' },
  { id: 'artist', label: 'Artist' },
  { id: 'key', label: 'Key' },
  { id: 'changes', label: 'Key changes' },
  { id: 'duration', label: 'Time' },
  { id: 'bpm', label: 'BPM' },
  { id: 'add', label: '', sortable: false },
];

function camelotSortValue(info) {
  const c = info && parseCamelot(info.camelot);
  return c ? c.num * 2 + (c.letter === 'B' ? 1 : 0) : 99;
}

export function trackKeyCell(track) {
  const a = track.analysis;
  if (track.status === 'error') return el('span', { class: 'muted warn', title: track.error }, "Can't decode");
  if (!a) return el('span', { class: 'muted' }, track.status === 'analyzing' ? 'Analyzing…' : 'Queued');
  if (!a.startKey) return keyChip(a.sections[0] || { key: null, kind: 'atonal' }, { compact: true });
  const box = el('span', { class: 'key-cell' }, keyChip(a.startKey, { compact: true }));
  if (a.endKey && a.endKey.key !== a.startKey.key) box.append(el('span', { class: 'arrow' }, '→'), keyChip(a.endKey, { compact: true }));
  return box;
}

export function trackChangesCell(track) {
  const a = track.analysis;
  if (!a) return el('span', { class: 'muted' }, '');
  const parts = [];
  if (a.changes.length) parts.push(el('span', { class: 'badge change' }, `${a.changes.length} change${a.changes.length === 1 ? '' : 's'}`));
  const noKey = a.sections.filter((s) => s.key == null && s.kind === 'atonal').length;
  if (noKey && a.startKey) parts.push(el('span', { class: 'badge nokey', title: 'Has sections with no key (drums, samples, noise)' }, `${noKey} no-key`));
  if (!parts.length) parts.push(el('span', { class: 'muted' }, '–'));
  return el('span', { class: 'badges' }, parts);
}

export function mountLibraryView(root, ctx) {
  const { library, player, state } = ctx;
  const view = state.libraryView;
  let rows = [];
  let rendered = new Map();

  const search = el('input', { type: 'search', class: 'search', placeholder: 'Search title, artist, album, folder…', value: view.search, 'aria-label': 'Search library' });
  const filter = el(
    'select',
    { class: 'filter', 'aria-label': 'Filter by key' },
    el('option', { value: '' }, 'All tracks'),
    el('option', { value: 'changes' }, 'With key changes'),
    el('option', { value: 'nokey-parts' }, 'With no-key sections'),
    el('option', { value: 'nokey' }, 'No key at all'),
    el('option', { value: 'unanalyzed' }, 'Not analyzed yet'),
    el(
      'optgroup',
      { label: 'Starting key' },
      Array.from({ length: 24 }, (_, i) => {
        const code = `${Math.floor(i / 2) + 1}${i % 2 ? 'B' : 'A'}`;
        return el('option', { value: `key:${code}` }, code);
      }),
    ),
  );
  filter.value = view.filter;
  const matchBtn = el('button', { class: 'btn ghost small', type: 'button', 'aria-pressed': String(!!view.matchPath) });
  const countEl = el('span', { class: 'count muted' });

  const header = el(
    'div',
    { class: 'lib-row lib-header', role: 'row' },
    COLUMNS.map((c) =>
      el(
        'div',
        { class: `cell c-${c.id} ${c.sortable === false ? '' : 'sortable'}`, role: 'columnheader', dataset: { col: c.id } },
        c.label,
        view.sort === c.id ? el('span', { class: 'sort-ind' }, view.desc ? ' ▾' : ' ▴') : null,
      ),
    ),
  );
  header.addEventListener('click', (e) => {
    const col = e.target.closest('.sortable')?.dataset.col;
    if (!col) return;
    if (view.sort === col) view.desc = !view.desc;
    else {
      view.sort = col;
      view.desc = false;
    }
    view.matchPath = null;
    remount();
  });

  const spacer = el('div', { class: 'lib-spacer' });
  const scroller = el('div', { class: 'lib-scroll', role: 'rowgroup' }, spacer);
  const table = el('div', { class: 'lib-table', role: 'table', 'aria-label': 'Music library' }, header, scroller);

  root.replaceChildren(
    el('div', { class: 'lib-toolbar' }, search, filter, matchBtn, countEl),
    library.tracks.length ? table : emptyState(),
  );

  function emptyState() {
    return ctx.renderLibraryEmpty();
  }

  function remount() {
    ctx.rerender();
  }

  function compute() {
    const q = view.search.trim().toLowerCase();
    let list = library.tracks;
    if (q) {
      list = list.filter((t) => `${t.meta.title} ${t.meta.artist} ${t.meta.album} ${t.path}`.toLowerCase().includes(q));
    }
    const f = view.filter;
    if (f === 'changes') list = list.filter((t) => t.analysis?.changes.length);
    else if (f === 'nokey-parts') list = list.filter((t) => t.analysis?.sections.some((s) => s.key == null && s.kind === 'atonal'));
    else if (f === 'nokey') list = list.filter((t) => t.analysis && !t.analysis.startKey);
    else if (f === 'unanalyzed') list = list.filter((t) => !t.analysis);
    else if (f.startsWith('key:')) list = list.filter((t) => t.analysis?.startKey?.camelot === f.slice(4));

    const match = view.matchPath && library.byPath.get(view.matchPath);
    if (match?.analysis) {
      const out = match.analysis.endKey;
      list = list
        .filter((t) => t !== match && t.analysis)
        .map((t) => ({ t, c: mixCompatibility(out, t.analysis.startKey) }))
        .filter((x) => x.c.level !== 'clash')
        .sort((x, y) => y.c.score - x.c.score || x.t.meta.title.localeCompare(y.t.meta.title))
        .map((x) => x.t);
      rows = list;
      return;
    }

    const dir = view.desc ? -1 : 1;
    const val = {
      title: (t) => t.meta.title.toLowerCase(),
      artist: (t) => (t.meta.artist || '￿').toLowerCase(),
      key: (t) => camelotSortValue(t.analysis?.startKey),
      changes: (t) => (t.analysis ? t.analysis.changes.length : -1),
      duration: (t) => t.meta.duration || t.analysis?.duration || 0,
      bpm: (t) => Number(t.meta.bpm) || 0,
    }[view.sort];
    rows = val ? [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir || a.path.localeCompare(b.path);
    }) : list;
  }

  function updateToolbar() {
    const sel = state.selectedPath && library.byPath.get(state.selectedPath);
    const match = view.matchPath && library.byPath.get(view.matchPath);
    matchBtn.disabled = !match && !(sel && sel.analysis);
    matchBtn.setAttribute('aria-pressed', String(!!match));
    matchBtn.textContent = match ? `Mixes with “${match.meta.title}” ✕` : 'Show tracks that mix with selected';
    matchBtn.title = 'Lists tracks whose starting key mixes harmonically with the selected track’s ending key';
    const total = library.tracks.length;
    countEl.textContent = rows.length === total ? `${total} tracks` : `${rows.length} of ${total} tracks`;
  }

  function rowEl(track, i) {
    const playing = player.track === track;
    const row = el(
      'div',
      {
        class: `lib-row ${state.selectedPath === track.path ? 'selected' : ''} ${playing ? 'playing' : ''}`,
        role: 'row',
        draggable: 'true',
        style: `top:${i * ROW_HEIGHT}px`,
        dataset: { path: track.path },
      },
      el('div', { class: 'cell c-play' }, el('button', { class: 'icon-btn play', type: 'button', 'aria-label': `Play ${track.meta.title}`, dataset: { act: 'play' } }, playing && player.playing ? '❚❚' : '▶')),
      el(
        'div',
        { class: 'cell c-title' },
        el('button', { class: 'link', type: 'button', dataset: { act: 'open' }, title: 'Show key analysis' }, track.meta.title),
        el('span', { class: 'sub' }, track.meta.artist || track.folder),
      ),
      el('div', { class: 'cell c-artist' }, track.meta.artist),
      el('div', { class: 'cell c-key' }, trackKeyCell(track)),
      el('div', { class: 'cell c-changes' }, trackChangesCell(track)),
      el('div', { class: 'cell c-duration' }, formatTime(track.meta.duration || track.analysis?.duration)),
      el('div', { class: 'cell c-bpm' }, track.meta.bpm || ''),
      el('div', { class: 'cell c-add' }, el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Add to set', title: 'Add to the current set', dataset: { act: 'add' } }, '+')),
    );
    return row;
  }

  function paint(force = false) {
    if (!scroller.isConnected) return;
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const top = scroller.scrollTop;
    const h = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 8);
    const last = Math.min(rows.length, Math.ceil((top + h) / ROW_HEIGHT) + 8);
    const next = new Map();
    for (let i = first; i < last; i++) {
      const t = rows[i];
      let node = rendered.get(t);
      if (!node || force || node.dataset.index !== String(i)) {
        const fresh = rowEl(t, i);
        fresh.dataset.index = i;
        if (node) node.replaceWith(fresh);
        else scroller.append(fresh);
        node = fresh;
      }
      next.set(t, node);
    }
    for (const [t, node] of rendered) if (!next.has(t)) node.remove();
    rendered = next;
  }

  function refreshRow(track) {
    const node = rendered.get(track);
    if (!node) return;
    const fresh = rowEl(track, Number(node.dataset.index));
    fresh.dataset.index = node.dataset.index;
    node.replaceWith(fresh);
    rendered.set(track, fresh);
  }

  function trackFromEvent(e) {
    const row = e.target.closest('.lib-row[data-path]');
    return row ? library.byPath.get(row.dataset.path) : null;
  }

  scroller.addEventListener('scroll', () => paint());
  scroller.addEventListener('click', (e) => {
    const track = trackFromEvent(e);
    if (!track) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') {
      if (player.track === track) player.toggle();
      else ctx.playTrack(track, { queue: rows, context: { type: 'library' } });
    } else if (act === 'open') ctx.openTrack(track);
    else if (act === 'add') ctx.addToActiveSet([track]);
    const prev = state.selectedPath && library.byPath.get(state.selectedPath);
    state.selectedPath = track.path;
    if (prev && prev !== track) refreshRow(prev);
    refreshRow(track);
    updateToolbar();
  });
  scroller.addEventListener('dblclick', (e) => {
    const track = trackFromEvent(e);
    if (track && !e.target.closest('[data-act]')) ctx.playTrack(track, { queue: rows, context: { type: 'library' } });
  });
  scroller.addEventListener('dragstart', (e) => {
    const track = trackFromEvent(e);
    if (!track) return;
    e.dataTransfer.setData('application/x-track-path', track.path);
    e.dataTransfer.setData('text/plain', track.meta.title);
    e.dataTransfer.effectAllowed = 'copy';
  });

  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      view.search = search.value;
      compute();
      scroller.scrollTop = 0;
      paint(true);
      updateToolbar();
    }, 120);
  });
  filter.addEventListener('change', () => {
    view.filter = filter.value;
    compute();
    scroller.scrollTop = 0;
    paint(true);
    updateToolbar();
  });
  matchBtn.addEventListener('click', () => {
    view.matchPath = view.matchPath ? null : state.selectedPath;
    compute();
    scroller.scrollTop = 0;
    paint(true);
    updateToolbar();
  });

  compute();
  updateToolbar();
  requestAnimationFrame(() => {
    if (view.scrollTop) scroller.scrollTop = view.scrollTop;
    paint(true);
  });
  scroller.addEventListener('scroll', () => {
    view.scrollTop = scroller.scrollTop;
  });

  let pendingRecompute = 0;
  return {
    update(reason, detail) {
      if (reason === 'track') {
        // Re-sort/filter lazily: analysis results can move rows.
        if (view.filter || view.matchPath || ['key', 'changes'].includes(view.sort)) {
          clearTimeout(pendingRecompute);
          pendingRecompute = setTimeout(() => {
            compute();
            paint(true);
            updateToolbar();
          }, 400);
        } else refreshRow(detail);
      } else if (reason === 'library') {
        if (!library.tracks.length || !table.isConnected) {
          remount();
          return;
        }
        compute();
        paint(true);
        updateToolbar();
      } else if (reason === 'player-track' || reason === 'player-playstate') {
        paint(true);
      } else if (reason === 'resize') paint();
    },
    unmount() {
      clearTimeout(pendingRecompute);
    },
  };
}
