// Detailed analysis of one track: key journey, timeline, key changes, no-key sections.
import { el, formatTime, keyChip, keyColor, keyTextColor, setupCanvas, cssVar, paintSections, drawStripes, download, keyText, keyShort, describeCertainty, certaintyBadge, candidateBars } from '../ui.js';

export function mountTrackView(root, ctx, { path }) {
  const { library, player } = ctx;
  let track = library.byPath.get(path);
  let canvas = null;
  let rawCanvas = null;
  let timelineEl = null;
  let hoverTip = null;
  let progressEl = null;

  function render() {
    track = library.byPath.get(path);
    root.replaceChildren();
    if (!track) {
      root.append(el('div', { class: 'card empty' }, el('p', {}, 'This track is no longer in the library.'), backButton()));
      return;
    }
    const m = track.meta;
    const a = track.analysis;

    const header = el(
      'div',
      { class: 'track-head' },
      backButton(),
      el(
        'div',
        { class: 'track-title' },
        el('h2', {}, m.title),
        el('div', { class: 'track-sub' }, [m.artist, m.album].filter(Boolean).join(' · ') || track.folder || ' '),
        el(
          'div',
          { class: 'track-meta' },
          [m.format, formatTime(m.duration || a?.duration), m.sampleRate && `${(m.sampleRate / 1000).toFixed(1)} kHz`, m.bpm && `${m.bpm} BPM (tag)`]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      el(
        'div',
        { class: 'track-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => ctx.playTrack(track) }, '▶ Play'),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => ctx.addToActiveSet([track]) }, '+ Add to set'),
        a && el('button', { class: 'btn ghost', type: 'button', onclick: reanalyze }, 'Re-analyze'),
      ),
    );
    root.append(header);

    if (track.status === 'error') {
      root.append(el('div', { class: 'card error', role: 'alert' }, `Couldn't analyze this file: ${track.error}.`));
      return;
    }
    if (!a || track.status === 'analyzing' || (track.status === 'pending' && !a)) {
      progressEl = el('div', { class: 'progress' }, el('div', { class: 'bar' }));
      root.append(
        el('div', { class: 'card status' }, el('div', { class: 'status-row' }, el('span', { class: 'status-text' }, track.status === 'analyzing' ? 'Analyzing…' : 'Waiting to be analyzed…'), el('span', { class: 'status-pct' })), progressEl),
      );
      library.prioritize(track);
      return;
    }
    progressEl = null;

    root.append(summaryCard(a), timelineCard(a), eventsCard(a), sectionsCard(a));
    root.append(
      el(
        'p',
        { class: 'footnote' },
        'Keys are found by comparing the pitch content with major and minor key profiles, so closely related keys (such as C major and A minor) can be confused. ',
        '"No key" marks parts with too little pitched content to have a key: drums, percussion, noise, speech or other unpitched samples. ',
        Math.abs(a.tuningCents) >= 5 ? `This recording is tuned ${Math.abs(a.tuningCents)} cents ${a.tuningCents > 0 ? 'sharp' : 'flat'} of A440; the analysis compensates for that.` : '',
      ),
    );
    requestAnimationFrame(draw);
  }

  function backButton() {
    return el('button', { class: 'btn ghost back', type: 'button', onclick: () => ctx.back() }, '← Back');
  }

  function reanalyze() {
    track.status = 'pending';
    library.prioritize(track);
    render();
  }

  function summaryCard(a) {
    const body = el('div', { class: 'summary-body' });
    const keyed = a.sections.filter((s) => s.key != null);
    const noKey = a.sections.filter((s) => s.key == null && s.kind === 'atonal');
    const noKeyTime = noKey.reduce((t, s) => t + s.end - s.start, 0);

    const journey = el('div', { class: 'journey big' });
    const collapsed = a.sections.filter((s, i) => i === 0 || s.key !== a.sections[i - 1].key || s.kind !== a.sections[i - 1].kind);
    collapsed.forEach((s, i) => {
      if (i > 0) journey.append(el('span', { class: 'arrow' }, '→'));
      journey.append(keyChip(s));
    });
    body.append(journey);

    let text;
    if (!keyed.length) {
      text = a.silent ? 'This file is silent.' : 'No key was detected anywhere in this track. It is atonal, percussive or unpitched throughout.';
    } else if (a.changes.length === 0) {
      text = `The track stays in ${keyText(keyed[0])}. No key changes were detected.`;
    } else {
      const n = a.changes.length;
      text = `${n} key change${n === 1 ? '' : 's'}. Starts in ${keyText(a.startKey)} and ends in ${keyText(a.endKey)}. Most of the track is in ${keyText(a.overall)}.`;
    }
    if (noKey.length) text += ` ${noKey.length} section${noKey.length === 1 ? ' has' : 's have'} no key (${formatTime(noKeyTime)} in total).`;
    body.append(el('p', { class: 'summary-text' }, text));

    const tagKey = track.meta.tagKey;
    if (tagKey) body.append(el('p', { class: 'summary-text small' }, `Key stored in the file's tags: ${tagKey}`));

    if (a.startKey) {
      // Confidence for the keys a DJ cares about: where the track starts and ends.
      const sameEnds = a.startKey.key === a.endKey.key && keyed.length === 1;
      const conf = el('div', { class: 'confidence-grid' });
      const block = (label, info) =>
        el(
          'div',
          { class: `conf-block cert-${info.certainty || 'none'}` },
          el('div', { class: 'conf-head' }, el('span', { class: 'muted small' }, label), certaintyBadge(info, { withAlternatives: false })),
          el('div', { class: 'conf-text' }, describeCertainty(info)),
          info.certainty ? candidateBars(info) : null,
        );
      conf.append(block(sameEnds ? 'Key' : 'Mix in (start)', a.startKey));
      if (!sameEnds) conf.append(block('Mix out (end)', a.endKey));
      body.append(conf);
    }
    return el('div', { class: 'card summary' }, body);
  }

  function timelineCard(a) {
    canvas = el('canvas', { class: 'wave' });
    hoverTip = el('div', { class: 'hover-tip', hidden: true });
    timelineEl = el('div', { class: 'timeline' }, canvas, hoverTip);
    rawCanvas = el('canvas', { class: 'raw-strip' });
    timelineEl.addEventListener('click', (e) => {
      const t = timeAt(e.clientX, a);
      if (player.track === track) player.seek(t);
      ctx.playTrack(track, { startAt: t });
    });
    timelineEl.addEventListener('mousemove', (e) => {
      const t = timeAt(e.clientX, a);
      const s = a.sections.find((sec) => t >= sec.start && t < sec.end) || a.sections[a.sections.length - 1];
      hoverTip.hidden = false;
      const rect = timelineEl.getBoundingClientRect();
      hoverTip.style.left = `${Math.max(8, Math.min(92, ((e.clientX - rect.left) / rect.width) * 100))}%`;
      hoverTip.textContent = s ? `${formatTime(t)} · ${keyText(s)}${s.certainty === 'uncertain' ? ' (unsure)' : ''}` : formatTime(t);
    });
    timelineEl.addEventListener('mouseleave', () => {
      hoverTip.hidden = true;
    });

    const legend = el('div', { class: 'legend' });
    const seen = new Set();
    for (const s of a.sections) {
      const id = s.key ?? s.kind;
      if (seen.has(id)) continue;
      seen.add(id);
      legend.append(keyChip(s));
    }

    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Timeline'), el('span', { class: 'hint' }, 'Click to play from any point')),
      timelineEl,
      el('div', { class: 'raw-strip-wrap' }, rawCanvas, el('span', { class: 'raw-label' }, 'Second-by-second estimate')),
      axis(a.duration),
      legend,
    );
  }

  function axis(d) {
    const box = el('div', { class: 'axis' });
    const width = root.clientWidth || 600;
    const steps = [5, 10, 15, 30, 60, 120, 300, 600];
    const target = Math.max(2, Math.floor(width / 80));
    const step = steps.find((s) => d / s <= target) || 1200;
    for (let t = 0; t <= d - step * 0.5; t += step) box.append(el('span', { style: `left:${(t / d) * 100}%` }, formatTime(t)));
    box.append(el('span', { style: 'left:100%' }, formatTime(d)));
    return box;
  }

  function hearButton(t) {
    return el('button', { class: 'btn ghost small', type: 'button', onclick: () => ctx.playTrack(track, { startAt: Math.max(0, t) }) }, '▶ Hear it');
  }

  function eventsCard(a) {
    const list = el('ol', { class: 'events' });
    const items = [
      ...a.changes.map((c) => ({ time: c.time, type: 'change', c })),
      ...a.sections.filter((s) => s.key == null).map((s) => ({ time: s.start, type: 'nokey', s })),
    ].sort((x, y) => x.time - y.time);

    for (const item of items) {
      if (item.type === 'change') {
        const c = item.c;
        const desc = [c.movement, c.relation, c.acrossNoKey ? 'after a no-key section' : null].filter(Boolean).join(' · ');
        list.append(
          el(
            'li',
            { class: 'event change' },
            el('span', { class: 'event-time' }, formatTime(c.time)),
            el('div', { class: 'journey' }, keyChip(c.from), el('span', { class: 'arrow' }, '→'), keyChip(c.to)),
            el('span', { class: 'event-desc' }, `Key change · ${desc}`),
            hearButton(c.time - 5),
          ),
        );
      } else {
        const s = item.s;
        const desc =
          s.kind === 'silence'
            ? `Silence for ${formatTime(s.end - s.start)}`
            : `No key for ${formatTime(s.end - s.start)}: drums, percussion, noise or unpitched samples`;
        list.append(
          el(
            'li',
            { class: 'event nokey' },
            el('span', { class: 'event-time' }, formatTime(s.start)),
            el('div', { class: 'journey' }, keyChip(s), el('span', { class: 'range' }, `${formatTime(s.start)} – ${formatTime(s.end)}`)),
            el('span', { class: 'event-desc' }, desc),
            hearButton(s.start),
          ),
        );
      }
    }
    if (!items.length) {
      const k = a.sections[0];
      list.append(el('li', { class: 'none' }, k && k.key != null ? `No key changes and no keyless sections. The track is in ${keyText(k)} throughout.` : 'Nothing to show.'));
    }
    return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Key changes & no-key sections')), list);
  }

  function sectionsCard(a) {
    const tbody = el('tbody');
    a.sections.forEach((s, i) => {
      tbody.append(
        el(
          'tr',
          { dataset: { index: i } },
          el('td', {}, i + 1),
          el('td', {}, `${formatTime(s.start)} – ${formatTime(s.end)}`),
          el('td', {}, keyChip(s)),
          el('td', {}, s.key == null || !s.certainty ? el('span', { class: 'muted' }, '–') : el('span', { class: 'conf', title: describeCertainty(s) }, certaintyBadge(s, { withAlternatives: false }), `${Math.round(s.confidence * 100)}%`)),
          el(
            'td',
            { class: 'muted' },
            s.alternatives?.filter((x) => x.probability == null || x.probability >= 0.02).map((x) => `${keyText(x)}${x.probability != null ? ` ${Math.round(x.probability * 100)}%` : ''}`).join(', ') || '–',
          ),
          el('td', {}, el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Play section ${i + 1}`, onclick: () => ctx.playTrack(track, { startAt: s.start }) }, '▶')),
        ),
      );
    });
    return el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h3', {}, 'Sections'),
        el('div', { class: 'row-gap' }, el('button', { class: 'btn ghost small', type: 'button', onclick: () => exportCsv(a) }, 'Export CSV'), el('button', { class: 'btn ghost small', type: 'button', onclick: () => exportJson(a) }, 'Export JSON')),
      ),
      el(
        'div',
        { class: 'table-scroll' },
        el('table', { class: 'sections' }, el('thead', {}, el('tr', {}, ['#', 'Time', 'Key', 'Confidence', 'Could also be', ''].map((h) => el('th', {}, h)))), tbody),
      ),
    );
  }

  function baseName() {
    return `${track.name.replace(/\.[^.]+$/, '')}-keys`;
  }

  function exportCsv(a) {
    const rows = [['section', 'start_sec', 'end_sec', 'start', 'end', 'key', 'camelot', 'type', 'certainty', 'confidence', 'alternatives']];
    a.sections.forEach((s, i) =>
      rows.push([i + 1, s.start.toFixed(1), s.end.toFixed(1), formatTime(s.start), formatTime(s.end), s.name, s.camelot, s.kind, s.certainty || '', s.key == null ? '' : s.confidence.toFixed(2), (s.alternatives || []).map((x) => `${x.name} (${x.camelot}) ${Math.round((x.probability || 0) * 100)}%`).join('; ')]),
    );
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    download(`${baseName()}.csv`, 'text/csv', csv);
  }

  function exportJson(a) {
    const { timeline, ...rest } = a;
    download(`${baseName()}.json`, 'application/json', JSON.stringify({ file: track.path, title: track.meta.title, artist: track.meta.artist, ...rest }, null, 2));
  }

  function timeAt(clientX, a) {
    const rect = timelineEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * a.duration;
  }

  function draw() {
    const a = track?.analysis;
    if (!a || !canvas || !canvas.isConnected) return;
    const { ctx: g, w, h } = setupCanvas(canvas);
    const d = a.duration;
    g.clearRect(0, 0, w, h);
    paintSections(g, a.sections, d, 0, 0, w, h, 0.3);

    for (const s of a.sections) {
      const x0 = (s.start / d) * w;
      const x1 = (s.end / d) * w;
      g.fillStyle = keyColor(s.key, s.key == null ? 0.55 : 0.95);
      g.fillRect(x0, 0, x1 - x0, 22);
      if (s.key == null && s.kind !== 'silence') drawStripes(g, x0, 0, x1 - x0, 22, keyColor(null, 0.6));
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, 22);
      g.clip();
      g.fillStyle = keyTextColor(s.key);
      g.font = '600 12px system-ui, sans-serif';
      g.textBaseline = 'middle';
      const q = s.certainty === 'uncertain' ? ' ?' : '';
      const label = s.key == null ? s.name : x1 - x0 > 110 ? `${keyText(s)}${q}` : `${keyShort(s)}${q}`;
      g.fillText(label, x0 + 6, 11);
      g.restore();
    }

    if (track.peaks) {
      const { min, max } = track.peaks;
      const cols = min.length;
      const top = 26;
      const mid = top + (h - top) / 2;
      const amp = (h - top) / 2 - 4;
      g.fillStyle = cssVar('--wave');
      for (let x = 0; x < w; x++) {
        const c0 = Math.floor((x / w) * cols);
        const c1 = Math.max(c0 + 1, Math.floor(((x + 1) / w) * cols));
        let lo = 0;
        let hi = 0;
        for (let c = c0; c < c1 && c < cols; c++) {
          if (min[c] < lo) lo = min[c];
          if (max[c] > hi) hi = max[c];
        }
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }

    g.strokeStyle = cssVar('--text');
    g.setLineDash([4, 3]);
    g.lineWidth = 1.5;
    for (const tr of a.transitions || []) {
      const x = Math.round((tr.time / d) * w) + 0.5;
      g.beginPath();
      g.moveTo(x, 22);
      g.lineTo(x, h);
      g.stroke();
    }
    g.setLineDash([]);

    if (player.track === track && player.currentTime > 0) {
      const x = (player.currentTime / d) * w;
      g.fillStyle = cssVar('--text');
      g.fillRect(x - 1, 0, 2, h);
    }

    if (rawCanvas && rawCanvas.isConnected) {
      const { ctx: r, w: rw, h: rh } = setupCanvas(rawCanvas);
      r.clearRect(0, 0, rw, rh);
      for (const b of a.timeline) {
        const x0 = (b.time / d) * rw;
        const x1 = (Math.min(d, b.time + a.blockSec) / d) * rw;
        if (b.key == null) {
          r.fillStyle = keyColor(null, b.silent ? 0.12 : 0.35);
        } else {
          r.fillStyle = keyColor(b.key, 0.35 + 0.65 * Math.max(0, Math.min(1, b.score)));
        }
        r.fillRect(x0, 0, x1 - x0 + 0.5, rh);
      }
    }

    for (const row of root.querySelectorAll('table.sections tbody tr')) {
      const s = a.sections[Number(row.dataset.index)];
      const t = player.currentTime;
      row.classList.toggle('playing', player.track === track && t > 0 && t >= s.start && t < s.end);
    }
  }

  render();

  return {
    update(reason, detail) {
      if (reason === 'track' && detail === track) render();
      else if (reason === 'progress' && detail.track === track && progressEl) {
        const pct = Math.round(detail.fraction * 100);
        progressEl.querySelector('.bar').style.width = `${pct}%`;
        const row = progressEl.parentElement;
        row.querySelector('.status-text').textContent = detail.message;
        row.querySelector('.status-pct').textContent = `${pct}%`;
      } else if (reason === 'resize') render();
      else if (reason === 'player') draw();
      else if (reason === 'library') {
        if (library.byPath.get(path) !== track) render();
      }
    },
    unmount() {},
  };
}
