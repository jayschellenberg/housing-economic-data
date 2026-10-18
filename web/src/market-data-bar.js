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
  rootsPermission, syncSources, getRoots,
} from './market-data.js';

const STATUS_TEXT = {
  'loaded': 'connected',
  'own-folder': 'connected (uses the folder chosen on that tab)',
  'not-shared': 'not found — not shared with you',
  'locked': 'waiting for Allow',
  'error': 'could not be read',
};

let ui = null;
let busy = false;

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
  const perm = await rootsPermission();
  if (perm === 'granted') return render(await syncSources());
  return render({ permission: perm, sources: [] });
}

function setStatus(text) { ui.$status.textContent = text; }
function showError(msg) {
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}
function show(el, on) { el.hidden = !on; }

async function render({ permission, sources }) {
  const roots = await getRoots();
  show(ui.$connect, permission === 'none' || permission === 'denied');
  show(ui.$allow, permission === 'prompt');
  show(ui.$add, permission !== 'none');
  show(ui.$forget, permission !== 'none');

  ui.$folders.textContent = roots.length
    ? `Connected folder${roots.length === 1 ? '' : 's'}: ${roots.map((r) => r.name).join(', ')}`
    : '';

  ui.$list.textContent = '';
  for (const s of sources) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'font-medium';
    name.textContent = s.label;
    li.append(name, ` — ${STATUS_TEXT[s.status] || s.status}`);
    if (s.message) li.append(`: ${s.message}`);
    if (s.status === 'not-shared' || s.status === 'error') li.className = 'text-neutral-500';
    ui.$list.appendChild(li);
  }

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
}
