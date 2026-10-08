/*
 * Zoning tab — appraisal-report zoning narratives for Manitoba municipalities,
 * generated from by-laws parsed into structured tables (zoning-narrative project).
 *
 * NO ZONING DATA SHIPS WITH THE SITE. R/export.R in the zoning-narrative project
 * writes zoning.json (reviewed municipalities only) to
 * SharedInfo\AppMarketData\Zoning; access is whoever that folder is shared with.
 * The user nominates the folder here and the browser reads it locally
 * (zoning-store.js).
 *
 * Per zone: a currency badge (live check of the by-law number against the
 * Manitoba Zoning By-Laws open-data layer), the narrative (intent, a
 * permitted-uses sentence built from the ticked uses, bulk requirements) in an
 * editable box with Copy / Word, then the full use lists and bulk table with
 * the PDF page each figure came from.
 */

import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import {
  nameableUses, narrativeParagraphs, bulkRows, formatValue, ATTRIBUTE_LABELS,
  currencyVerdict, currencyMessage, currencyQueryUrl, zoneShortName, zoneDescription,
} from './zoning-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearZoning,
} from './zoning-store.js';

const PREF_KEY = 'zoning.v1';
const CURRENCY_TIMEOUT_MS = 8000;

let ui = null;
const liveCurrency = new Map();   // muni id -> { status, inForce, newAmendments, checked } | 'pending'

function loadPrefs() {
  const p = getPref(PREF_KEY);
  return p && typeof p === 'object' ? p : {};
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  setPref(PREF_KEY, next);
  return next;
}

export async function initZoning() {
  const $status = document.getElementById('zn-folder-status');
  const $main = document.getElementById('zn-content');
  if (!$status || !$main) return;
  ui = {
    $status, $main,
    $error: document.getElementById('zn-folder-error'),
    $pick: document.getElementById('zn-pick-folder'),
    $pickFallback: document.getElementById('zn-pick-fallback'),
    $rescan: document.getElementById('zn-rescan'),
    $clear: document.getElementById('zn-clear'),
    $folderToggle: document.getElementById('zn-folder-toggle'),
    $folderBody: document.getElementById('zn-folder-body'),
    $muni: document.getElementById('zn-muni'),
    $zone: document.getElementById('zn-zone'),
    $uses: document.getElementById('zn-use-toggles'),
    $usesCount: document.getElementById('zn-use-count'),
    $empty: document.getElementById('zn-empty'),
    data: null,
    prefs: loadPrefs(),
    edited: false,
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the zoning data locally (IndexedDB is unavailable).');
    return;
  }
  wireControls();
  await loadFromStore();
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
      if (!handle) { showError('No folder is saved yet — choose the Zoning folder first.'); return; }
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
    await clearZoning();
    ui.data = null;
    liveCurrency.clear();
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  ui.$muni.addEventListener('change', () => {
    ui.prefs = savePrefs({ muni: ui.$muni.value, zone: null });
    renderZonePicker(); renderZone();
  });
  ui.$zone.addEventListener('change', () => {
    ui.prefs = savePrefs({ zone: ui.$zone.value });
    renderZone();
  });
  document.getElementById('zn-use-default').addEventListener('click', () => setSelected(null));
  document.getElementById('zn-use-none').addEventListener('click', () => setSelected([]));
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
  return `${s.municipalities} municipalities, ${s.zones} zones, read ${when}. ` +
    (s.no_handle ? 'Held in this browser only; re-pick the folder to load an update.'
                 : 'Held in this browser only; the folder is re-checked each visit.');
}
function noDataText() {
  return 'No zoning data is published with this site. Choose the shared Zoning folder ' +
    '(AppMarketData\\Zoning). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
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
    const upd = await checkForUpdates(handle);
    if (upd?.changed) { try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); } }
    return;
  }
  if (perm === 'prompt') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs underline text-accent-600 ml-1';
    btn.textContent = ui.data ? 'Check the saved folder for an update' : 'Re-open the saved folder';
    btn.addEventListener('click', async () => {
      btn.remove();
      if ((await directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); }
    });
    ui.$status.appendChild(btn);
  }
}

// --- Selection ---------------------------------------------------------------

const munis = () => ui.data?.municipalities || [];
const currentMuni = () => munis().find(m => m.id === ui.$muni.value) || null;
const currentZone = () => currentMuni()?.zones.find(z => z.code === ui.$zone.value) || null;
const selKey = () => `${ui.$muni.value}|${ui.$zone.value}`;

