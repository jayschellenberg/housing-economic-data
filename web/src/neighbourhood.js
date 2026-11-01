/*
 * Neighbourhood (Experimental) tab — pre-written neighbourhood and community
 * narratives in two layers:
 *   - Winnipeg: neighbourhood cluster (overview) → neighbourhood
 *   - Manitoba municipality (overview) → community (Blumenort, Kleefeld …)
 *
 * NO DATA SHIPS WITH THE SITE. web/scripts/build-neighbourhood.mjs writes
 * neighbourhood.json to SharedInfo\AppMarketData\AppMarketData-Internal\
 * Neighbourhood; the viewer nominates the folder (neighbourhood-store.js).
 * Each write-up shows as one text box per section; "Save edits" writes the
 * changed sections back into the folder's edits/ subfolder, so everyone with
 * the folder sees the reviewed version.
 */

import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { sectionsOf, applyEdit, editStatus, editRecord, plainText, wordBlocks, areaGroups } from './neighbourhood-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getEdits, getManifest,
  clearNeighbourhood, saveEdit, removeEdit,
} from './neighbourhood-store.js';
import { onSourcesUpdated } from './market-data-channel.js';

const PREF_KEY = 'neighbourhood.v1';
const OVERVIEW = '';

let ui = null;

function loadPrefs() {
  const p = getPref(PREF_KEY);
  return p && typeof p === 'object' ? p : {};
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  setPref(PREF_KEY, next);
  return next;
}

export async function initNeighbourhood() {
  const $status = document.getElementById('nb-folder-status');
  const $main = document.getElementById('nb-content');
  if (!$status || !$main) return;
  ui = {
    $status, $main,
    $error: document.getElementById('nb-folder-error'),
    $pick: document.getElementById('nb-pick-folder'),
    $pickFallback: document.getElementById('nb-pick-fallback'),
    $rescan: document.getElementById('nb-rescan'),
    $clear: document.getElementById('nb-clear'),
    $folderToggle: document.getElementById('nb-folder-toggle'),
    $folderBody: document.getElementById('nb-folder-body'),
    $area: document.getElementById('nb-area'),
    $item: document.getElementById('nb-item'),
    $initials: document.getElementById('nb-initials'),
    $empty: document.getElementById('nb-empty'),
    data: null,
    edits: {},
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the neighbourhood data locally (IndexedDB is unavailable).');
    return;
  }
  wireControls();
  await loadFromStore();
  onSourcesUpdated(['neighbourhood'], async () => { await loadFromStore(); await maybeAutoRefresh(); });
  await maybeAutoRefresh();
}

function showError(msg) {
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}
function setStatus(text) { ui.$status.textContent = text; }

// --- Folder ------------------------------------------------------------------

