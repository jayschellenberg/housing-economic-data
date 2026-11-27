/*
 * altus-store.js — the Altus Group Canadian Cost Guide ranges, held locally
 * in the browser.
 *
 * The guide is Altus Group copyright ("All Rights Reserved", no reuse terms
 * published), so the site ships none of it. scripts/altus_cost_guide.py
 * writes one file, altus_cost_guide.json, to
 * SharedInfo\AppMarketData\AppMarketData-External\AltusCostGuide. The user
 * connects AppMarketData once (the Local Data strip) or this folder; the
 * browser stores the parsed JSON in IndexedDB ('hed-altus') and re-reads the
 * file when its modification time changes. Same pattern as fcc-store.js.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^altus_cost_guide\.json$/i;
const store = createFolderStore({ dbName: 'hed-altus', pickerId: 'altus', stores: ['files'], appPath: ['AltusCostGuide'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'altus');
export const clearAltus = () => store.clear();

function validate(data, name) {
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.cities) || !Array.isArray(data.years)) {
    throw new Error(`${name} is not an Altus cost guide file (expected rows, cities, years).`);
  }
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'altus', data);
  const summary = {
    rows: data.rows.length,
    first: data.years.length ? Math.min(...data.years) : null,
    last: data.years.length ? Math.max(...data.years) : null,
    cities: data.cities.length,
    parsed_at: data.built || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
  await store.putMeta('manifest', summary);
  await store.putMeta('importState', { mtime });
  return summary;
}

/** Read the folder's altus_cost_guide.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No altus_cost_guide.json in that folder. Pick the AltusCostGuide folder (or AppMarketData) written by scripts/altus_cost_guide.py.');
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
  if (!f) throw new Error('No altus_cost_guide.json in that selection.');
  let data;
  try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON.`); }
  validate(data, f.name);
  return record(data, { mtime: f.lastModified, filename: f.name, no_handle: true });
}
