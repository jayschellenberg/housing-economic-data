/*
 * johnson-store.js — the parsed Johnson Report editions, held locally in the
 * browser.
 *
 * WHAT THIS IS. The Johnson Report is paid, copyrighted subscriber material,
 * so it is NEVER hosted: the site ships none of it, the server never sees it,
 * and nothing is uploaded. The user runs the Python ingest over their Word
 * files, which writes a `web-data/` folder (manifest.json + editions/*.json),
 * then nominates that folder here once. We read it locally and keep the JSON
 * in IndexedDB. A visitor without that folder simply has no Johnson data.
 *
 * WHY A DIRECTORY HANDLE. With the File System Access API (Chrome / Edge) the
 * browser can keep a handle to the folder. When a new edition is parsed into
 * it, we notice on the next visit and re-import without the user doing
 * anything. Other browsers fall back to a manual folder pick with no
 * auto-refresh. Same pattern as the Parcel Search site's MAO sales store.
 *
 * WHY ITS OWN DATABASE. This is user data, not a cache — it lives apart from
 * anything with a TTL or a clear-all.
 */

import { resolveAppFolder, filterAppFiles } from './app-market-data.js';

const DB_NAME = 'hed-johnson';
const DB_VERSION = 1;
const EDITIONS = 'editions';   // key: edition id "2026-06" → the edition JSON
const META = 'meta';           // key: 'manifest' | 'dirHandle' | 'importState'

let dbPromise = null;

export function storeAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (!storeAvailable()) return Promise.reject(new Error('IndexedDB not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(EDITIONS)) db.createObjectStore(EDITIONS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('johnson DB open failed'));
    req.onblocked = () => reject(new Error('johnson DB open blocked'));
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
    t.onerror = () => reject(t.error || new Error('johnson tx error'));
    t.onabort = () => reject(t.error || new Error('johnson tx aborted'));
  }));
}

const req2promise = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export const getMeta = (k) => tx(META, 'readonly', (s) => req2promise(s.get(k)));
export const putMeta = (k, v) => tx(META, 'readwrite', (s) => req2promise(s.put(v, k)));
export const getEdition = (id) => tx(EDITIONS, 'readonly', (s) => req2promise(s.get(String(id))));
export const putEdition = (ed) => tx(EDITIONS, 'readwrite', (s) => req2promise(s.put(ed, String(ed.id))));
export const listEditionIds = () => tx(EDITIONS, 'readonly', (s) => req2promise(s.getAllKeys()));
export const getAllEditions = () => tx(EDITIONS, 'readonly', (s) => req2promise(s.getAll()));

export function clearJohnson() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([EDITIONS, META], 'readwrite');
    t.objectStore(EDITIONS).clear();
    t.objectStore(META).clear();
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  }));
}

export const getManifest = () => getMeta('manifest');

// --- File System Access ------------------------------------------------------

export function fsAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Ask the user to nominate the web-data folder. Requires a user gesture. */
export async function pickDirectory() {
  if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
  const picked = await window.showDirectoryPicker({ id: 'johnson-report', mode: 'read' });
  const handle = await resolveAppFolder(picked, ['JohnsonReport']);
  await putMeta('dirHandle', handle);
  return handle;
}

export const getSavedDirectory = () => getMeta('dirHandle');

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

// --- Import ------------------------------------------------------------------

const EDITION_FILE_RE = /^(\d{4}-\d{2})\.json$/i;

/**
 * Find the editions/ folder and manifest. The user may pick either the
 * `web-data` folder or the `editions` folder inside it; both work.
 */
async function locate(dirHandle) {
  let editionsDir = null;
  let manifestHandle = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory' && /^editions$/i.test(name)) editionsDir = handle;
    if (handle.kind === 'file' && /^manifest\.json$/i.test(name)) manifestHandle = handle;
  }
  if (!editionsDir) {
    // Picked the editions folder itself?
    let hasEditionFiles = false;
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && EDITION_FILE_RE.test(name)) { hasEditionFiles = true; break; }
    }
    if (hasEditionFiles) editionsDir = dirHandle;
  }
  return { editionsDir, manifestHandle };
}

async function listEditionFiles(editionsDir) {
  const files = [];
  for await (const [name, handle] of editionsDir.entries()) {
    if (handle.kind !== 'file') continue;
    const m = name.match(EDITION_FILE_RE);
    if (m) files.push({ id: m[1], name, handle });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : 1));
  return files;
}

/**
 * Read the folder into IndexedDB. Files unchanged since the last import are
 * skipped, so adding one edition re-reads one file.
 */
