/*
 * crea-store.js — CREA's MLS® Home Price Index single-family benchmarks
 * (Winnipeg + six western boards), held locally in the browser.
 *
 * CREA's terms (crea.ca/legal) allow private, non-commercial use and need
 * CREA's prior written consent to publish HPI values or charts, so the site
 * ships none of it. The figures are one file, mls_benchmark.json, written by
 * r/16_scrape_mls.R on Jason's PC into
 * SharedInfo\AppMarketData\AppMarketData-Internal\CREAHPI (staff and select
 * people). The Local Data strip (market-data.js) fills this store from that
 * folder; the MB Economic Update (HPI sentence, Figure 3) and Affordability
 * (purchase factor) tabs read it. Stored in IndexedDB ('hed-crea') and re-read
 * when the file's modification time changes. Nothing is uploaded.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^mls_benchmark\.json$/i;
const store = createFolderStore({ dbName: 'hed-crea', pickerId: 'crea', stores: ['files'], appPath: ['CREAHPI'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'crea');
export const clearCrea = () => store.clear();

/** Throws unless `data` looks like r/16's output (benchmark series with latest values). */
export function validate(data, name = 'mls_benchmark.json') {
  const ok = data && Array.isArray(data.series)
    && data.series.some((s) => /^mls\.hpi\./.test(String(s?.id)) && Number.isFinite(Number(s.latestValue)));
  if (!ok) throw new Error(`${name} is not a CREA HPI benchmark file (expected mls.hpi.* series).`);
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'crea', data);
  const summary = {
    asOf: data.asOf || null,
    fetched: data.fetched || null,
    stale: Boolean(data.stale),
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

async function parse(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
  validate(data, file.name);
  return data;
}

/** Read the folder's mls_benchmark.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No mls_benchmark.json in that folder. Pick the CREAHPI folder in AppMarketData-Internal.');
  const file = await fh.getFile();
  const prev = await store.getMeta('importState');
  const existing = await getData();
  if (!force && existing && prev?.mtime === file.lastModified) {
    return { ...(await getManifest()), skipped: true };
  }
  return record(await parse(file), { mtime: file.lastModified, filename: file.name });
}

/** Has the file changed since the last import? null when we cannot tell. */
export async function checkForUpdates(dirHandle) {
  if (!dirHandle) return null;
  if ((await directoryPermission(dirHandle)) !== 'granted') return null;
  try {
    const fh = await findDataFile(dirHandle);
    if (!fh) return null;
    const file = await fh.getFile();
    const prev = await store.getMeta('importState');
    return { changed: prev?.mtime !== file.lastModified };
  } catch { return null; }
}

/** Fallback for browsers without File System Access: a folder or file pick. */
export async function importFromFileList(fileList) {
  const f = Array.from(fileList || []).find((x) => DATA_FILE.test(x.name));
  if (!f) throw new Error('No mls_benchmark.json in that selection.');
  return record(await parse(f), { mtime: f.lastModified, filename: f.name, no_handle: true });
}

/**
 * The benchmarks from the store, re-read first when the saved folder (already
 * open this visit) holds a newer file. null when absent or unavailable.
 */
export async function loadCrea() {
  try {
    if (!storeAvailable()) return null;
    const saved = await getSavedDirectory();
    if (saved && (await directoryPermission(saved)) === 'granted') {
      const upd = await checkForUpdates(saved);
      if (upd?.changed) await importFromDirectory(saved).catch(() => null);
    }
    return (await getData()) || null;
  } catch { return null; }
}
