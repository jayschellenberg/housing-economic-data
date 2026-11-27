/*
 * wrreb-store.js — the Winnipeg Regional Real Estate Board (WRREB) monthly
 * market-release figures, held locally in the browser.
 *
 * WRREB's website terms allow private, non-commercial use only and forbid
 * publishing the data in any form, so the site ships none of it. The figures
 * are one small file, wrreb_market.json, written by r/16b_scrape_wrreb.R on
 * Jason's PC into SharedInfo\AppMarketData\AppMarketData-Internal\WRREBMarket
 * (staff and select people). The Local Data strip (market-data.js) fills this
 * store from that folder; the MB Economic Update tab merges the figures in.
 * Stored in IndexedDB ('hed-wrreb') and re-read when the file's modification
 * time changes. Nothing is uploaded.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^wrreb_market\.json$/i;
export const FIELDS = ['sales', 'active_listings', 'sfd_avg_price', 'sfa_avg_price', 'condo_avg_price'];
const store = createFolderStore({ dbName: 'hed-wrreb', pickerId: 'wrreb', stores: ['files'], appPath: ['WRREBMarket'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'wrreb');
export const clearWrreb = () => store.clear();

/** Throws unless `data` looks like r/16b's output (an as-of month and at least one figure). */
export function validate(data, name = 'wrreb_market.json') {
  const ok = data && typeof data.asOf === 'string'
    && FIELDS.some((k) => data[k] && Number.isFinite(Number(data[k].value)));
  if (!ok) throw new Error(`${name} is not a WRREB market-release file (expected asOf and sales / listings / price figures).`);
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'wrreb', data);
  const summary = {
    asOf: data.asOf,
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

/** Read the folder's wrreb_market.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No wrreb_market.json in that folder. Pick the WRREBMarket folder in AppMarketData-Internal.');
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
  if (!f) throw new Error('No wrreb_market.json in that selection.');
  return record(await parse(f), { mtime: f.lastModified, filename: f.name, no_handle: true });
}
