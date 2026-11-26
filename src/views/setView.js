// A DJ set: ordered tracks, harmonic transitions between them, and suggestions.
import { el, formatTime, keyChip, download, toast } from '../ui.js';
import { mixCompatibility } from '../compat.js';
import { trackChangesCell } from './libraryView.js';

export function mountSetView(root, ctx, { id }) {
  const { library, sets, player } = ctx;

  function entryKeys(entry) {
    const t = library.byPath.get(entry.path);
    if (t?.analysis) return { start: t.analysis.startKey, end: t.analysis.endKey, analysed: true };
    if (entry.startKey !== undefined) return { start: entry.startKey, end: entry.endKey, analysed: true };
    return { start: null, end: null, analysed: false };
  }

  function playable(set) {
    return set.tracks.map((e) => library.byPath.get(e.path)).filter(Boolean);
  }

  function render() {
    const set = sets.get(id);
    root.replaceChildren();
    if (!set) {
      root.append(el('div', { class: 'card empty' }, el('p', {}, 'This set was deleted.')));
      return;
    }

    const total = set.tracks.reduce((t, e) => t + (library.byPath.get(e.path)?.meta.duration || e.duration || 0), 0);
    const nameInput = el('input', { class: 'set-name', value: set.name, 'aria-label': 'Set name', maxlength: 80 });
    nameInput.addEventListener('change', () => sets.rename(set, nameInput.value));
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur();
    });

    let clashes = 0;
    for (let i = 1; i < set.tracks.length; i++) {
      const a = entryKeys(set.tracks[i - 1]);
      const b = entryKeys(set.tracks[i]);
      if (a.analysed && b.analysed && mixCompatibility(a.end, b.start).level === 'clash') clashes++;
    }

    root.append(
      el(
        'div',
        { class: 'set-head' },
        el(
          'div',
          { class: 'set-title' },
          nameInput,
          el(
            'div',
            { class: 'muted' },
            `${set.tracks.length} track${set.tracks.length === 1 ? '' : 's'} · ${formatTime(total)}`,
            set.tracks.length > 1 ? ` · ${clashes ? `${clashes} key clash${clashes === 1 ? '' : 'es'}` : 'all transitions are harmonic'}` : '',
          ),
        ),
        el(
          'div',
          { class: 'row-gap wrap' },
          el('button', { class: 'btn primary', type: 'button', disabled: !playable(set).length, onclick: () => {
            const q = playable(set);
            ctx.playTrack(q[0], { queue: q, context: { type: 'set', id } });
          } }, '▶ Play set'),
          el('button', { class: 'btn ghost small', type: 'button', onclick: () => exportM3u(set) }, 'Export M3U8'),
          el('button', { class: 'btn ghost small', type: 'button', onclick: () => exportCsv(set) }, 'Export CSV'),
          el('button', { class: 'btn ghost small danger', type: 'button', onclick: async () => {
            if (!confirm(`Delete the set “${set.name}”? The music files are not affected.`)) return;
            await sets.remove(set);
            ctx.go({ type: 'library' });
          } }, 'Delete set'),
        ),
      ),
    );

    const list = el('ol', { class: 'set-list' });
    if (!set.tracks.length) {
      list.append(el('li', { class: 'set-empty' }, 'Drag tracks here from the library, or use the + button next to a track.'));
    }
    set.tracks.forEach((entry, i) => {
      if (i > 0) list.append(transitionEl(set.tracks[i - 1], entry));
      list.append(entryEl(set, entry, i));
    });
    root.append(list);

    attachDrop(list, set);
    root.append(suggestions(set));
  }

  function transitionEl(prev, next) {
    const a = entryKeys(prev);
    const b = entryKeys(next);
    if (!a.analysed || !b.analysed) return el('li', { class: 'transition unknown' }, el('span', { class: 'muted' }, 'Mix: waiting for analysis'));
    const c = mixCompatibility(a.end, b.start);
    return el(
      'li',
      { class: `transition ${c.level}`, title: 'Ending key of the previous track → starting key of the next' },
      el('span', { class: 'dot' }),
      keyChip(a.end || { key: null, kind: 'atonal' }, { compact: true }),
      el('span', { class: 'arrow' }, '→'),
      keyChip(b.start || { key: null, kind: 'atonal' }, { compact: true }),
      el('span', { class: 'mix-label' }, c.label),
    );
  }

  function entryEl(set, entry, i) {
    const track = library.byPath.get(entry.path);
    const keys = entryKeys(entry);
    const playing = track && player.track === track;
    const item = el(
      'li',
      { class: `set-item ${track ? '' : 'missing'} ${playing ? 'playing' : ''}`, draggable: 'true', dataset: { index: i } },
      el('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
      el('span', { class: 'num' }, i + 1),
      el(
        'button',
        { class: 'icon-btn play', type: 'button', disabled: !track, 'aria-label': `Play ${entry.title}`, onclick: () => {
          if (playing) player.toggle();
          else {
            const q = playable(set);
            ctx.playTrack(track, { queue: q, context: { type: 'set', id } });
          }
        } },
        playing && player.playing ? '❚❚' : '▶',
      ),
      el(
        'div',
        { class: 'set-track' },
        track
          ? el('button', { class: 'link', type: 'button', onclick: () => ctx.openTrack(track) }, track.meta.title)
          : el('span', {}, entry.title),
        el('span', { class: 'sub' }, track ? track.meta.artist : `${entry.artist ? `${entry.artist} · ` : ''}not in the loaded library`),
      ),
      el(
        'div',
        { class: 'set-keys' },
        keys.analysed
          ? [keyChip(keys.start || { key: null, kind: 'atonal' }, { compact: true }), keys.end && keys.start && keys.end.key !== keys.start.key ? [el('span', { class: 'arrow' }, '→'), keyChip(keys.end, { compact: true })] : null]
          : el('span', { class: 'muted' }, track?.status === 'error' ? "Can't decode" : 'Analyzing…'),
      ),
      el('div', { class: 'set-badges' }, track ? trackChangesCell(track) : null),
      el('span', { class: 'time muted' }, formatTime(track?.meta.duration || entry.duration)),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove from set', title: 'Remove from set', onclick: () => sets.removeAt(sets.get(id), i) }, '✕'),
    );
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-set-index', String(i));
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    return item;
  }

  function attachDrop(list, set) {
    let marker = null;
    const indexAt = (e) => {
      const items = [...list.querySelectorAll('.set-item')];
      for (const it of items) {
        const r = it.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return Number(it.dataset.index);
      }
      return items.length;
    };
    const clearMarker = () => {
      marker?.classList.remove('drop-before', 'drop-after');
      list.classList.remove('drop-end');
      marker = null;
    };
    list.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (!types.includes('application/x-set-index') && !types.includes('application/x-track-path')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = types.includes('application/x-set-index') ? 'move' : 'copy';
      clearMarker();
      const idx = indexAt(e);
      const target = list.querySelector(`.set-item[data-index="${idx}"]`);
      if (target) {
        marker = target;
        target.classList.add('drop-before');
      } else list.classList.add('drop-end');
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) clearMarker();
    });
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearMarker();
      const idx = indexAt(e);
      const from = e.dataTransfer.getData('application/x-set-index');
      const path = e.dataTransfer.getData('application/x-track-path');
      if (from !== '') await sets.move(set, Number(from), idx);
      else if (path) {
        const t = library.byPath.get(path);
        if (t) await sets.addTracks(set, [t], idx);
      }
    });
  }

  function suggestions(set) {
    const box = el('div', { class: 'card suggest' });
    const last = set.tracks[set.tracks.length - 1];
    const inSet = new Set(set.tracks.map((e) => e.path));
    const outKey = last ? entryKeys(last).end : null;
    const head = el(
      'div',
      { class: 'card-head' },
      el('h3', {}, last ? 'Suggested next tracks' : 'Start your set'),
      el('span', { class: 'hint' }, last ? (outKey ? `Starting in keys that mix with ${outKey.name} (${outKey.camelot})` : 'The last track ends with no key, so any key works') : 'Pick any track to begin'),
    );
    box.append(head);
    if (!last) return box;
    const candidates = library.tracks
      .filter((t) => t.analysis && !inSet.has(t.path))
      .map((t) => ({ t, c: mixCompatibility(outKey, t.analysis.startKey) }))
      .filter((x) => x.c.level !== 'clash')
      .sort((x, y) => y.c.score - x.c.score || x.t.meta.title.localeCompare(y.t.meta.title))
      .slice(0, 12);
    if (!candidates.length) {
      box.append(el('p', { class: 'muted' }, library.tracks.length ? 'No analysed tracks mix well with the last track yet.' : 'Load your music folder to get suggestions.'));
      return box;
    }
    const ul = el('ul', { class: 'suggest-list' });
    for (const { t, c } of candidates) {
      ul.append(
        el(
          'li',
          { class: `suggest-item ${c.level}`, draggable: 'true', ondragstart: (e) => {
            e.dataTransfer.setData('application/x-track-path', t.path);
            e.dataTransfer.effectAllowed = 'copy';
          } },
          el('button', { class: 'icon-btn play', type: 'button', 'aria-label': `Preview ${t.meta.title}`, onclick: () => ctx.playTrack(t) }, '▶'),
          el('div', { class: 'set-track' }, el('button', { class: 'link', type: 'button', onclick: () => ctx.openTrack(t) }, t.meta.title), el('span', { class: 'sub' }, t.meta.artist)),
          keyChip(t.analysis.startKey || { key: null, kind: 'atonal' }, { compact: true }),
          el('span', { class: 'mix-label' }, el('span', { class: 'dot' }), c.label),
          el('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
            await sets.addTracks(set, [t]);
            toast(`Added “${t.meta.title}”`);
          } }, '+ Add'),
        ),
      );
    }
    box.append(ul);
    return box;
  }

  function exportM3u(set) {
    const lines = ['#EXTM3U', `#PLAYLIST:${set.name}`];
    for (const e of set.tracks) {
      const t = library.byPath.get(e.path);
      const dur = Math.round(t?.meta.duration || e.duration || -1);
      const artist = t?.meta.artist || e.artist;
      lines.push(`#EXTINF:${dur},${artist ? `${artist} - ` : ''}${t?.meta.title || e.title}`, e.path);
    }
    download(`${set.name.replace(/[\\/:*?"<>|]+/g, '_')}.m3u8`, 'audio/x-mpegurl', lines.join('\n') + '\n');
    toast('Save the playlist in your music folder so the track paths resolve.', 4000);
  }

  function exportCsv(set) {
    const rows = [['#', 'title', 'artist', 'start_key', 'start_camelot', 'end_key', 'end_camelot', 'duration', 'mix_into_next', 'path']];
    set.tracks.forEach((e, i) => {
      const t = library.byPath.get(e.path);
      const k = entryKeys(e);
      const next = set.tracks[i + 1];
      const mix = next ? mixCompatibility(k.end, entryKeys(next).start).label : '';
      rows.push([i + 1, t?.meta.title || e.title, t?.meta.artist || e.artist || '', k.start?.name || 'No key', k.start?.camelot || '', k.end?.name || 'No key', k.end?.camelot || '', formatTime(t?.meta.duration || e.duration), mix, e.path]);
    });
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    download(`${set.name.replace(/[\\/:*?"<>|]+/g, '_')}.csv`, 'text/csv', csv);
  }

  render();

  let timer = 0;
  return {
    update(reason, detail) {
      if (reason === 'sets' && (!detail || detail.id === id)) render();
      else if (reason === 'track' || reason === 'library') {
        clearTimeout(timer);
        timer = setTimeout(render, 300);
      } else if (reason === 'player-track' || reason === 'player-playstate') render();
    },
    unmount() {
      clearTimeout(timer);
    },
  };
}
