/*
 * store.js — the connected export bundle, held locally in the browser.
 *
 * WHAT THIS IS. The site ships no data. A viewer nominates the shared
 * published folder (Dropbox-synced) once; its files are read into
 * IndexedDB as raw text and parsed on demand. Nothing is uploaded and the
 * server never sees it — a visitor without the folder has no data, which
 * is the access control. That also means nothing in the deployed page may
 * describe the data or its sources: what the bundle contains is learned
 * from the bundle.
 *
 * WHY A DIRECTORY HANDLE. With the File System Access API the browser
 * keeps a handle to the folder across sessions (Chrome/Edge). On the next
 * visit we stat the files: a changed mtime means the chain published
 * again, and Reload re-imports without re-picking. Firefox and Safari
 * have no directory picker; they fall back to a folder <input>, which
 * works but cannot detect updates or open flyers.
 */

import { FILES } from './bundle.js';
import {
  detectLayout, flyerSegments, snapshotSegments, EXPORT_DIR, FLYERS_DIR,
} from './flyerPath.js';

const DB_NAME = 'commercial-availability-explorer';
const DB_VERSION = 1;
const FILES_STORE = 'files';   // key: file name → { name, text, mtime, bytes }
const META_STORE = 'meta';     // key: 'manifest' | 'dirHandle' | 'importState'

const REQUIRED = [FILES.manifest, FILES.records, FILES.runs];
// Read when present, never demanded: an older publish has none of these,
// and refusing it would be a worse outcome than a feature that is absent.
const OPTIONAL = [FILES.addresses];
const KNOWN = [...REQUIRED, ...OPTIONAL];

let dbPromise = null;

export function dbAvailable() {
  return typeof indexedDB !== 'undefined';
}

export function fsAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function openDb() {
  if (!dbAvailable()) return Promise.reject(new Error('IndexedDB not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
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
    t.onerror = () => reject(t.error || new Error('IndexedDB tx error'));
    t.onabort = () => reject(t.error || new Error('IndexedDB tx aborted'));
  }));
}

const req2promise = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export const getMeta = (k) => tx(META_STORE, 'readonly', (s) => req2promise(s.get(k)));
export const putMeta = (k, v) => tx(META_STORE, 'readwrite', (s) => req2promise(s.put(v, k)));
export const getFile = (name) => tx(FILES_STORE, 'readonly', (s) => req2promise(s.get(name)));
const putFile = (rec) => tx(FILES_STORE, 'readwrite', (s) => req2promise(s.put(rec, rec.name)));
const deleteFile = (name) => tx(FILES_STORE, 'readwrite', (s) => req2promise(s.delete(name)));

/** Raw text of the three files, or null when any is missing. */
export async function getBundleTexts() {
  const recs = await Promise.all(REQUIRED.map(getFile));
  if (recs.some((r) => !r || typeof r.text !== 'string')) return null;
  return { manifest: recs[0].text, records: recs[1].text, runs: recs[2].text };
}

export function clearAll() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([FILES_STORE, META_STORE], 'readwrite');
    t.objectStore(FILES_STORE).clear();
    t.objectStore(META_STORE).clear();
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  }));
}

// ---------------------------------------------------------------------------
// Durable storage
// ---------------------------------------------------------------------------

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return { supported: false };
    const already = await navigator.storage.persisted();
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: granted };
  } catch { return { supported: false }; }
}

// ---------------------------------------------------------------------------
// File System Access
// ---------------------------------------------------------------------------

/** Ask the user to nominate the published folder. Needs a user gesture. */
export async function pickDirectory() {
  if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
  const handle = await window.showDirectoryPicker({ id: 'commavail-published', mode: 'read' });
  await putMeta('dirHandle', handle);   // handles are structured-cloneable
  return handle;
}

export const getSavedDirectory = () => getMeta('dirHandle');

/** 'granted' | 'prompt' | 'denied' | 'none'. Chrome drops a saved handle
 *  back to 'prompt' between sessions; re-granting is one click. */
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
 * What the connected folder is. The published folder (preferred) holds
 * export/ and flyers/; the export folder alone still works but flyers
 * stay out of reach — a directory handle cannot see its parent.
 * @returns {{layout, flyers, bundleDir, flyersDir}}
 */
async function resolveLayout(dirHandle) {
  const dirs = [], files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    (handle.kind === 'directory' ? dirs : files).push(name);
  }
  const { layout, flyers } = detectLayout({ dirs, files });
  const bundleDir = layout === 'parent' ? await dirHandle.getDirectoryHandle(EXPORT_DIR) : dirHandle;
  const flyersDir = flyers ? await dirHandle.getDirectoryHandle(FLYERS_DIR) : null;
  return { layout, flyers, bundleDir, flyersDir };
}

/** The bundle files' handles — every required one, or an error naming
 *  what is missing, plus whichever optional ones the folder has. */
async function requiredFiles(bundleDir) {
  const found = new Map();
  for await (const [name, handle] of bundleDir.entries()) {
    if (handle.kind === 'file' && KNOWN.includes(name)) found.set(name, handle);
  }
  const missing = REQUIRED.filter((n) => !found.has(n));
  if (missing.length) {
    throw new Error(`The export folder is missing ${missing.join(', ')} — wait for the publish to finish syncing, then Reload.`);
  }
  return found;
}

/**
 * Read the folder into IndexedDB. Files whose mtime matches the last
 * import are skipped unless `force`. The manifest is always re-read (it
 * is tiny, and it is what "what's loaded" is described from).
 */
