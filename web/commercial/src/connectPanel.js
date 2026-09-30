/*
 * connectPanel.js — the "Data" panel: choose folder, reload, disconnect,
 * update notice. Before a folder is connected the panel is the connect
 * card on Summary; once data loads it moves to the top of Explore as a
 * one-line status with Reload a click away (Jason, 2026-09-28). Its only contract with the rest of the app is
 * onBundle(bundle | null): called with the parsed bundle whenever the
 * connected data changes, and with null when it is disconnected.
 */

import {
  dbAvailable, fsAccessSupported,
  pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates,
  describeImport, getBundleTexts, clearAll, requestPersistence,
} from './lib/store.js';
import { parseBundle } from './lib/bundle.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-CA');

/** '2026-09-14T13:56:51+00:00' → 'Sep 14, 2026' in local time. */
export function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** '2026-09' → 'September 2026'. Cycle months are the data's own clock. */
export function cycleLabel(ym) {
  if (!ym) return '—';
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym));
  if (!m) return String(ym);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' });
}

export function initConnectPanel({ onBundle, setStatus } = {}) {
  const $root = document.getElementById('data-panel');
  if (!$root) return { refresh: async () => {} };
  const $status = document.getElementById('data-status');
  const $empty = document.getElementById('data-empty');
  const $ready = document.getElementById('data-ready');
  const $facts = document.getElementById('data-facts');
  const $connect = document.getElementById('data-connect');
  const $folder = document.getElementById('data-folder-input');
  const $reload = document.getElementById('data-reload');
  const $forget = document.getElementById('data-forget');
  const $update = document.getElementById('data-update');
  const $hint = document.getElementById('data-hint');
  const $summaryHome = $root.parentElement;
  const $exploreHome = document.getElementById('explore');

  /** Connected: first thing on Explore. Otherwise: the connect card on Summary. */
  function placePanel(connected) {
    const home = connected && $exploreHome ? $exploreHome : $summaryHome;
    if ($root.parentElement !== home) home.prepend($root);
  }

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  if (!dbAvailable()) {
    $status.textContent = 'Unavailable in this browser';
    $empty.hidden = true;
    return { refresh: async () => {} };
  }

  // The panel folds to its title once data is connected; only ever as a
  // default — once the user works the disclosure by hand we stop touching it.
  let touched = false;
  $root.addEventListener('toggle', () => { touched = true; });
  const setOpen = (open) => { if (!touched) $root.open = open; };

  function fact(dt, dd) {
    const a = document.createElement('dt'); a.textContent = dt;
    const b = document.createElement('dd'); b.textContent = dd;
    $facts.append(a, b);
  }

  /** Parse what IndexedDB holds and hand it up. Null when nothing usable. */
  async function loadBundle() {
    const texts = await getBundleTexts();
    if (!texts) return null;
    return parseBundle(texts);
  }

  async function render() {
    const info = await describeImport();
    $facts.textContent = '';
    if (!info.present) {
      placePanel(false);
      $status.textContent = 'Not connected';
      $empty.hidden = false;
      $ready.hidden = true;
      setOpen(true);
      $hint.textContent = fsAccessSupported()
        ? ''
        : 'This browser has no folder picker — use Chrome or Edge to connect the folder and open flyers.';
      onBundle?.(null);
      return info;
    }
    let bundle = null;
    try {
      bundle = await loadBundle();
    } catch (err) {
      placePanel(false);
      $status.textContent = 'Needs reload';
      $empty.hidden = true;
      $ready.hidden = false;
      $hint.textContent = err.message;
      onBundle?.(null);
      return info;
    }
    const m = bundle.manifest;
    const c = m.counts || {};
    $status.textContent = `${fmt(c.records)} records · published ${dateLabel(m.generated_at)}`;
    fact('Published', dateLabel(m.generated_at));
    fact('Imported', dateLabel(info.imported_at));
    fact('Records', `${fmt(c.records)} · ${fmt(c.on_market)} on market`);
    fact('Cycles', `${cycleLabel(m.cycles?.first)} – ${cycleLabel(m.cycles?.last)}`);
    fact('History', `${fmt(c.runs)} runs`);
    fact('Mapped', `${fmt(c.with_coords)} of ${fmt(c.records)} geocoded`);
    fact('Flyers', flyerFact(m, info, c));
    $empty.hidden = true;
    $ready.hidden = false;
    $hint.textContent = info.auto_refresh
      ? 'Opening this page checks for newer data (Chrome may ask to see the folder first); click Reload to import it.'
      : 'This browser cannot remember the folder — re-import after each publish.';
    setOpen(false);
    placePanel(true);
    onBundle?.(bundle);
    return info;
  }

  function flyerFact(m, info, c) {
    const present = m.flyers?.present ?? 0;
    if (!info.flyers) {
      return info.layout === 'export'
        ? 'not reachable — reconnect the folder that holds export\\'
        : 'not available in this browser';
    }
    if (!present) return 'this publish included none';
    return `${fmt(present)} PDFs · ${fmt(c.with_flyer)} records linked`;
  }

  // ---- import -------------------------------------------------------------
  async function runImport(dirHandle, { force = false } = {}) {
    const t0 = Date.now();
    say('Importing…');
    const summary = await importFromDirectory(dirHandle, {
      force,
      onProgress: ({ done, total, label }) => {
        if (done < total) say(`Importing… ${done + 1}/${total} — ${label}`);
      },
    });
    const p = await requestPersistence();
    await render();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`Data ready in ${secs}s`
      + (summary.skipped ? ` (${summary.skipped} file${summary.skipped === 1 ? '' : 's'} unchanged)` : '')
      + (p.supported && !p.persisted ? '. The browser may evict this under low disk.' : '.'));
    if ($update) $update.hidden = true;
    return summary;
  }

  async function onChooseFolder() {
    try {
      if (fsAccessSupported()) {
        const handle = await pickDirectory();      // needs the user gesture
        await runImport(handle);
      } else {
        $folder.click();                            // fallback picker
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;       // user cancelled
      say(`Import failed: ${err.message}`);
    }
  }

  $folder?.addEventListener('change', async () => {
    if (!$folder.files?.length) return;
    try {
      say('Importing…');
      await importFromFileList($folder.files);
      await requestPersistence();
      await render();
      say('Data ready. This browser cannot auto-detect updates — re-import after each publish.');
    } catch (err) {
      say(`Import failed: ${err.message}`);
    } finally { $folder.value = ''; }
  });

  async function reload() {
    try {
      const handle = await getSavedDirectory();
      if (!handle) {
        say('No folder remembered — choose the published folder again.');
        await onChooseFolder();
        return;
      }
      const perm = await directoryPermission(handle, { request: true });
      if (perm !== 'granted') { say('Folder access was not granted.'); return; }
      await runImport(handle, { force: true });
    } catch (err) { say(`Reload failed: ${err.message}`); }
  }
  $reload?.addEventListener('click', reload);

  $forget?.addEventListener('click', async () => {
    const ok = window.confirm('Disconnect this data from this browser? '
      + 'The Dropbox folder itself is not affected — you can reconnect it any time.');
    if (!ok) return;
    await clearAll();
    await render();
    say('Data disconnected from this browser.');
  });

  $connect?.addEventListener('click', onChooseFolder);

  // ---- update notice ------------------------------------------------------
  // Outside the tabs, so it reaches whoever is looking. Text plus at most
  // one button; built from nodes, never from HTML.
  let noticeTimer = null;
  function notice(text, action = null, { fade = 0 } = {}) {
    if (!$update) return;
    clearTimeout(noticeTimer);
    $update.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      $update.append(' ', b);
    }
    $update.hidden = false;
    if (fade) noticeTimer = setTimeout(() => { $update.hidden = true; }, fade);
  }
  const newer = () => notice('Newer data has been published.', { label: 'Reload', run: reload });

  // Chrome drops folder access when the tab closes (unless the user chose
  // "Allow on every visit"), and asking needs a click. So a fresh visit
  // can't look on its own — before 2026-09-28 it gave up silently and the
  // "newer data" notice almost never appeared. Now it offers the click.
  async function checkNow() {
    try {
      const handle = await getSavedDirectory();
      if (!handle) { notice('No folder remembered — choose the published folder again.', { label: 'Choose folder…', run: onChooseFolder }); return; }
      const perm = await directoryPermission(handle, { request: true });
      if (perm !== 'granted') {
        notice('Folder access was not granted, so nothing was checked.', { label: 'Try again', run: checkNow });
        return;
      }
      const upd = await checkForUpdates(handle);
      if (upd?.count) newer();
      else notice('You have the latest data.', null, { fade: 5000 });
    } catch (err) { notice(`Could not check the folder: ${err.message}`); }
  }

  // On load, look quietly if access is still held; otherwise offer the
  // check. Never automatic: swapping data mid-analysis is worse than a
  // notice. We offer, the user decides.
  async function checkQuietly() {
    try {
      const handle = await getSavedDirectory();
      if (!handle) return;
      if ((await directoryPermission(handle)) !== 'granted') {
        notice('Has anything been published since your last import?', { label: 'Check for new data', run: checkNow });
        return;
      }
      const upd = await checkForUpdates(handle);
      if (upd?.count) newer();
    } catch { /* never block the page on this */ }
  }

  render().then((info) => { if (info?.present) checkQuietly(); });

  return { refresh: render };
}
