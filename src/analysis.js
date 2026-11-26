// Decodes audio files and runs key analysis in a Web Worker.

const PEAK_COLUMNS = 1200;

export async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, 44100);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

export function toMono(audio) {
  const n = audio.length;
  const out = new Float32Array(n);
  const chs = audio.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (chs > 1) for (let i = 0; i < n; i++) out[i] /= chs;
  return out;
}

/** Min/max waveform overview, normalised to ±1, for drawing at any width. */
export function computePeaks(mono, columns = PEAK_COLUMNS) {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const per = mono.length / columns;
  let globalMax = 1e-9;
  for (let x = 0; x < columns; x++) {
    const start = Math.floor(x * per);
    const end = Math.min(mono.length, Math.floor((x + 1) * per));
    const stride = Math.max(1, Math.floor((end - start) / 600));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i += stride) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[x] = lo;
    max[x] = hi;
    globalMax = Math.max(globalMax, -lo, hi);
  }
  for (let x = 0; x < columns; x++) {
    min[x] /= globalMax;
    max[x] /= globalMax;
  }
  return { min, max };
}

let worker = null;
let workerBroken = false;

function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function analyzeInWorker(samples, sampleRate, options, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = Math.random();
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const onMessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') {
        onProgress?.(e.data.fraction, e.data.message);
        return;
      }
      cleanup();
      if (e.data.type === 'result') resolve(e.data.result);
      else reject(new Error(e.data.message));
    };
    const onError = (e) => {
      cleanup();
      worker = null;
      workerBroken = true;
      reject(e.error || new Error(e.message || 'Worker failed'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, samples, sampleRate, options }, [samples.buffer]);
  });
}

export async function analyzeSamples(mono, sampleRate, options, onProgress) {
  if (!workerBroken) {
    try {
      return await analyzeInWorker(mono.slice(), sampleRate, options, onProgress);
    } catch (err) {
      if (!workerBroken) throw err;
      console.warn('Worker unavailable, analysing on the main thread', err);
    }
  }
  const { analyzeKeys } = await import('./analyzer.js');
  return analyzeKeys(mono, sampleRate, options, onProgress);
}

/** Decode + analyse a file. Returns { result, peaks }. */
export async function analyzeFile(file, options, onProgress) {
  onProgress?.(0, 'Decoding audio…');
  const audio = await decodeFile(file);
  const mono = toMono(audio);
  const peaks = computePeaks(mono);
  const result = await analyzeSamples(mono, audio.sampleRate, options, onProgress);
  return { result, peaks };
}
