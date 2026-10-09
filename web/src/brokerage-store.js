/*
 * brokerage-store.js — the parsed brokerage market reports, held locally in
 * the browser.
 *
 * The data is one file, brokerage.json, written by
 * Brokerage-Reports/ingest/parse_brokerage.py and published to
 * SharedInfo\AppMarketData\BrokerageReports. The user nominates that folder
 * once; the browser keeps a handle, stores the parsed JSON in IndexedDB
 * ('hed-brokerage') and re-reads the file on the next visit when its
 * modification time changed. Nothing is uploaded and the site ships none of it.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^brokerage\.json$/i;
const store = createFolderStore({ dbName: 'hed-brokerage', pickerId: 'brokerage', stores: ['files'], appPath: ['BrokerageReports'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'brokerage');
export const clearBrokerage = () => store.clear();

function validate(data, name) {
  if (!data || !Array.isArray(data.sources) || !Array.isArray(data.obs) || typeof data.metrics !== 'object') {
    throw new Error(`${name} is not a parsed brokerage-reports file (expected sources, obs, metrics).`);
  }
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'brokerage', data);
  const periods = data.sources.map(s => s.period).sort();
  const summary = {
    editions: data.sources.length,
    figures: data.obs.length,
    first: periods[0] || null,
    last: periods[periods.length - 1] || null,
    parsed_at: data.generated_at || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

/** Read the folder's brokerage.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No brokerage.json in that folder. Pick the BrokerageReports folder published by Brokerage-Reports\\ingest\\run.bat.');
  const file = await fh.getFile();
  const prev = await store.getMeta('importState');
  const existing = await getData();
  if (!force && existing && prev?.mtime === file.lastModified) {
    return { ...(await getManifest()), skipped: true };
  }
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
  validate(data, file.name);
  return record(data, { mtime: file.lastModified, filename: file.name });
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
    return { changed: prev?.mtime !== file.lastModified, mtime: file.lastModified };
  } catch { return null; }
}

/** Fallback for browsers without the File System Access API: a <input webkitdirectory> list. */
export async function importFromFileList(fileList) {
  const files = [...(fileList || [])];
  const file = files.find(f => DATA_FILE.test(f.name));
  if (!file) throw new Error('No brokerage.json in the chosen folder.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
  validate(data, file.name);
  return record(data, { mtime: file.lastModified, filename: file.name, no_handle: true });
}
