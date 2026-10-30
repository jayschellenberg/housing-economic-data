/*
 * apartment-comps-store.js — the Apartment Comps data, held locally in the
 * browser.
 *
 * The data is one file, apartment_comps.json, written by
 * scripts/apartment_comps.py (build) to SharedInfo\AppMarketData\AppMarketData-Internal\ApartmentComps
 * from the appraiser's comps database and the extracted listings, pro formas
 * and CIMs. The CIMs are brokers' confidential material, so none of it ships
 * with the site: the user nominates the folder once, the browser keeps a
 * handle, stores the JSON in IndexedDB ('hed-apartment-comps') and re-reads
 * the file on the next visit when its modification time changed.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^apartment_comps\.json$/i;
const store = createFolderStore({ dbName: 'hed-apartment-comps', pickerId: 'apartment-comps', stores: ['files'], appPath: ['ApartmentComps'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'comps');
export const clearApartmentComps = () => store.clear();

function validate(data, name) {
  if (!data || !Array.isArray(data.records)) {
    throw new Error(`${name} is not an Apartment Comps file (expected records).`);
  }
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'comps', data);
  const summary = {
    records: data.records.length,
    db: data.sources?.db?.records ?? null,
    documents: data.sources?.docs?.documents ?? null,
    checked: data.sources?.docs?.checked ?? null,
    built_at: data.generated_at || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

/** Read the folder's apartment_comps.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No apartment_comps.json in that folder. Pick the ApartmentComps folder written by apartment-comps-rebuild.bat.');
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
  if (!f) throw new Error('No apartment_comps.json in that selection.');
  let data;
  try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON.`); }
  validate(data, f.name);
  return record(data, { mtime: f.lastModified, filename: f.name, no_handle: true });
}
