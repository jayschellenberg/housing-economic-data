/*
 * market-data.js — connect every Local Data tab from one folder pick.
 *
 * Each Local Data tab keeps its own IndexedDB store and its own saved folder
 * handle (local-folder-store.js and friends). Clearing site data wipes them
 * all, which used to mean picking nine folders again. This module keeps one
 * more saved handle, or a few, to a folder that CONTAINS the tabs' folders —
 * normally AppMarketData itself — and from it fills in each tab:
 *
 *   - a tab with no saved folder gets the matching subfolder saved as its own,
 *     so its usual "re-check each visit" logic works unchanged;
 *   - a tab with no data yet gets that subfolder imported;
 *   - a tab whose saved folder is somewhere else (the viewer picked it on the
 *     tab) is left alone — a per-tab pick always wins;
 *   - a tab that already has data is not re-imported here. Its own update
 *     check runs as before; the dashboards in particular only ever offer a
 *     reload, never swap data mid-analysis.
 *
 * Several connected folders are allowed. Colleagues who get only some
 * subfolders find them at the top of their own Dropbox; they can move them
 * into one folder and pick that, or connect each one here.
 *
 * Chrome grants access to a folder and everything inside it, so one "Allow"
 * on the connected folder re-opens every tab's subfolder for the visit.
 *
 * SalesData is deliberately not in SOURCES: no tab on this site reads it, and
 * it is never opened when the whole AppMarketData folder is connected.
 */

import { appMarketDataChildren } from './app-market-data.js';
import { createFolderStore, fsAccessSupported, storeAvailable, directoryPermission } from './local-folder-store.js';
import { announceSources } from './market-data-channel.js';
// The tab stores are in the main bundle already; the two dashboards' stores
// load only when needed.
import * as capRatesStore from './cap-rates-store.js';
import * as johnsonStore from './johnson-store.js';
import * as yardiStore from './yardi-store.js';
import * as rentalsCaStore from './rentalsca-store.js';
import * as fccStore from './fcc-store.js';
import * as brokerageStore from './brokerage-store.js';
import * as zoningStore from './zoning-store.js';
import * as aptCompsStore from './apartment-comps-store.js';

export { fsAccessSupported, storeAvailable };

const hasFolderData = async (s) => Boolean(await s.getData());
const hasDashboardData = async (s) => Boolean((await s.describeImport())?.present);

/**
 * The tabs this site fills from AppMarketData. `folder` is the subfolder
 * name; `label` names the tab(s) in the status list.
 */
export const SOURCES = [
  { id: 'caprates',   label: 'Cap Rates (and Cap Rates vs Interest)', folder: 'CapRates',
    load: async () => capRatesStore, hasData: hasFolderData },
  { id: 'johnson',    label: 'Johnson Report', folder: 'JohnsonReport',
    load: async () => johnsonStore,
    hasData: async (s) => ((await s.listEditionIds()) || []).length > 0 },
  { id: 'yardi',      label: 'Yardi Rental', folder: 'RentalData',
    load: async () => yardiStore, hasData: hasFolderData },
  { id: 'rentalsca',  label: 'Rentals.ca', folder: 'RentalData',
    load: async () => rentalsCaStore, hasData: hasFolderData },
  { id: 'fcc',        label: 'FCC Farmland', folder: 'FCCFarmland',
    load: async () => fccStore, hasData: hasFolderData },
  { id: 'brokerage',  label: 'Brokerage Reports', folder: 'BrokerageReports',
    load: async () => brokerageStore, hasData: hasFolderData },
  { id: 'zoning',     label: 'Zoning', folder: 'Zoning',
    load: async () => zoningStore, hasData: hasFolderData },
  { id: 'aptcomps',   label: 'Apartment Income & Expenses', folder: 'ApartmentComps',
    load: async () => aptCompsStore, hasData: hasFolderData },
  { id: 'rental',     label: 'Rental Dashboard', folder: 'RentalDashboard',
    load: () => import('../rental/src/lib/store.js'), hasData: hasDashboardData },
  { id: 'commercial', label: 'Commercial Dashboard', folder: 'CommercialAvailability',
    load: () => import('../commercial/src/lib/store.js'), hasData: hasDashboardData },
];

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function childDirectory(dir, name) {
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'directory' && same(n, name)) return h;
  }
  return null;
}

/**
 * The `folder` subfolder reachable from a connected folder, or null. Accepts
 * the subfolder itself, a folder holding it (a tier folder such as
 * AppMarketData-Internal, or a folder the viewer gathered shared subfolders
 * into), or a folder holding tier folders or AppMarketData, two levels deep:
 * SharedInfo > AppMarketData > AppMarketData-Internal > Zoning.
 */