function wireControls() {
  const { $pick, $pickFallback, $rescan, $clear } = ui;
  if (fsAccessSupported()) {
    $pick.hidden = false; $pickFallback.hidden = true;
    $pick.addEventListener('click', async () => {
      showError('');
      try { await runImport(await pickDirectory(), { force: true }); }
      catch (err) { if (err?.name !== 'AbortError') showError(err?.message || String(err)); }
    });
    $rescan.addEventListener('click', async () => {
      showError('');
      const handle = await getSavedDirectory();
      if (!handle) { showError('No folder is saved yet — choose the Neighbourhood folder first.'); return; }
      if ((await directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle, { force: true }); } catch (err) { showError(err?.message || String(err)); }
    });
  } else {
    $pick.hidden = true; $pickFallback.hidden = false; $rescan.hidden = true;
    $pickFallback.addEventListener('change', async () => {
      showError('');
      try {
        setStatus('Reading…');
        const summary = await importFromFileList($pickFallback.files);
        await loadFromStore();
        setStatus(summaryText(summary));
      } catch (err) { showError(err?.message || String(err)); }
      finally { $pickFallback.value = ''; }
    });
  }
  $clear.addEventListener('click', async () => {
    await clearNeighbourhood();
    ui.data = null; ui.edits = {};
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  ui.$area.addEventListener('change', () => {
    ui.prefs = savePrefs({ area: ui.$area.value, item: OVERVIEW });
    renderItemPicker(); renderContent();
  });
  ui.$item.addEventListener('change', () => {
    ui.prefs = savePrefs({ item: ui.$item.value });
    renderContent();
  });
  ui.$initials.value = ui.prefs.initials || '';
  ui.$initials.addEventListener('change', () => { ui.prefs = savePrefs({ initials: ui.$initials.value.trim() }); });
}

async function runImport(handle, { force = false } = {}) {
  setStatus('Reading folder…');
  const summary = await importFromDirectory(handle, { force });
  await loadFromStore();
  setStatus(summaryText(summary));
}

function summaryText(s) {
  if (!s) return noDataText();
  const when = s.imported_at ? new Date(s.imported_at).toLocaleString('en-CA') : '';
  return `${s.areas} areas, ${s.items} neighbourhoods and communities, ${s.edits} saved edits, read ${when.replace(/\.$/, '')}. ` +
    (s.no_handle ? 'Held in this browser only; re-pick the folder to load an update. Saving edits needs Chrome or Edge.'
                 : 'Held in this browser only; the folder is re-checked each visit.');
}
function noDataText() {
  return 'No neighbourhood data is published with this site. Choose the shared Neighbourhood folder ' +
    '(AppMarketData-Internal\\Neighbourhood). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.edits = await getEdits();
  ui.$clear.hidden = !ui.data;
  setStatus(ui.data ? summaryText(await getManifest()) : noDataText());
  renderAll();
}

async function maybeAutoRefresh() {
  if (!fsAccessSupported()) return;
  const handle = await getSavedDirectory();
  if (!handle) return;
  const perm = await directoryPermission(handle);
  if (perm === 'granted') {
    // Edits change more often than the main file: always re-read them.
    const upd = await checkForUpdates(handle);
    try { await runImport(handle, { force: false }); if (upd?.changed) renderAll(); }
    catch (err) { showError(err?.message || String(err)); }
    return;
  }
  if (perm === 'prompt') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs underline text-accent-600 ml-1';
    btn.textContent = ui.data ? 'Check the saved folder for updates and edits' : 'Re-open the saved folder';
    btn.addEventListener('click', async () => {
      btn.remove();
      if ((await directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); }
    });
    ui.$status.appendChild(btn);
  }
}

// --- Selection ---------------------------------------------------------------

const groups = () => ui.data?.groups || [];
const currentArea = () => groups().find(g => g.id === ui.$area.value) || null;
const currentItem = () => currentArea()?.items.find(i => i.id === ui.$item.value) || null;
const mark = (id) => (ui.edits[id] ? ' ✎' : '');

function renderAll() {
  renderFolderBody();
  renderAreaPicker();
  renderItemPicker();
  renderContent();
}

function renderFolderBody() {
  const collapsible = !!ui.data;
  const collapsed = collapsible && !!ui.prefs.folderCollapsed;
  ui.$folderToggle.hidden = !collapsible;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
  ui.$folderBody.hidden = collapsed;
}

function renderAreaPicker() {
  const opt = (g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}${g.items.length ? ` (${g.items.length})` : ''}${mark(g.id)}</option>`;
  ui.$area.innerHTML = areaGroups(ui.data).map(grp =>
    `<optgroup label="${escapeHtml(grp.label)}">${grp.areas.map(opt).join('')}</optgroup>`).join('');
  ui.$area.disabled = !groups().length;
  if (groups().some(g => g.id === ui.prefs.area)) ui.$area.value = ui.prefs.area;
}

function renderItemPicker() {
  const a = currentArea();
  const items = a?.items || [];
  const noun = a?.kind === 'wpg' ? 'neighbourhood' : 'community';
  ui.$item.innerHTML = `<option value="${OVERVIEW}">${items.length ? `Overview only — choose a ${noun}` : 'Overview only'}</option>` +
    items.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}${mark(i.id)}</option>`).join('');
  ui.$item.disabled = !items.length;
  ui.$item.value = items.some(i => i.id === ui.prefs.item) ? ui.prefs.item : OVERVIEW;
}

// --- Write-up cards ------------------------------------------------------------

function renderContent() {
  ui.$empty.hidden = !!ui.data;
  ui.$main.innerHTML = '';
  const a = currentArea();
  if (!a) return;
  const item = currentItem();
  // The focus write-up first when one is chosen; the area overview under it.
  if (item) ui.$main.appendChild(card({ id: item.id, title: item.name, blocks: item.blocks, flags: item.flags, tables: item.tables,
    sub: `${a.kind === 'wpg' ? 'Neighbourhood' : 'Community'} in ${a.name}` }));
  ui.$main.appendChild(card({ id: a.id, title: a.name, blocks: a.overview.blocks, tables: a.overview.tables,
    sub: a.kind === 'wpg' ? 'Neighbourhood cluster overview' : 'Municipality overview' }));
}

const STATUS = {
  generated: ['bg-neutral-100 text-neutral-700', 'Generated — not yet reviewed'],
  edited: ['bg-green-100 text-green-800', 'Reviewed'],
  stale: ['bg-amber-100 text-amber-800', 'Reviewed — but the generated text has changed since'],
};