export async function importFromDirectory(dirHandle, { onProgress, force = false } = {}) {
  const { layout, flyers, bundleDir } = await resolveLayout(dirHandle);
  const handles = await requiredFiles(bundleDir);
  const names = KNOWN.filter((n) => handles.has(n));
  const files = await Promise.all(names.map(async (n) => [n, await handles.get(n).getFile()]));
  return importFiles(files, { onProgress, force, hasHandle: true, layout, flyers });
}

/** Fallback for browsers without File System Access: a folder <input> or
 *  drag-drop. No handle is retained, so no update detection and no
 *  flyers. */
export async function importFromFileList(fileList, { onProgress } = {}) {
  const byName = new Map();
  for (const f of Array.from(fileList || [])) {
    const base = f.name.split('/').pop();
    if (KNOWN.includes(base)) byName.set(base, f);
  }
  const missing = REQUIRED.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new Error(`Not the published folder: ${missing.join(', ')} not found. Pick the shared CommercialAvailability folder.`);
  }
  return importFiles(KNOWN.filter((n) => byName.has(n)).map((n) => [n, byName.get(n)]), {
    onProgress, force: true, hasHandle: false, layout: null, flyers: false,
  });
}

async function importFiles(files, { onProgress, force, hasHandle, layout, flyers }) {
  const prev = (await getMeta('importState')) || { mtimes: {} };
  const mtimes = { ...prev.mtimes };
  let imported = 0, skipped = 0;
  let manifestData = null;

  for (let i = 0; i < files.length; i++) {
    const [name, file] = files[i];
    onProgress?.({ done: i, total: files.length, label: name });
    const unchanged = !force && mtimes[name] === file.lastModified && (await getFile(name));
    if (unchanged && name !== FILES.manifest) { skipped++; continue; }
    const text = await file.text();
    if (name === FILES.manifest) {
      manifestData = JSON.parse(text);   // throws on a half-written file
    }
    await putFile({ name, text, mtime: file.lastModified, bytes: file.size });
    mtimes[name] = file.lastModified;
    imported++;
  }
  onProgress?.({ done: files.length, total: files.length, label: 'done' });

  // An optional file that has since left the folder must not linger in the
  // browser, answering from a publish that no longer says so.
  const present = new Set(files.map(([name]) => name));
  for (const name of OPTIONAL) {
    if (!present.has(name)) {
      await deleteFile(name);
      delete mtimes[name];
    }
  }

  const summary = {
    imported, skipped,
    generated_at: manifestData?.generated_at || null,
    imported_at: new Date().toISOString(),
    no_handle: !hasHandle,
    layout,
    flyers: Boolean(flyers),
  };
  await putMeta('manifest', { ...(manifestData || {}), ...summary });
  await putMeta('importState', { mtimes });
  return summary;
}

/**
 * Read one flyer PDF from the connected folder, as bytes. Needs the
 * 'parent' layout and a granted (or re-grantable — call from a click)
 * permission. Throws with a user-facing message.
 */
export async function readFlyer(path) {
  const seg = flyerSegments(path);
  if (!seg) throw new Error('This listing has no flyer in the bundle.');
  return readFromFolder(seg, 'flyer');
}

/** A Moody's listing screenshot from the connected folder. Same rules as a
 *  flyer: the 'parent' layout, and a click to re-grant permission. */
export async function readSnapshot(path) {
  const seg = snapshotSegments(path);
  if (!seg) throw new Error('This listing has no screenshot in the bundle.');
  return readFromFolder(seg, 'snapshot');
}

async function readFromFolder(seg, what) {
  const handle = await getSavedDirectory();
  if (!handle) throw new Error(`No folder connected — ${what}s are opened from the published folder.`);
  const perm = await directoryPermission(handle, { request: true });
  if (perm !== 'granted') throw new Error('Folder access was not granted.');
  let dir = handle;
  try {
    for (const d of seg.dirs) dir = await dir.getDirectoryHandle(d);
    return await (await dir.getFileHandle(seg.file)).getFile();
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      if (dir === handle) {
        throw new Error(seg.dirs[0] === FLYERS_DIR
          ? 'No flyers folder here — reconnect the published folder (the one holding export\\) to open flyers.'
          : 'No screenshots folder here — reconnect the published folder (the one holding export\\), or wait for the next publish to bring them.');
      }
      throw new Error(what === 'flyer'
        ? 'That flyer is not in the folder yet — it may still be syncing, or this publish did not include flyers.'
        : 'That screenshot is not in the folder yet — it may still be syncing.');
    }
    throw err;
  }
}

/**
 * Has the folder changed since the last import? Stats the files, reads
 * none. Returns null when we cannot tell (no handle / not granted).
 */
export async function checkForUpdates(dirHandle) {
  if (!dirHandle) return null;
  if ((await directoryPermission(dirHandle)) !== 'granted') return null;
  const prev = (await getMeta('importState')) || { mtimes: {} };
  const changed = [];
  try {
    const { bundleDir } = await resolveLayout(dirHandle);
    for await (const [name, handle] of bundleDir.entries()) {
      if (handle.kind !== 'file' || !KNOWN.includes(name)) continue;
      const file = await handle.getFile();
      if (prev.mtimes[name] !== file.lastModified) changed.push(name);
    }
  } catch { return null; }
  return { changed, count: changed.length };
}

/** Everything the UI needs to describe the connected bundle. */
export async function describeImport() {
  const manifest = await getMeta('manifest');
  if (!manifest) return { present: false };
  const texts = await getBundleTexts();
  return {
    present: Boolean(texts),
    manifest,
    generated_at: manifest.generated_at || null,
    imported_at: manifest.imported_at || null,
    auto_refresh: !manifest.no_handle && fsAccessSupported(),
    layout: manifest.layout || null,
    flyers: Boolean(manifest.flyers),
  };
}
