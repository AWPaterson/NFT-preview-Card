// DJ sets: ordered lists of library tracks, saved in IndexedDB.
// Each entry keeps a snapshot of the track's details so a set still displays
// before the music folder has been reconnected.

import { db } from './db.js';

function snapshot(track) {
  const a = track.analysis;
  return {
    path: track.path,
    title: track.meta.title,
    artist: track.meta.artist,
    duration: track.meta.duration || a?.duration || null,
    startKey: a ? a.startKey : undefined,
    endKey: a ? a.endKey : undefined,
  };
}

export class SetStore extends EventTarget {
  constructor() {
    super();
    this.sets = [];
  }

  emit(set) {
    this.dispatchEvent(new CustomEvent('changed', { detail: set }));
  }

  async load() {
    this.sets = ((await db.all('sets')) || []).sort((a, b) => a.created - b.created);
    this.emit();
  }

  get(id) {
    return this.sets.find((s) => s.id === id) || null;
  }

  async save(set) {
    set.updated = Date.now();
    await db.put('sets', set);
    this.emit(set);
  }

  async create(name) {
    const set = {
      id: `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: name || `Set ${this.sets.length + 1}`,
      tracks: [],
      created: Date.now(),
      updated: Date.now(),
    };
    this.sets.push(set);
    await this.save(set);
    return set;
  }

  async rename(set, name) {
    set.name = name.trim() || set.name;
    await this.save(set);
  }

  async remove(set) {
    this.sets = this.sets.filter((s) => s !== set);
    await db.delete('sets', set.id);
    this.emit();
  }

  async addTracks(set, tracks, index = set.tracks.length) {
    set.tracks.splice(index, 0, ...tracks.map(snapshot));
    await this.save(set);
  }

  async removeAt(set, index) {
    set.tracks.splice(index, 1);
    await this.save(set);
  }

  async move(set, from, to) {
    if (from === to) return;
    const [item] = set.tracks.splice(from, 1);
    set.tracks.splice(to > from ? to - 1 : to, 0, item);
    await this.save(set);
  }

  /** Refresh snapshots after a track has been (re)analysed. */
  async refreshTrack(track) {
    for (const set of this.sets) {
      let touched = false;
      set.tracks.forEach((entry, i) => {
        if (entry.path === track.path) {
          set.tracks[i] = snapshot(track);
          touched = true;
        }
      });
      if (touched) await this.save(set);
    }
  }
}
