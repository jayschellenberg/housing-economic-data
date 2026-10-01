/*
 * local-folder-store.js — the plumbing every "read a folder on the viewer's
 * own disk" tab shares: an IndexedDB database of its own (user data, no TTL,
 * no clear-all), a saved File System Access directory handle, and the
 * permission dance Chrome puts a saved handle through between sessions.
 *
 * Each tab builds one store with createFolderStore({ dbName, pickerId }) and
 * layers its own import on top (which files to read, how to keep them). The
 * Johnson Report store predates this module and keeps its own copy of the
 * plumbing; new tabs use this.
 */

import { resolveAppFolder } from './app-market-data.js';

export function storeAvailable() {
  return typeof indexedDB !== 'undefined';
}

export function fsAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * 'granted' | 'prompt' | 'denied' | 'none'. Chrome drops a saved handle back
 * to 'prompt' between sessions; one click re-grants without re-picking.
 */
export async function directoryPermission(handle, { request = false } = {}) {
  if (!handle) return 'none';
  try {
    const opts = { mode: 'read' };
    let state = await handle.queryPermission(opts);
    if (state === 'prompt' && request) state = await handle.requestPermission(opts);
    return state;
  } catch { return 'denied'; }
}

/**
 * @param {Object} o
 * @param {string} o.dbName     IndexedDB database name, unique per tab
 * @param {string} o.pickerId   showDirectoryPicker `id` (remembers the last folder)
 * @param {string[]} [o.stores] object stores to create besides 'meta'
 * @param {string[]} [o.appPath] the tab's folder below AppMarketData; a pick
 *   of AppMarketData (or a folder on the path) steps down to it
 */
export function createFolderStore({ dbName, pickerId, stores = ['files'], appPath = null }) {
  const META = 'meta';
  let dbPromise = null;

  function openDb() {
    if (!storeAvailable()) return Promise.reject(new Error('IndexedDB not available'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const name of [...stores, META]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(`${dbName} open failed`));
      req.onblocked = () => reject(new Error(`${dbName} open blocked`));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function tx(storeName, mode, op) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let out;
      Promise.resolve(op(store)).then((r) => { out = r; }).catch(reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error(`${dbName} tx error`));
      t.onabort = () => reject(t.error || new Error(`${dbName} tx aborted`));
    }));
  }

  const req2promise = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const api = {
    get: (store, k) => tx(store, 'readonly', (s) => req2promise(s.get(k))),
    put: (store, k, v) => tx(store, 'readwrite', (s) => req2promise(s.put(v, k))),
    del: (store, k) => tx(store, 'readwrite', (s) => req2promise(s.delete(k))),
    keys: (store) => tx(store, 'readonly', (s) => req2promise(s.getAllKeys())),
    all: (store) => tx(store, 'readonly', (s) => req2promise(s.getAll())),
    getMeta: (k) => api.get(META, k),
    putMeta: (k, v) => api.put(META, k, v),
    clear() {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction([...stores, META], 'readwrite');
        for (const name of [...stores, META]) t.objectStore(name).clear();
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
      }));
    },
    /** Ask the user to nominate the folder. Requires a user gesture. */
    async pickDirectory() {
      if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
      const picked = await window.showDirectoryPicker({ id: pickerId, mode: 'read' });
      const handle = appPath ? await resolveAppFolder(picked, appPath) : picked;
      await api.putMeta('dirHandle', handle);
      return handle;
    },
    getSavedDirectory: () => api.getMeta('dirHandle'),
    directoryPermission,
  };
  return api;
}
