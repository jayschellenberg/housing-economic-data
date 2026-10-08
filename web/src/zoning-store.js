/*
 * zoning-store.js — parsed Manitoba zoning by-laws, held locally in the browser.
 *
 * The data is one file, zoning.json, written by R/export.R in the
 * zoning-narrative project and published to SharedInfo\AppMarketData\Zoning.
 * Only municipalities whose review sheet has been signed off are exported.
 * Access is controlled by who the folder is shared with: the user nominates
 * it once, the browser keeps a handle, stores the JSON in IndexedDB
 * ('hed-zoning') and re-reads the file when its modification time changed.
 * Nothing is uploaded and the site ships none of it.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^zoning\.json$/i;
const store = createFolderStore({ dbName: 'hed-zoning', pickerId: 'zoning', stores: ['files'], appPath: ['Zoning'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'zoning');
export const clearZoning = () => store.clear();

function validate(data, name) {
  if (!data || !Array.isArray(data.municipalities)) {
    throw new Error(`${name} is not a zoning export (expected a municipalities list).`);
  }
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'zoning', data);
  const summary = {
    municipalities: data.municipalities.length,
    zones: data.municipalities.reduce((n, m) => n + (m.zones?.length || 0), 0),
    generated: data.generated || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

/** Read the folder's zoning.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No zoning.json in that folder. Pick the Zoning folder published by the zoning-narrative export.');
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
    return { changed: prev?.mtime !== file.lastModified };
  } catch { return null; }
}

/** Fallback for browsers without File System Access: a folder or file pick. */
export async function importFromFileList(fileList) {
  const f = Array.from(fileList || []).find(x => DATA_FILE.test(x.name));
  if (!f) throw new Error('No zoning.json in that selection.');
  let data;
  try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON.`); }
  validate(data, f.name);
  return record(data, { mtime: f.lastModified, filename: f.name, no_handle: true });
}
