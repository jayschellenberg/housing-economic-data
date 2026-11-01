/*
 * neighbourhood-store.js — pre-written neighbourhood / community narratives,
 * held locally in the browser, plus the appraisers' saved edits.
 *
 * web/scripts/build-neighbourhood.mjs writes neighbourhood.json to
 * SharedInfo\AppMarketData\AppMarketData-Internal\Neighbourhood. Edits live
 * beside it as one small file per write-up in edits/ (so two people editing
 * different communities never overwrite each other) and travel with the
 * folder through Dropbox. Reading needs only read access; saving an edit asks
 * for write access to the folder the first time. Nothing is uploaded.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^neighbourhood\.json$/i;
const EDITS_DIR = 'edits';
const store = createFolderStore({ dbName: 'hed-neighbourhood', pickerId: 'neighbourhood', stores: ['files'], appPath: ['Neighbourhood'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'neighbourhood');
export const getEdits = async () => (await store.get('files', 'edits')) || {};
export const clearNeighbourhood = () => store.clear();

// Edit file name for a write-up id ("C:Kleefeld", "WPG_NB:Wolseley", "4602041:overview").
export const editFileName = (id) => `${String(id).replace(/[^A-Za-z0-9_-]+/g, '_')}.json`;

function validate(data, name) {
  if (!data || data.kind !== 'neighbourhood-narratives' || !Array.isArray(data.groups)) {
    throw new Error(`${name} is not a neighbourhood narratives export (expected a groups list).`);
  }
}
function validEdit(e) {
  return e && typeof e.id === 'string' && e.sections && typeof e.sections === 'object';
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function readEdits(dirHandle) {
  const edits = {};
  let dir = null;
  try { dir = await dirHandle.getDirectoryHandle(EDITS_DIR); } catch { return edits; }
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !/\.json$/i.test(name)) continue;
    try {
      const e = JSON.parse(await (await h.getFile()).text());
      if (validEdit(e)) edits[e.id] = e;
    } catch { /* a half-synced or hand-broken file: skip it */ }
  }
  return edits;
}

function summarise(data, edits, { filename, no_handle = false }) {
  return {
    areas: data.groups.length,
    items: data.groups.reduce((n, g) => n + (g.items?.length || 0), 0),
    edits: Object.keys(edits).length,
    generated: data.generated || null,
    filename,
    imported_at: new Date().toISOString(),
    no_handle,
  };
}

/** Read neighbourhood.json (skipped when unchanged) and every saved edit. */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No neighbourhood.json in that folder. Pick the Neighbourhood folder (AppMarketData-Internal\\Neighbourhood).');
  const file = await fh.getFile();
  const prev = await store.getMeta('importState');
  let data = await getData();
  if (force || !data || prev?.mtime !== file.lastModified) {
    try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not valid JSON.`); }
    validate(data, file.name);
    await store.put('files', 'neighbourhood', data);
    await store.putMeta('importState', { mtime: file.lastModified });
  }
  const edits = await readEdits(dirHandle);
  await store.put('files', 'edits', edits);
  const summary = summarise(data, edits, { filename: file.name });
  await store.putMeta('manifest', summary);
  return summary;
}

/** Has the main file changed since the last import? null when we cannot tell. */
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

/** Fallback for browsers without folder access: a <input webkitdirectory> pick. */
export async function importFromFileList(fileList) {
  const files = Array.from(fileList || []);
  const f = files.find(x => DATA_FILE.test(x.name));
  if (!f) throw new Error('No neighbourhood.json in that selection.');
  let data;
  try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON.`); }
  validate(data, f.name);
  const edits = {};
  for (const x of files) {
    if (!/(^|[\\/])edits[\\/][^\\/]+\.json$/i.test(x.webkitRelativePath || '')) continue;
    try { const e = JSON.parse(await x.text()); if (validEdit(e)) edits[e.id] = e; } catch { /* skip */ }
  }
  await store.put('files', 'neighbourhood', data);
  await store.put('files', 'edits', edits);
  const summary = summarise(data, edits, { filename: f.name, no_handle: true });
  await store.putMeta('manifest', summary);
  return summary;
}

// Write access to the saved folder, asked for on the first save. Needs a user gesture.
async function writableFolder() {
  if (!fsAccessSupported()) throw new Error('Saving edits needs Chrome or Edge (folder access).');
  const dir = await getSavedDirectory();
  if (!dir) throw new Error('Choose the Neighbourhood folder first — edits are saved into it.');
  const opts = { mode: 'readwrite' };
  let state = await dir.queryPermission(opts);
  if (state === 'prompt') state = await dir.requestPermission(opts);
  if (state !== 'granted') throw new Error('Write access to the Neighbourhood folder was not granted, so the edit was not saved.');
  return dir.getDirectoryHandle(EDITS_DIR, { create: true });
}

/**
 * Save one write-up's edited sections.
 * @param {object} edit { id, name, sections:{heading:text}, base:{heading:generated text}, by }
 */
export async function saveEdit(edit) {
  const rec = { ...edit, editedAt: new Date().toISOString() };
  if (!validEdit(rec)) throw new Error('Nothing to save.');
  const dir = await writableFolder();
  const fh = await dir.getFileHandle(editFileName(rec.id), { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(rec, null, 2));
  await w.close();
  const edits = await getEdits();
  edits[rec.id] = rec;
  await store.put('files', 'edits', edits);
  return rec;
}

/** Drop a write-up's saved edit so the generated text shows again. */
export async function removeEdit(id) {
  const dir = await writableFolder();
  try { await dir.removeEntry(editFileName(id)); } catch (err) { if (err?.name !== 'NotFoundError') throw err; }
  const edits = await getEdits();
  delete edits[id];
  await store.put('files', 'edits', edits);
}
