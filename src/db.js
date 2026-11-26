// Minimal IndexedDB wrapper. Stores:
//   kv     – settings, the saved music-folder handle, UI state
//   tracks – per-file cache (metadata + analysis), keyed by file signature
//   sets   – DJ sets

const DB_NAME = 'key-change-detector';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks');
        if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    // Storage can be unavailable (private mode, blocked site data). The app still works without it.
    console.warn('Storage unavailable:', err);
    return undefined;
  }
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
};
