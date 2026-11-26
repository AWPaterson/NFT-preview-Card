// Audio playback with a queue. Emits 'track' when the current track changes
// and 'state' on play/pause/time updates.

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.queue = [];
    this.index = -1;
    this.track = null;
    this.context = null; // e.g. { type: 'set', id } or { type: 'library' }
    this.url = null;
    this.loadToken = 0;
    audio.addEventListener('ended', () => this.next(true));
    for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'loadedmetadata', 'volumechange']) {
      audio.addEventListener(ev, () => this.dispatchEvent(new Event('state')));
    }
  }

  get playing() {
    return !this.audio.paused;
  }

  get currentTime() {
    return this.audio.currentTime || 0;
  }

  get duration() {
    return this.audio.duration || this.track?.analysis?.duration || this.track?.meta?.duration || 0;
  }

  /** Play `track`. `queue` is the list Next/Previous move through. */
  async play(track, { queue, context, startAt = 0 } = {}) {
    if (queue) {
      this.queue = queue;
      this.context = context || null;
    }
    this.index = this.queue.indexOf(track);
    if (this.index < 0) {
      this.queue = [track];
      this.index = 0;
    }
    if (this.track === track && this.url) {
      this.seek(startAt);
      this.audio.play().catch(() => {});
      return;
    }
    const token = ++this.loadToken;
    this.track = track;
    this.dispatchEvent(new Event('track'));
    try {
      const file = await track.getFile();
      if (token !== this.loadToken) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(file);
      this.audio.src = this.url;
      if (startAt > 0) {
        await new Promise((resolve) => this.audio.addEventListener('loadedmetadata', resolve, { once: true }));
        this.audio.currentTime = startAt;
      }
      await this.audio.play();
    } catch (err) {
      if (token === this.loadToken) this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  toggle() {
    if (!this.track) {
      if (this.queue.length) this.play(this.queue[0]);
      return;
    }
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  seek(t) {
    if (!this.track) return;
    const d = this.duration;
    this.audio.currentTime = Math.max(0, d ? Math.min(t, d - 0.05) : t);
  }

  next(auto = false) {
    if (this.index + 1 < this.queue.length) this.play(this.queue[this.index + 1]);
    else if (auto) this.dispatchEvent(new Event('state'));
  }

  prev() {
    if (this.currentTime > 3 || this.index <= 0) this.seek(0);
    else this.play(this.queue[this.index - 1]);
  }

  /** The analysed section under the playhead, if any. */
  currentSection() {
    const a = this.track?.analysis;
    if (!a) return null;
    const t = this.currentTime;
    return a.sections.find((s) => t >= s.start && t < s.end) || a.sections[a.sections.length - 1] || null;
  }
}