function card({ id, title, sub, blocks, flags = [], tables = [] }) {
  const meta = blocks.find(b => b.type === 'meta')?.text || '';
  const applied = applyEdit(sectionsOf(blocks), ui.edits[id]);
  const edit = ui.edits[id];
  const status = editStatus(applied);
  const [cls, label] = STATUS[status];
  const $card = document.createElement('section');
  $card.className = 'chart-card cmhc-indicator-card';
  $card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(sub)}${meta ? ` · ${escapeHtml(meta)}` : ''}</p>
    <p class="text-sm my-1"><span class="inline-block rounded px-2 py-0.5 text-xs font-semibold ${cls}">${escapeHtml(label)}</span>
      ${edit ? `<span class="text-xs text-neutral-500 ml-1">saved ${escapeHtml(new Date(edit.editedAt).toLocaleDateString('en-CA'))}${edit.by ? ` by ${escapeHtml(edit.by)}` : ''}</span>` : ''}</p>
    ${flags.map(f => `<div class="text-sm my-2 rounded border-2 border-red-500 bg-red-50 text-red-900 px-3 py-2" role="alert">
      <p class="font-bold uppercase tracking-wide">⚠ Verify</p><p class="mt-1">${escapeHtml(f)}</p></div>`).join('')}
    ${applied.map((s, i) => `
      <label class="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mt-3 mb-1" for="nb-s-${i}-${escapeHtml(id)}">${escapeHtml(s.heading)}${s.stale ? ' <span class="normal-case text-amber-700">(generated text changed — compare)</span>' : ''}</label>
      <textarea id="nb-s-${i}-${escapeHtml(id)}" data-i="${i}" rows="2"
        class="w-full resize-y overflow-hidden border ${s.edited ? 'border-green-400' : 'border-neutral-300'} rounded p-2 text-sm leading-relaxed font-serif">${escapeHtml(s.text)}</textarea>
      ${s.stale ? `<details class="text-xs text-neutral-600"><summary>Current generated text</summary><p class="mt-1 font-serif whitespace-pre-line">${escapeHtml(s.generated)}</p></details>` : ''}`).join('')}
    <p class="text-xs text-neutral-500 mt-1" data-role="dirty" hidden>Unsaved changes.</p>
    <div class="chart-actions">
      <button type="button" data-role="save">Save edits</button>
      ${edit ? '<button type="button" data-role="revert">Revert to generated</button>' : ''}
      <button type="button" data-role="copy">Copy text</button>
      <button type="button" data-role="docx">Download Word</button>
    </div>
    ${tables.length ? `<details class="mt-3"><summary class="text-sm cursor-pointer">Supporting figures</summary>${tables.map(tableHtml).join('')}</details>` : ''}`;

  const $areas = [...$card.querySelectorAll('textarea')];
  const current = () => $areas.map(t => t.value);
  const sectionsNow = () => applied.map((s, i) => ({ heading: s.heading, text: $areas[i].value.trim() }));
  // Each box grows to its text (after the card is in the page, so it has a width).
  const fit = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };
  requestAnimationFrame(() => $areas.forEach(fit));
  $areas.forEach(t => t.addEventListener('input', () => { fit(t); $card.querySelector('[data-role="dirty"]').hidden = false; }));

  const $save = $card.querySelector('[data-role="save"]');
  $save.addEventListener('click', async () => {
    showError('');
    const rec = editRecord(id, title, applied, current(), ui.$initials.value || ui.prefs.initials);
    try {
      $save.textContent = 'Saving…';
      if (rec) await saveEdit(rec); else if (edit) await removeEdit(id);
      ui.edits = await getEdits();
      renderAreaPicker(); renderItemPicker(); renderContent();
    } catch (err) {
      $save.textContent = 'Save edits';
      showError(err?.message || String(err));
    }
  });
  $card.querySelector('[data-role="revert"]')?.addEventListener('click', async () => {
    if (!window.confirm(`Discard the saved edits for ${title} and show the generated text again? Everyone using the folder will see the change.`)) return;
    showError('');
    try {
      await removeEdit(id);
      ui.edits = await getEdits();
      renderAreaPicker(); renderItemPicker(); renderContent();
    } catch (err) { showError(err?.message || String(err)); }
  });
  const $copy = $card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(plainText(title, sectionsNow())); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy text'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  $card.querySelector('[data-role="docx"]').addEventListener('click', async () => {
    try {
      const { exportNarrativeToWord } = await import('./word-export.js');
      const safe = title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      await exportNarrativeToWord(wordBlocks(title, sectionsNow()), {
        filename: `Neighbourhood_${safe}_${new Date().toISOString().slice(0, 10)}.docx`,
        description: `${title} — ${sub}`,
      });
    } catch (err) {
      console.error('[neighbourhood word]', err);
      showError('Word export failed: ' + (err?.message || err));
    }
  });
  return $card;
}

function tableHtml(tbl) {
  return `
    <div class="cmhc-table-title mt-3">${escapeHtml(tbl.title)}</div>
    <div class="cmhc-chart-table-scroll"><table class="cmhc-table cmhc-table-compact">
      <thead><tr><th></th>${tbl.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>${tbl.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}
