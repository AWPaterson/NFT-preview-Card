// Reads basic tags and audio properties from MP3 (ID3v2/ID3v1), FLAC (Vorbis comments)
// and WAV (RIFF INFO / id3 chunk) files without decoding the audio.

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function decodeText(bytes, encoding) {
  try {
    let text;
    if (encoding === 0) text = new TextDecoder('latin1').decode(bytes);
    else if (encoding === 1) text = new TextDecoder('utf-16').decode(bytes);
    else if (encoding === 2) text = new TextDecoder('utf-16be').decode(bytes);
    else text = new TextDecoder('utf-8').decode(bytes);
    return text.split('\u0000').find((t) => t.trim()) ?.trim() || '';
  } catch {
    return '';
  }
}

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);

const ID3_FIELDS = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
  TKEY: 'tagKey', TKE: 'tagKey', TBPM: 'bpm', TBP: 'bpm', TCON: 'genre', TCO: 'genre',
};

// Parses an ID3v2 tag that starts at bytes[0]. Returns { tags, size }.
function parseId3v2(bytes) {
  const tags = {};
  if (ascii(bytes, 0, 3) !== 'ID3') return { tags, size: 0 };
  const major = bytes[3];
  const flags = bytes[5];
  const size = syncsafe(bytes, 6) + 10 + (flags & 0x10 ? 10 : 0);
  let pos = 10;
  if (flags & 0x40 && major >= 3) pos += major === 4 ? syncsafe(bytes, 10) : u32be(bytes, 10) + 4;
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  while (pos + headLen < Math.min(size, bytes.length)) {
    const id = ascii(bytes, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let len;
    if (major === 2) len = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
    else if (major === 4) len = syncsafe(bytes, pos + 4);
    else len = u32be(bytes, pos + 4);
    const dataStart = pos + headLen;
    const field = ID3_FIELDS[id];
    if (field && len > 1 && dataStart + len <= bytes.length && !tags[field]) {
      tags[field] = decodeText(bytes.subarray(dataStart + 1, dataStart + len), bytes[dataStart]);
    }
    pos = dataStart + len;
  }
  return { tags, size };
}

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

async function parseMp3(file) {
  const head = await readBytes(file, 0, 10);
  let tagSize = 0;
  let tags = {};
  if (ascii(head, 0, 3) === 'ID3') {
    tagSize = syncsafe(head, 6) + 10;
    const tagBytes = await readBytes(file, 0, Math.min(tagSize, 1 << 21));
    tags = parseId3v2(tagBytes).tags;
  }
  if (!tags.title && file.size > 128) {
    const tail = await readBytes(file, file.size - 128, file.size);
    if (ascii(tail, 0, 3) === 'TAG') {
      const latin = (a, b) => new TextDecoder('latin1').decode(tail.subarray(a, b)).replace(/\0.*$/, '').trim();
      tags.title = latin(3, 33) || undefined;
      tags.artist = tags.artist || latin(33, 63) || undefined;
      tags.album = tags.album || latin(63, 93) || undefined;
    }
  }

  const info = {};
  const buf = await readBytes(file, tagSize, tagSize + 65536);
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3;
    const brIdx = buf[i + 2] >> 4;
    const srIdx = (buf[i + 2] >> 2) & 3;
    if (verBits === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
    const mono = buf[i + 3] >> 6 === 3;
    info.sampleRate = MP3_RATES[version][srIdx];
    info.channels = mono ? 1 : 2;
    const samplesPerFrame = version === 1 ? 1152 : 576;
    const xingOff = i + 4 + (version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    const xing = ascii(buf, xingOff, 4);
    if ((xing === 'Xing' || xing === 'Info') && buf[xingOff + 7] & 1) {
      info.duration = (u32be(buf, xingOff + 8) * samplesPerFrame) / info.sampleRate;
    } else if (ascii(buf, i + 36, 4) === 'VBRI') {
      info.duration = (u32be(buf, i + 36 + 14) * samplesPerFrame) / info.sampleRate;
    } else {
      const kbps = MP3_BITRATES[version === 1 ? 1 : 2][brIdx];
      info.duration = ((file.size - tagSize - i) * 8) / (kbps * 1000);
    }
    break;
  }
  return { ...tags, ...info };
}

async function parseFlac(file) {
  const out = {};
  const magic = await readBytes(file, 0, 4);
  if (ascii(magic, 0, 4) !== 'fLaC') return out;
  let pos = 4;
  for (let n = 0; n < 64 && pos + 4 <= file.size; n++) {
    const h = await readBytes(file, pos, pos + 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 0) {
      const b = await readBytes(file, pos + 4, pos + 4 + len);
      out.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      out.channels = ((b[12] >> 1) & 7) + 1;
      const total = (b[13] & 0x0f) * 2 ** 32 + u32be(b, 14);
      if (out.sampleRate && total) out.duration = total / out.sampleRate;
    } else if (type === 4) {
      const b = await readBytes(file, pos + 4, pos + 4 + len);
      const utf8 = new TextDecoder('utf-8');
      let p = 4 + u32le(b, 0);
      const count = u32le(b, p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= b.length; i++) {
        const l = u32le(b, p);
        const entry = utf8.decode(b.subarray(p + 4, p + 4 + l));
        p += 4 + l;
        const eq = entry.indexOf('=');
        const name = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1).trim();
        const field = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', INITIALKEY: 'tagKey', KEY: 'tagKey', BPM: 'bpm', GENRE: 'genre' }[name];
        if (field && value && !out[field]) out[field] = value;
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

async function parseWav(file) {
  const out = {};
  const head = await readBytes(file, 0, 12);
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 4) !== 'WAVE') return out;
  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;
  for (let n = 0; n < 64 && pos + 8 <= file.size; n++) {
    const h = await readBytes(file, pos, pos + 8);
    const id = ascii(h, 0, 4);
    const len = u32le(h, 4);
    if (id === 'fmt ') {
      const b = await readBytes(file, pos + 8, pos + 8 + Math.min(len, 64));
      out.channels = b[2] | (b[3] << 8);
      out.sampleRate = u32le(b, 4);
      byteRate = u32le(b, 8);
    } else if (id === 'data') {
      dataSize = Math.min(len, file.size - pos - 8);
    } else if (id === 'LIST' && len < 1 << 20) {
      const b = await readBytes(file, pos + 8, pos + 8 + len);
      if (ascii(b, 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const sid = ascii(b, p, 4);
          const sl = u32le(b, p + 4);
          const field = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre' }[sid];
          if (field && !out[field]) out[field] = decodeText(b.subarray(p + 8, p + 8 + sl), 3);
          p += 8 + sl + (sl & 1);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && len < 1 << 21) {
      const { tags } = parseId3v2(await readBytes(file, pos + 8, pos + 8 + len));
      for (const [k, v] of Object.entries(tags)) if (v) out[k] = v;
    }
    pos += 8 + len + (len & 1);
  }
  if (byteRate && dataSize) out.duration = dataSize / byteRate;
  return out;
}

// "01 - Artist - Title.mp3" → { artist, title }
export function guessFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const noNum = base.replace(/^\d{1,3}[\s.\-_)]+/, '').trim() || base;
  const parts = noNum.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { title: noNum };
}

// Bump when tag reading changes so cached metadata is re-read.
export const META_VERSION = 2;

const UNKNOWN = /^unknown[ _-]?(artist|album)$/i;

/**
 * Artist and album from a Rekordbox-style layout: …/Contents/<Artist>/<Album>/<file>.
 * Only used when a file has no tags. Other layouts are too varied to guess from.
 */
export function guessFromPath(path) {
  const folders = (path || '').split('/').slice(0, -1);
  const idx = folders.map((f) => f.toLowerCase()).lastIndexOf('contents');
  if (idx < 0) return {};
  const clean = (n) => (n && !UNKNOWN.test(n) ? n : '');
  return { artist: clean(folders[idx + 1]), album: clean(folders[idx + 2]) };
}

export async function readMetadata(file, path = file.name) {
  const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  let meta = {};
  try {
    if (ext === 'mp3') meta = await parseMp3(file);
    else if (ext === 'flac') meta = await parseFlac(file);
    else if (ext === 'wav' || ext === 'wave') meta = await parseWav(file);
  } catch (err) {
    console.warn('Could not read tags from', file.name, err);
  }
  const guess = guessFromFilename(file.name);
  const fromPath = guessFromPath(path);
  return {
    v: META_VERSION,
    title: meta.title || guess.title,
    artist: meta.artist || fromPath.artist || guess.artist || '',
    album: meta.album || fromPath.album || '',
    genre: meta.genre || '',
    tagKey: meta.tagKey || '',
    bpm: meta.bpm ? Math.round(parseFloat(meta.bpm)) || '' : '',
    duration: Number.isFinite(meta.duration) ? meta.duration : null,
    sampleRate: meta.sampleRate || null,
    channels: meta.channels || null,
    format: ext ? ext.toUpperCase() : '',
  };
}
