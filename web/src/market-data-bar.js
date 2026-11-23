/*
 * market-data-bar.js — the "Connect AppMarketData folder" strip under the Local
 * Data tab bar. One pick (or one "Allow" on later visits) fills every Local
 * Data tab the viewer has access to; see market-data.js for the rules.
 *
 * Chrome / Edge only: without the File System Access API a browser cannot keep
 * a folder between visits, so the strip removes itself there and each tab's own
 * folder input carries on as before.
 */

import {
  fsAccessSupported, storeAvailable, connectFolder, forgetFolders,
  syncSources, getRoots, sourceIsStale,
} from './market-data.js';

// The tab buttons each source feeds. Cap Rates vs Interest reads the Cap
// Rates store; Rent Comparison only re-reads the Yardi / Rentals.ca stores, so
// it is not flagged.
const SOURCE_TABS = { caprates: ['caprates', 'capvsint'] };
const tabsOf = (id) => SOURCE_TABS[id] || [id];
const DASHBOARDS = new Set(['rental', 'commercial']);

const STATUS_TEXT = {
  'loaded': 'connected',
  'own-folder': 'connected (uses the folder chosen on that tab)',
  'not-shared': 'not found — not shared with you',
  'locked': 'waiting for Allow',
  'error': 'could not be read',
};

let ui = null;
let busy = false;
const stale = new Set();   // source ids whose folder holds a newer file

export function initMarketDataBar() {
  const $bar = document.getElementById('market-data-bar');
  if (!$bar) return;
  if (!fsAccessSupported() || !storeAvailable()) { $bar.remove(); return; }
  ui = {
    $bar,
    $status: document.getElementById('md-status'),
    $error: document.getElementById('md-error'),
    $connect: document.getElementById('md-connect'),
    $allow: document.getElementById('md-allow'),
    $add: document.getElementById('md-add'),
    $forget: document.getElementById('md-forget'),
    $list: document.getElementById('md-list'),
    $folders: document.getElementById('md-folders'),
  };
  ui.$connect.addEventListener('click', () => run(async () => { await connectFolder(); return syncSources(); }));
  ui.$add.addEventListener('click', () => run(async () => { await connectFolder(); return syncSources(); }));
  ui.$allow.addEventListener('click', () => run(() => syncSources({ request: true })));
  ui.$forget.addEventListener('click', async () => {
    const ok = window.confirm('Forget the connected AppMarketData folder in this browser? '
      + 'Each Local Data tab keeps the data it already loaded, and nothing on disk changes.');
    if (!ok) return;
    await forgetFolders();
    await refresh();
  });
  refresh().catch((err) => console.error('[market-data bar]', err));

  // A flagged tab re-reads its folder when opened (the dashboards on Reload).
  // Watch its folder for a while after it is opened and clear the flag once
  // the tab holds the newer file; also look again whenever the page regains
  // focus, in case something was republished while it sat in the background.
  // main.js marks the open tab with aria-current (it switches tabs through
  // replaceState, so there is no hashchange to listen for).
  const $nav = document.getElementById('nav-local');
  if ($nav) {
    new MutationObserver(() => { const t = activeLocalTab(); if (t) watchTab(t); })
      .observe($nav, { subtree: true, attributeFilter: ['aria-current'] });
  }
  window.addEventListener('focus', () => { if (!busy) refresh().catch(() => {}); });
}

const activeLocalTab = () => document.querySelector('#nav-local [data-tab][aria-current="page"]')?.dataset.tab || null;

const watching = new Map();   // source id -> interval
function watchTab(tab) {
  for (const id of stale) {
    if (!tabsOf(id).includes(tab) || watching.has(id)) continue;
    let tries = 0;
    // Dashboards wait for a Reload click, so watch them longer.
    const max = DASHBOARDS.has(id) ? 300 : 30;
    const timer = setInterval(async () => {
      tries += 1;
      if (!(await sourceIsStale(id))) markFresh(id);
      if (!stale.has(id) || tries >= max) { clearInterval(timer); watching.delete(id); }
    }, 2000);
    watching.set(id, timer);
  }
}

