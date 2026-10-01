/*
 * store.js — the connected export bundle, held locally in the browser.
 *
 * Port of the parcel search's salesStore.js, simplified for a bundle of
 * three fixed files rather than N municipality shards.
 *
 * WHAT THIS IS. The site ships no data. The user nominates the published
 * export folder (Dropbox-synced) once; its files are read into IndexedDB
 * as raw text and parsed on demand. Nothing is uploaded and the server
 * never sees it — a visitor without the folder has no data, which is the
 * access control.
 *
 * WHY A DIRECTORY HANDLE. With the File System Access API the browser
 * keeps a handle to the folder across sessions (Chrome/Edge). On the
 * next visit we stat the files: a changed mtime means the weekly publish
 * ran, and Reload re-imports without re-picking. Firefox/Safari fall back
 * to a folder <input>, which works but cannot auto-detect updates.
 */

import { FILES } from './bundle.js';
import { detectLayout, evidenceSegments, EXPORT_DIR, EVIDENCE_DIR } from './evidencePath.js';
import { resolveAppFolder, filterAppFiles } from '../../../src/app-market-data.js';

const DB_NAME = 'mb-rental-explorer';
const DB_VERSION = 1;
const FILES_STORE = 'files';   // key: file name → { name, text, mtime, bytes }
const META_STORE = 'meta';     // key: 'manifest' | 'dirHandle' | 'importState'

const REQUIRED = [FILES.manifest, FILES.listings, FILES.segments];

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

/** Raw text of the three files, or null when any is missing. */
export async function getBundleTexts() {
  const recs = await Promise.all(REQUIRED.map(getFile));
  if (recs.some((r) => !r || typeof r.text !== 'string')) return null;
  return { manifest: recs[0].text, listings: recs[1].text, segments: recs[2].text };
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

/** Ask the user to nominate the export folder. Needs a user gesture. */
export async function pickDirectory() {
  if (!fsAccessSupported()) throw new Error('File System Access not supported in this browser');
  const picked = await window.showDirectoryPicker({ id: 'rental-export', mode: 'read' });
  const handle = await resolveAppFolder(picked, ['RentalDashboard']);
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
 * What the connected folder is. The RentalDashboard folder (preferred)
 * holds export/ and evidence/; the export folder alone still works but
 * evidence stays out of reach — a directory handle cannot see its parent.
 * @returns {{layout:'parent'|'export', evidence:boolean, bundleDir, evidenceDir}}
 */
async function resolveLayout(dirHandle) {
  const dirs = [], files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    (handle.kind === 'directory' ? dirs : files).push(name);
  }
  const { layout, evidence } = detectLayout({ dirs, files });
  const bundleDir = layout === 'parent' ? await dirHandle.getDirectoryHandle(EXPORT_DIR) : dirHandle;
  const evidenceDir = evidence ? await dirHandle.getDirectoryHandle(EVIDENCE_DIR) : null;
  return { layout, evidence, bundleDir, evidenceDir };
}

/** The three required files' handles from the bundle folder, or an error
 *  naming what is missing. */
async function requiredFiles(bundleDir) {
  const found = new Map();
  for await (const [name, handle] of bundleDir.entries()) {
    if (handle.kind === 'file' && REQUIRED.includes(name)) found.set(name, handle);
  }
  const missing = REQUIRED.filter((n) => !found.has(n));
  if (missing.length) {
    throw new Error(`The export folder is missing ${missing.join(', ')} — wait for the weekly publish to finish, then Reload.`);
  }
  return found;
}

/**
 * Read the folder into IndexedDB. Files whose mtime matches the last
 * import are skipped unless `force`. The manifest is always re-read (it
 * is tiny, and it is what "what's loaded" is described from).
 */
export async function importFromDirectory(dirHandle, { onProgress, force = false } = {}) {
  const { layout, evidence, bundleDir } = await resolveLayout(dirHandle);
  const handles = await requiredFiles(bundleDir);
  const files = await Promise.all(REQUIRED.map(async (n) => [n, await handles.get(n).getFile()]));
  return importFiles(files, { onProgress, force, hasHandle: true, layout, evidence });
}

/** Fallback for browsers without File System Access: a folder <input>
 *  or drag-drop. No handle is retained, so no update detection. */
export async function importFromFileList(fileList, { onProgress } = {}) {
  fileList = filterAppFiles(fileList, ['RentalDashboard']);
  const byName = new Map();
  for (const f of Array.from(fileList || [])) {
    const base = f.name.split('/').pop();
    if (REQUIRED.includes(base)) byName.set(base, f);
  }
  const missing = REQUIRED.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new Error(`Not the RentalDashboard folder: ${missing.join(', ')} not found. Pick the shared AppMarketData folder or its RentalDashboard subfolder.`);
  }
  return importFiles(REQUIRED.map((n) => [n, byName.get(n)]), { onProgress, force: true, hasHandle: false, layout: null, evidence: false });
}

async function importFiles(files, { onProgress, force, hasHandle, layout, evidence }) {
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

  const summary = {
    imported, skipped,
    generated_at: manifestData?.generated_at || null,
    imported_at: new Date().toISOString(),
    no_handle: !hasHandle,
    layout,
    evidence: Boolean(evidence),
  };
  await putMeta('manifest', { ...(manifestData || {}), ...summary });
  await putMeta('importState', { mtimes });
  return summary;
}

/**
 * Read one archived listing page from the connected folder. Needs the
 * 'parent' layout and a granted (or re-grantable — call from a click)
 * permission. Returns the HTML text; throws with a user-facing message.
 */
export async function readEvidence(path) {
  const seg = evidenceSegments(path);
  if (!seg) throw new Error('This listing has no archived page in the bundle.');
  const handle = await getSavedDirectory();
  if (!handle) throw new Error('No folder connected — the archive is opened from the RentalDashboard folder.');
  const perm = await directoryPermission(handle, { request: true });
  if (perm !== 'granted') throw new Error('Folder access was not granted.');
  let dir = handle;
  try {
    for (const d of seg.dirs) dir = await dir.getDirectoryHandle(d);
    const file = await (await dir.getFileHandle(seg.file)).getFile();
    return await file.text();
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      throw new Error(seg.dirs[0] === EVIDENCE_DIR && dir === handle
        ? 'No evidence folder here — reconnect the RentalDashboard folder (the parent of export) to open archived pages.'
        : 'That archived page is not in the folder yet — it may still be syncing, or it was pruned.');
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
      if (handle.kind !== 'file' || !REQUIRED.includes(name)) continue;
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
    evidence: Boolean(manifest.evidence),
  };
}
