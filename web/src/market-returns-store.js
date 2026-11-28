/*
 * market-returns-store.js — the equity and bond total-return series (XIC.TO,
 * ZFL.TO adjusted closes from Yahoo Finance) for the Market Discount Rates
 * tab's growth-of-$100 chart and narrative, held locally in the browser.
 *
 * Yahoo grants no licence to republish its prices, so the site ships none of
 * them. The series are one file, market_returns.json, written by
 * r/28b_scrape_market_returns.R on Jason's PC into
 * SharedInfo\AppMarketData\AppMarketData-Internal\MarketReturns (staff and
 * select people). The Local Data strip (market-data.js) fills this store from
 * that folder; discount-rates.js merges the series with the public CPI line.
 * Stored in IndexedDB ('hed-market-returns') and re-read when the file's
 * modification time changes. Nothing is uploaded.
 */

import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';

export { fsAccessSupported, storeAvailable, directoryPermission };

const DATA_FILE = /^market_returns\.json$/i;
const store = createFolderStore({ dbName: 'hed-market-returns', pickerId: 'market-returns', stores: ['files'], appPath: ['MarketReturns'] });

export const pickDirectory = () => store.pickDirectory();
export const getSavedDirectory = () => store.getSavedDirectory();
export const saveDirectory = (handle) => store.saveDirectory(handle);
export const getManifest = () => store.getMeta('manifest');
export const getData = () => store.get('files', 'returns');
export const clearMarketReturns = () => store.clear();

/** Throws unless `data` looks like r/28b's output (daily series with dates and values). */
export function validate(data, name = 'market_returns.json') {
  const ok = data && Array.isArray(data.series) && data.series.length > 0
    && data.series.every((s) => s && typeof s.id === 'string' && Array.isArray(s.dates)
      && Array.isArray(s.values) && s.dates.length === s.values.length && s.dates.length > 1);
  if (!ok) throw new Error(`${name} is not a market-returns file (expected series with dates and values).`);
}

async function findDataFile(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && DATA_FILE.test(name)) return handle;
  }
  return null;
}

async function record(data, { mtime, filename, no_handle = false }) {
  await store.put('files', 'returns', data);
  const summary = {
    built: data.built || null,
    stale: Boolean(data.stale),
    series: data.series.map((s) => s.id),
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

/** Read the folder's market_returns.json into IndexedDB (skipped when unchanged). */
export async function importFromDirectory(dirHandle, { force = false } = {}) {
  const fh = await findDataFile(dirHandle);
  if (!fh) throw new Error('No market_returns.json in that folder. Pick the MarketReturns folder in AppMarketData-Internal.');
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
  if (!f) throw new Error('No market_returns.json in that selection.');
  return record(await parse(f), { mtime: f.lastModified, filename: f.name, no_handle: true });
}

/**
 * The series from the store, re-read first when the saved folder (already
 * open this visit) holds a newer file. null when absent or unavailable.
 */
export async function loadMarketReturns() {
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