export async function findSourceFolder(root, folder, depth = 2) {
  if (!root) return null;
  if (same(root.name, folder)) return root;
  const direct = await childDirectory(root, folder);
  if (direct || depth <= 0) return direct;
  for (const amd of await appMarketDataChildren(root)) {
    const found = await findSourceFolder(amd, folder, depth - 1);
    if (found) return found;
  }
  return null;
}

async function sameEntry(a, b) {
  try { return Boolean(a && b && await a.isSameEntry(b)); } catch { return false; }
}

// --- Connected folders ---------------------------------------------------------

const rootStore = createFolderStore({ dbName: 'hed-market-data', pickerId: 'app-market-data', stores: [] });

/** The connected folder handles, oldest first. */
export async function getRoots() {
  if (!storeAvailable()) return [];
  try { return (await rootStore.getMeta('roots')) || []; } catch { return []; }
}

const putRoots = (roots) => rootStore.putMeta('roots', roots);

/** Ask for a folder and add it to the connected list. Needs a user gesture. */
export async function connectFolder() {
  if (!fsAccessSupported()) throw new Error('This browser cannot remember folders. Use Chrome or Edge.');
  const picked = await window.showDirectoryPicker({ id: 'app-market-data', mode: 'read' });
  const roots = await getRoots();
  const kept = [];
  for (const r of roots) if (!(await sameEntry(r, picked))) kept.push(r);
  await putRoots([...kept, picked]);
  return picked;
}

/** Forget every connected folder. Tabs keep what they already imported. */
export const forgetFolders = () => putRoots([]);

/**
 * 'none' with nothing connected, 'granted' when every connected folder is
 * open for this visit, 'prompt' when Chrome wants one click first, 'denied'.
 */
export async function rootsPermission({ request = false } = {}) {
  const roots = await getRoots();
  if (!roots.length) return 'none';
  const states = [];
  for (const r of roots) states.push(await directoryPermission(r, { request }));
  if (states.every((s) => s === 'granted')) return 'granted';
  if (states.some((s) => s === 'prompt')) return 'prompt';
  return states.some((s) => s === 'granted') ? 'granted' : 'denied';
}

// --- Filling the tabs ------------------------------------------------------------

/**
 * Fill one tab from the open connected folders (`roots`). Exported for tests.
 * Status of one source after a sync:
 *   'loaded'      read from the connected folder (or already held)
 *   'own-folder'  the tab has its own folder pick, left as it is
 *   'not-shared'  no connected folder holds it
 *   'locked'      a connected folder still needs "Allow" this visit
 *   'error'       found, but the import failed (`message` says why)
 */
export async function syncSource(src, roots, { anyLocked = false } = {}) {
  let sub = null;
  for (const r of roots) {
    try { sub = await findSourceFolder(r, src.folder); } catch { sub = null; }
    if (sub) break;
  }
  if (!sub) return { status: anyLocked ? 'locked' : 'not-shared' };

  const store = await src.load();
  const saved = await store.getSavedDirectory();
  if (saved && !(await sameEntry(saved, sub))) {
    // A different folder picked on the tab. If it is still reachable it is
    // the viewer's choice; if Chrome has lost it outright, take ours.
    if ((await directoryPermission(saved)) !== 'denied') return { status: 'own-folder' };
  }
  if (!saved || !(await sameEntry(saved, sub))) await store.saveDirectory(sub);
  if (await src.hasData(store)) return { status: 'loaded' };
  try {
    await store.importFromDirectory(sub);
    return { status: 'loaded', imported: true };
  } catch (err) {
    return { status: 'error', message: err?.message || String(err) };
  }
}

/**
 * Fill every tab from the connected folders and say what happened.
 * `request` asks Chrome for access (needs a user gesture).
 * @returns {Promise<{ permission: string, sources: Array<{id,label,folder,status,message?}> }>}
 */
export async function syncSources({ request = false } = {}) {
  const permission = await rootsPermission({ request });
  const all = await getRoots();
  const open = [];
  for (const r of all) if ((await directoryPermission(r)) === 'granted') open.push(r);
  const anyLocked = open.length < all.length;

  const sources = [];
  const imported = [];
  for (const src of SOURCES) {
    let res;
    try { res = await syncSource(src, open, { anyLocked }); }
    catch (err) { res = { status: 'error', message: err?.message || String(err) }; }
    if (res.imported) imported.push(src.id);
    sources.push({ id: src.id, label: src.label, folder: src.folder, status: res.status, message: res.message });
  }
  // Announce every source we touched: an import, or a newly saved folder a
  // tab that is already open should now re-check with this visit's access.
  announceSources(sources.filter((s) => s.status === 'loaded').map((s) => s.id));
  return { permission, sources, imported };
}