/** Ticked uses for the current zone: saved per zone, else the export's default top uses. */
function selectedUses() {
  const z = currentZone();
  if (!z) return [];
  const saved = ui.prefs.selected?.[selKey()];
  return Array.isArray(saved) ? saved : (z.default_uses || []);
}
function setSelected(list) {
  const sel = { ...(ui.prefs.selected || {}) };
  if (list == null) delete sel[selKey()]; else sel[selKey()] = list;
  ui.prefs = savePrefs({ selected: sel });
  // A hand-edited narrative is kept; "Regenerate" applies the new selection.
  renderUseToggles(); renderNarrative();
}

// --- Rendering ---------------------------------------------------------------

function renderAll() {
  renderFolderBody();
  renderMuniPicker();
  renderZonePicker();
  renderZone();
}

function renderFolderBody() {
  const collapsible = !!ui.data;
  const collapsed = collapsible && !!ui.prefs.folderCollapsed;
  ui.$folderToggle.hidden = !collapsible;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
  ui.$folderBody.hidden = collapsed;
}

function renderMuniPicker() {
  const list = [...munis()].sort((a, b) => a.label.localeCompare(b.label));
  ui.$muni.innerHTML = list.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
  ui.$muni.disabled = !list.length;
  if (list.some(m => m.id === ui.prefs.muni)) ui.$muni.value = ui.prefs.muni;
}

function renderZonePicker() {
  const m = currentMuni();
  // alphabetical by code; numeric parts compare as numbers (RG, RG-1, RG-2; M1, M2)
  const zones = [...(m?.zones || [])].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  ui.$zone.innerHTML = zones.map(z => `<option value="${escapeHtml(z.code)}">${escapeHtml(`${z.code} – ${z.name}`)}</option>`).join('');
  ui.$zone.disabled = !zones.length;
  if (zones.some(z => z.code === ui.prefs.zone)) ui.$zone.value = ui.prefs.zone;
}

function renderUseToggles() {
  const z = currentZone();
  if (!z) { ui.$uses.innerHTML = ''; ui.$usesCount.textContent = ''; return; }
  const sel = new Set(selectedUses());
  const pool = [...nameableUses(z)].sort((a, b) => a.name.localeCompare(b.name));
  ui.$uses.innerHTML = pool.map((u, i) => `
    <label class="flex items-start gap-2"><input type="checkbox" data-i="${i}" ${sel.has(u.name) ? 'checked' : ''} class="mt-0.5">
      <span>${escapeHtml(u.name)}</span></label>`).join('');
  ui.$uses.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
    const names = [...ui.$uses.querySelectorAll('input:checked')].map(x => pool[Number(x.dataset.i)].name);
    setSelected(names);
  }));
  ui.$usesCount.textContent = `${sel.size} of ${pool.length} named`;
}

function renderZone() {
  const z = currentZone();
  ui.$empty.hidden = !!ui.data;
  ui.$main.innerHTML = '';
  ui.edited = false;
  renderUseToggles();
  if (!z) return;
  const m = currentMuni();
  ui.$main.innerHTML = `
    <section class="chart-card cmhc-indicator-card" data-role="currency">
      <header class="chart-title">${escapeHtml(m.label)} — Zoning By-law ${escapeHtml(m.bylaw_no)}</header>
      <p class="chart-sub">${escapeHtml(`'${z.code}' ${z.name}`)}${m.consolidated_to ? ` · consolidated to ${escapeHtml(m.consolidated_to)}` : ''}</p>
      <p class="text-sm" data-role="currency-text"></p>
    </section>
    <section class="chart-card cmhc-indicator-card" data-role="designation">
      <header class="chart-title">Zoning designation</header>
      <p class="chart-sub">Short name and description from the by-law's intent clause. Edit before copying if needed.</p>
      <label class="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mt-2 mb-1" for="zn-short-name">Zoning short name</label>
      <div class="flex gap-2 items-start">
        <input id="zn-short-name" type="text" data-role="short" class="flex-1 border border-neutral-300 rounded px-2 py-1 text-sm font-serif" value="${escapeHtml(zoneShortName(z))}">
        <button type="button" data-copy="short" class="text-xs border border-neutral-300 rounded px-2 py-1 bg-white hover:bg-neutral-50">Copy</button>
      </div>
      <label class="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mt-3 mb-1" for="zn-description">Zoning description</label>
      <div class="flex gap-2 items-start">
        <textarea id="zn-description" rows="3" data-role="desc" class="flex-1 border border-neutral-300 rounded px-2 py-1 text-sm leading-relaxed font-serif">${escapeHtml(zoneDescription(z))}</textarea>
        <button type="button" data-copy="desc" class="text-xs border border-neutral-300 rounded px-2 py-1 bg-white hover:bg-neutral-50">Copy</button>
      </div>
      <p class="text-xs text-neutral-400 mt-1">Intent clause: PDF page ${z.intent_page ?? '—'}.</p>
    </section>
    <section class="chart-card cmhc-indicator-card" data-role="narrative">
      <header class="chart-title">Zoning narrative</header>
      <p class="chart-sub">Ticking uses in the sidebar rewrites the permitted-uses sentence. Edit freely before copying.</p>
      <textarea data-role="text" rows="12" class="w-full border border-neutral-300 rounded p-2 text-sm leading-relaxed font-serif"></textarea>
      <p class="text-xs text-neutral-500" data-role="edited-note" hidden>Edited by hand — use selections no longer update the text. <button type="button" class="underline" data-role="regen">Regenerate</button></p>
      <div class="chart-actions">
        <button type="button" data-role="copy">Copy text</button>
        <button type="button" data-role="docx">Download Word</button>
      </div>
    </section>
    <section class="chart-card cmhc-indicator-card" data-role="uses"></section>
    <section class="chart-card cmhc-indicator-card" data-role="bulk"></section>`;
  wireDesignation();
  wireNarrative();
  renderNarrative();
  renderUseTables(z);
  renderBulkTable(z);
  renderCurrency(m);
}

