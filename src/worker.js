import { analyzeKeys } from './analyzer.js';

self.onmessage = (event) => {
  const { id, samples, sampleRate, options } = event.data;
  try {
    let lastPost = 0;
    const result = analyzeKeys(samples, sampleRate, options, (fraction, message) => {
      const now = Date.now();
      if (now - lastPost > 50 || fraction >= 1) {
        lastPost = now;
        self.postMessage({ id, type: 'progress', fraction, message });
      }
    });
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
