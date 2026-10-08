/*
 * fcc-store.js — the parsed FCC Farmland Values Reports, held locally in the
 * browser.
 *
 * The data is one file, fcc_farmland.json, written by
 * FCC-Farmland/ingest/parse_fcc.py and published to
 * SharedInfo\AppMarketData\FCCFarmland. The user nominates that folder once;
 * the browser keeps a handle, stores the parsed JSON in IndexedDB
 * ('hed-fcc') and re-reads the file on the next visit when its modification
 * time changed. Nothing is uploaded and the site ships none of it.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^fcc_farmland\.json$/i;
const store = createFolderStore({ dbName: 'hed-fcc', pickerId: 'fcc', stores: ['files'], appPath: ['FCCFarmland'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'fcc');
export const clearFcc = () => store.clear();

function validate(data, name) {
  if (!data || !Array.isArray(data.prov_change) || !Array.isArray(data.region_obs) || !Array.isArray(data.narratives)) {
    throw new Error(`${name} is not a parsed FCC farmland file (expected prov_change, region_obs, narratives).`);
  }
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'fcc', data);
  const ys = data.prov_change.map(r => r[0]);
  const summary = {
    reports: (data.reports || []).length,
    first: ys.length ? Math.min(...ys) : null,
    last: ys.length ? Math.max(...ys) : null,
    regions: (data.regions || []).length,
    parsed_at: data.generated_at || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

/** Read the folder's fcc_farmland.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No fcc_farmland.json in that folder. Pick the FCCFarmland folder published by FCC-Farmland\\ingest\\run.bat.');
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
  if (!f) throw new Error('No fcc_farmland.json in that selection.');
  let data;
  try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON.`); }
  validate(data, f.name);
  return record(data, { mtime: f.lastModified, filename: f.name, no_handle: true });
}