function wireDesignation() {
  const $card = ui.$main.querySelector('[data-role="designation"]');
  $card.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const $field = $card.querySelector(`[data-role="${btn.dataset.copy}"]`);
    try { await navigator.clipboard.writeText($field.value.trim()); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    catch { btn.textContent = 'Copy failed'; }
  }));
}

function wireNarrative() {
  const $card = ui.$main.querySelector('[data-role="narrative"]');
  const $text = $card.querySelector('[data-role="text"]');
  const $note = $card.querySelector('[data-role="edited-note"]');
  $text.addEventListener('input', () => { ui.edited = true; $note.hidden = false; });
  $card.querySelector('[data-role="regen"]').addEventListener('click', () => { ui.edited = false; $note.hidden = true; renderNarrative(); });
  const $copy = $card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($text.value); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy text'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  $card.querySelector('[data-role="docx"]').addEventListener('click', () => exportWord($text.value).catch(err => {
    console.error('[zoning word]', err);
    showError('Word export failed: ' + (err?.message || err));
  }));
}

function renderNarrative() {
  const z = currentZone();
  const $text = ui.$main.querySelector('[data-role="narrative"] [data-role="text"]');
  if (!z || !$text || ui.edited) return;
  $text.value = narrativeParagraphs(z, selectedUses()).join('\n\n');
}

function useList(list) {
  if (!list.length) return '<p class="text-sm text-neutral-500">None.</p>';
  return `<ul class="text-sm grid gap-0.5 sm:grid-cols-2">${list.map(u => {
    const tags = [u.qualifier === 'accessory_only' ? 'accessory only' : u.qualifier, u.note].filter(Boolean).join('; ');
    return `<li>${escapeHtml(u.name)}${tags ? ` <span class="text-neutral-500">(${escapeHtml(tags)})</span>` : ''} <span class="text-neutral-400 text-xs">p.${u.page}</span></li>`;
  }).join('')}</ul>`;
}

function renderUseTables(z) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const p = z.uses.filter(u => u.status === 'P').sort(byName);
  const c = z.uses.filter(u => u.status === 'C').sort(byName);
  ui.$main.querySelector('[data-role="uses"]').innerHTML = `
    <header class="chart-title">Permitted and conditional uses</header>
    <p class="chart-sub">As listed in the by-law, with the PDF page. Not-permitted uses are not shown.</p>
    <h3 class="text-sm font-semibold mt-2 mb-1">Permitted (${p.length})</h3>${useList(p)}
    <h3 class="text-sm font-semibold mt-3 mb-1">Conditional (${c.length})</h3>${useList(c)}`;
}

