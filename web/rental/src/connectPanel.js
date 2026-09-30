/*
 * connectPanel.js — the "Rental data" panel: choose folder, reload,
 * disconnect, update notice. Its only contract with the rest of the app
 * is onBundle(bundle | null): called with the parsed bundle whenever the
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
      $status.textContent = 'Not connected';
      $empty.hidden = false;
      $ready.hidden = true;
      setOpen(true);
      $hint.textContent = fsAccessSupported()
        ? ''
        : 'This browser cannot remember the folder — re-import after each weekly publish.';
      onBundle?.(null);
      return info;
    }
    let bundle = null;
    try {
      bundle = await loadBundle();
    } catch (err) {
      $status.textContent = 'Needs reload';
      $empty.hidden = true;
      $ready.hidden = false;
      $hint.textContent = err.message;
      onBundle?.(null);
      return info;
    }
    const m = bundle.manifest;
    const c = m.counts || {};
    $status.textContent = `${fmt(c.listings)} listings · published ${dateLabel(m.generated_at)}`;
    fact('Published', dateLabel(m.generated_at));
    fact('Imported', dateLabel(info.imported_at));
    fact('Listings', `${fmt(c.listings)} in scope · ${fmt(c.active)} active`);
    fact('History', `${fmt(c.segments)} rent runs from ${m.observed?.first || '?'} to ${m.observed?.last || '?'}`);
    fact('Health', m.health === 'degraded'
      ? `degraded — ${(m.degraded_sources || []).join(', ')}`
      : (m.health || 'unknown'));
    fact('Archived pages', info.evidence
      ? `${fmt(c.with_evidence)} listings — click 📄 in the table`
      : info.layout === 'export'
        ? 'not reachable — reconnect the RentalDashboard folder (parent of export)'
        : 'not available in this browser');
    $empty.hidden = true;
    $ready.hidden = false;
    $hint.textContent = info.auto_refresh
      ? 'Updates are detected when you open this page; click Reload to import them.'
      : 'This browser cannot remember the folder — re-import after each weekly publish.';
    setOpen(false);
    onBundle?.(bundle);
    return info;
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
    say(`Rental data ready in ${secs}s`
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
      say('Rental data ready. This browser cannot auto-detect updates — re-import after each publish.');
    } catch (err) {
      say(`Import failed: ${err.message}`);
    } finally { $folder.value = ''; }
  });

  $reload?.addEventListener('click', async () => {
    try {
      const handle = await getSavedDirectory();
      if (!handle) {
        say('No folder remembered — choose the export folder again.');
        await onChooseFolder();
        return;
      }
      const perm = await directoryPermission(handle, { request: true });
      if (perm !== 'granted') { say('Folder access was not granted.'); return; }
      await runImport(handle, { force: true });
    } catch (err) { say(`Reload failed: ${err.message}`); }
  });

  $forget?.addEventListener('click', async () => {
    const ok = window.confirm('Disconnect the rental data from this browser? '
      + 'The export folder on disk is not affected — you can reconnect it any time.');
    if (!ok) return;
    await clearAll();
    await render();
    say('Rental data disconnected from this browser.');
  });

  $connect?.addEventListener('click', onChooseFolder);

  // On load, if a granted handle is still held, quietly check whether the
  // export moved on. Not automatic: swapping data mid-analysis is worse
  // than a notice. We offer, the user decides.
  async function checkQuietly() {
    try {
      const handle = await getSavedDirectory();
      if (!handle) return;
      const upd = await checkForUpdates(handle);   // null when not granted
      if (!upd || !upd.count) return;
      if ($update) {
        $update.hidden = false;
        $update.textContent = 'Newer data has been published — click Reload.';
      }
    } catch { /* never block the page on this */ }
  }

  render().then((info) => { if (info?.present) checkQuietly(); });

  return { refresh: render };
}