/** Dot the tab buttons (and their menus, and the Local Data link) of stale sources. */
function paintFlags() {
  const tip = "A newer file is in this tab's folder. Open the tab to load it.";
  const flagged = new Set([...stale].flatMap(tabsOf));
  for (const btn of document.querySelectorAll('#nav-local [data-tab]')) {
    const on = flagged.has(btn.dataset.tab);
    btn.classList.toggle('md-stale', on);
    if (on) btn.title = DASHBOARDS.has(btn.dataset.tab)
      ? "A newer file is in this dashboard's folder. Open it and click Reload folder." : tip;
    else if (btn.title?.startsWith('A newer file')) btn.removeAttribute('title');
  }
  for (const menu of document.querySelectorAll('#nav-local .cmhc-menu')) {
    const on = Boolean(menu.querySelector('.md-stale'));
    menu.querySelector('.cmhc-menu-trigger')?.classList.toggle('md-stale', on);
  }
  const $link = document.getElementById('group-link-local');
  if ($link) {
    $link.classList.toggle('md-stale', stale.size > 0);
    $link.dataset.staleCount = String(stale.size);
  }
}

async function run(job) {
  if (busy) return;
  busy = true;
  showError('');
  setStatus('Reading your folders…');
  try {
    const result = await job();
    await render(result);
  } catch (err) {
    if (err?.name !== 'AbortError') showError(err?.message || String(err));
    await refresh();
  } finally { busy = false; }
}

/** Show the state without asking Chrome for anything. */
async function refresh() {
  // syncSources reads only folders already open this visit, so it is safe
  // without a click; it also checks folders picked on the tabs themselves.
  return render(await syncSources());
}

let lastResult = null;
function markFresh(id) {
  stale.delete(id);
  if (!lastResult) { paintFlags(); return; }
  for (const s of lastResult.sources) if (s.id === id) s.stale = false;
  render(lastResult).catch(() => {});
}

function setStatus(text) { ui.$status.textContent = text; }
function showError(msg) {
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}
function show(el, on) { el.hidden = !on; }

function sourceText(s) {
  if (stale.has(s.id)) {
    return DASHBOARDS.has(s.id)
      ? 'newer file in its folder — open it and click Reload folder'
      : 'newer file in its folder — open the tab to load it';
  }
  let text = STATUS_TEXT[s.status] || s.status;
  if (s.status === 'loaded' && s.imported) text += ' (newer file loaded)';
  if (s.status === 'own-folder' && s.unchecked) text += '; not checked for updates until you re-open it on the tab';
  return text;
}

function renderList(sources) {
  ui.$list.textContent = '';
  for (const s of sources) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'font-medium';
    name.textContent = s.label;
    li.append(name, ` — ${sourceText(s)}`);
    if (s.message) li.append(`: ${s.message}`);
    if (stale.has(s.id)) li.className = 'text-amber-700';
    else if (s.status === 'not-shared' || s.status === 'error') li.className = 'text-neutral-500';
    ui.$list.appendChild(li);
  }
}

async function render(result) {
  const { permission, sources } = result;
  lastResult = result;
  stale.clear();
  for (const s of sources) if (s.stale) stale.add(s.id);
  paintFlags();
  const active = activeLocalTab();
  if (active) watchTab(active);
  const roots = await getRoots();
  show(ui.$connect, permission === 'none' || permission === 'denied');
  show(ui.$allow, permission === 'prompt');
  show(ui.$add, permission !== 'none');
  show(ui.$forget, permission !== 'none');

  ui.$folders.textContent = roots.length
    ? `Connected folder${roots.length === 1 ? '' : 's'}: ${roots.map((r) => r.name).join(', ')}`
    : '';

  renderList(sources);

  if (permission === 'none') {
    setStatus('Load every Local Data tab you have access to with one folder pick.');
  } else if (permission === 'prompt') {
    setStatus('Your AppMarketData folder is remembered. Chrome needs one click to open it for this visit.');
  } else if (permission === 'denied') {
    setStatus('Chrome blocked access to the connected folder. Connect it again.');
  } else {
    const ok = sources.filter((s) => s.status === 'loaded' || s.status === 'own-folder').length;
    setStatus(`AppMarketData connected: ${ok} of ${sources.length} Local Data sources.`);
  }
  if (stale.size) {
    const names = sources.filter((s) => stale.has(s.id)).map((s) => s.label).join(', ');
    setStatus(`${ui.$status.textContent} Newer file waiting: ${names}.`);
  }
}