function renderBulkTable(z) {
  const rows = bulkRows(z);
  const body = rows.map(r => `<tr>
      <td>${escapeHtml(r.qualifier || 'all listed uses')}</td>
      <td>${escapeHtml(ATTRIBUTE_LABELS[r.attribute] || r.attribute)}</td>
      <td>${escapeHtml(formatValue(r))}</td>
      <td>${escapeHtml(r.note || '')}</td>
      <td>${r.page ?? ''}</td></tr>`).join('');
  const $card = ui.$main.querySelector('[data-role="bulk"]');
  $card.innerHTML = `
    <header class="chart-title">Bulk requirements</header>
    <p class="chart-sub">Principal building. Figures as printed in the by-law (imperial first), with notes and the PDF page.</p>
    <div class="cmhc-chart-table-scroll">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>
        <th>Applies to</th><th>Requirement</th><th>Value</th><th>Note</th><th>Page</th>
      </tr></thead><tbody>${body || '<tr><td colspan="5">No bulk requirements recorded.</td></tr>'}</tbody></table>
    </div>
    <div class="chart-actions"><button type="button" data-role="copy">Copy table</button></div>`;
  const tsv = [['Applies to', 'Requirement', 'Value', 'Note', 'Page'].join('\t'),
    ...rows.map(r => [r.qualifier || 'all listed uses', ATTRIBUTE_LABELS[r.attribute] || r.attribute,
      formatValue(r), r.note || '', r.page ?? ''].join('\t'))].join('\n');
  const $copy = $card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
}

// --- Currency ----------------------------------------------------------------

const BADGE = {
  current: ['bg-green-100 text-green-800', 'In force'],
  amended: ['bg-amber-100 text-amber-800', 'Amended since consolidation'],
  stale: ['bg-red-100 text-red-800', 'STALE — newer by-law in force'],
  unverified: ['bg-neutral-100 text-neutral-700', 'Not verified'],
};

function paintCurrency(m, v, { live }) {
  const $t = ui.$main.querySelector('[data-role="currency-text"]');
  if (!$t || currentMuni()?.id !== m.id) return;
  const [cls, label] = BADGE[v.status] || BADGE.unverified;
  const src = live ? 'live check' : `as exported${v.checked ? ` ${v.checked}` : ''}; live check unavailable`;
  $t.innerHTML = `<span class="inline-block rounded px-2 py-0.5 text-xs font-semibold ${cls}">${escapeHtml(label)}</span>
    <span class="text-xs text-neutral-500 ml-1">(${escapeHtml(src)})</span><br>${escapeHtml(currencyMessage(m, v, v.checked))}`;
}

async function renderCurrency(m) {
  const cached = liveCurrency.get(m.id);
  if (cached && cached !== 'pending') { paintCurrency(m, cached, { live: true }); return; }
  // Until the live answer arrives (or if it never does), show the export-time verdict.
  const exported = m.currency
    ? { status: m.currency.status, inForce: [m.currency.zbl_in_force], newAmendments: m.currency.new_amendments || [], checked: m.currency.checked }
    : { status: 'unverified', inForce: [], newAmendments: [] };
  paintCurrency(m, exported, { live: false });
  if (cached === 'pending' || !ui.data?.currency_service || !m.muni_no) return;
  liveCurrency.set(m.id, 'pending');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CURRENCY_TIMEOUT_MS);
    const res = await fetch(currencyQueryUrl(ui.data.currency_service, m.muni_no), { signal: ctl.signal });
    clearTimeout(t);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
    const v = { ...currencyVerdict(m, json.features), checked: new Date().toISOString().slice(0, 10) };
    liveCurrency.set(m.id, v);
    paintCurrency(m, v, { live: true });
  } catch (err) {
    console.warn('[zoning currency]', err);
    liveCurrency.delete(m.id);
  }
}

// --- Word --------------------------------------------------------------------

async function exportWord(text) {
  const m = currentMuni(); const z = currentZone();
  if (!m || !z) return;
  const v = liveCurrency.get(m.id);
  const verdict = v && v !== 'pending' ? v : null;
  const { exportNarrativeToWord } = await import('./word-export.js');
  const blocks = [
    { type: 'heading', text: 'Zoning' },
    ...text.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean).map(t => ({ type: 'para', text: t })),
  ];
  if (verdict) blocks.push({ type: 'meta', text: `Reviewer note (not for the report): ${currencyMessage(m, verdict, verdict.checked)}` });
  const safe = `${m.id}_${z.code}`.replace(/[^A-Za-z0-9_-]/g, '');
  await exportNarrativeToWord(blocks, {
    filename: `zoning_${safe}_${new Date().toISOString().slice(0, 10)}.docx`,
    description: `${m.label} Zoning By-law ${m.bylaw_no} — '${z.code}' ${z.name}`,
  });
}