export async function importFromDirectory(dirHandle, { onProgress, force = false } = {}) {
  const { editionsDir, manifestHandle } = await locate(dirHandle);
  if (!editionsDir) {
    throw new Error('No editions/*.json files found. Pick the web-data folder written by parse_johnson.py.');
  }
  const files = await listEditionFiles(editionsDir);
  if (!files.length) throw new Error('The editions folder is empty. Run parse_johnson.py first.');

  let manifestData = null;
  if (manifestHandle) {
    try { manifestData = JSON.parse(await (await manifestHandle.getFile()).text()); } catch { /* optional */ }
  }

  const prev = (await getMeta('importState')) || { mtimes: {} };
  const mtimes = {};
  let imported = 0, skipped = 0;
  const known = new Set(await listEditionIds());

  for (let i = 0; i < files.length; i++) {
    const { id, name, handle } = files[i];
    const file = await handle.getFile();
    onProgress?.({ done: i, total: files.length, label: id });
    mtimes[id] = file.lastModified;
    if (!force && prev.mtimes[id] === file.lastModified && known.has(id)) { skipped++; continue; }
    let ed;
    try { ed = JSON.parse(await file.text()); } catch { throw new Error(`${name} is not valid JSON.`); }
    if (!ed || ed.id !== id || !Array.isArray(ed.tables)) throw new Error(`${name} is not a parsed Johnson edition.`);
    await putEdition(ed);
    imported++;
  }
  // Editions whose file disappeared are dropped so the picker matches the folder.
  const present = new Set(files.map(f => f.id));
  for (const id of known) {
    if (!present.has(id)) await tx(EDITIONS, 'readwrite', (s) => req2promise(s.delete(id)));
  }
  onProgress?.({ done: files.length, total: files.length, label: 'done' });

  const summary = {
    editions: files.length, imported, skipped,
    first: files[0].id, last: files[files.length - 1].id,
    generated_at: manifestData?.generated_at || null,
    imported_at: new Date().toISOString(),
  };
  await putMeta('manifest', summary);
  await putMeta('importState', { mtimes });
  return summary;
}

/**
 * Has the folder changed since the last import? Cheap (stats files, reads
 * none). null when we cannot tell, so the caller stays quiet.
 */
export async function checkForUpdates(dirHandle) {
  if (!dirHandle) return null;
  if ((await directoryPermission(dirHandle)) !== 'granted') return null;
  const prev = (await getMeta('importState')) || { mtimes: {} };
  try {
    const { editionsDir } = await locate(dirHandle);
    if (!editionsDir) return null;
    const files = await listEditionFiles(editionsDir);
    const changed = [];
    for (const f of files) {
      const file = await f.handle.getFile();
      if (prev.mtimes[f.id] !== file.lastModified) changed.push(f.id);
    }
    const removed = Object.keys(prev.mtimes).filter(id => !files.some(f => f.id === id));
    return { changed: [...changed, ...removed], count: changed.length + removed.length };
  } catch { return null; }
}

/**
 * Fallback for browsers without File System Access: import from a
 * `<input type=file webkitdirectory>` selection. No handle is kept, so there
 * is no auto-refresh — the user re-picks when they have a new edition.
 */
export async function importFromFileList(fileList, { onProgress } = {}) {
  fileList = filterAppFiles(fileList, ['JohnsonReport']);
  const files = Array.from(fileList || [])
    .map(f => ({ f, id: (f.name.match(EDITION_FILE_RE) || [])[1] }))
    .filter(x => x.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!files.length) throw new Error('No editions/*.json files in that selection.');
  const manifestFile = Array.from(fileList).find(f => /manifest\.json$/i.test(f.name));
  let manifestData = null;
  if (manifestFile) { try { manifestData = JSON.parse(await manifestFile.text()); } catch { /* optional */ } }

  for (let i = 0; i < files.length; i++) {
    const { f, id } = files[i];
    onProgress?.({ done: i, total: files.length, label: id });
    const ed = JSON.parse(await f.text());
    if (!ed || ed.id !== id || !Array.isArray(ed.tables)) throw new Error(`${f.name} is not a parsed Johnson edition.`);
    await putEdition(ed);
  }
  onProgress?.({ done: files.length, total: files.length, label: 'done' });
  const summary = {
    editions: files.length, imported: files.length, skipped: 0,
    first: files[0].id, last: files[files.length - 1].id,
    generated_at: manifestData?.generated_at || null,
    imported_at: new Date().toISOString(),
    no_handle: true,
  };
  await putMeta('manifest', summary);
  return summary;
}
