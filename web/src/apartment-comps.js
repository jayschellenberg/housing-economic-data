/*
 * Apartment Income & Expenses tab — Winnipeg apartment comparables normalized
 * by income and expense category, filterable by date, year built, suites,
 * record type and utilities.
 *
 * NO DATA SHIPS WITH THE SITE. scripts/apartment_comps.py reads the
 * appraiser's comps database and the extracted listings / pro formas / CIMs
 * into apartment_comps.json in SharedInfo\AppMarketData\AppMarketData-Internal\ApartmentComps; the
 * user nominates that folder here and the browser reads it locally
 * (apartment-comps-store.js). The figures and summaries are worked out in
 * apartment-comps-data.js.
 *
 * Layout: the usual Local Data sidebar of filters, then an expense summary
 * (median, average, range, count per category for the filtered records) and
 * the records table. A row opens to show every category, the document's own
 * line labels, the database cell comments, the review note and the other
 * records of the same property.
 */

import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { fUsd, fPctFrac1, fInt } from './format.js';
import { loadWpgAddressIndex, lookupAddress } from './wpg-address.js';
import {
  INCOME_LABELS, EXPENSE_LABELS, COLUMNS, KIND_GROUPS, KIND_LABEL, PTYPE_LABELS, HEAT_LABELS,
  kindGroup, isProjected, heatGroup, catValue, columnValue, egiOf, totalExpenses, normalize,
  filterRecords, summarize, sameProperty, priceOf, sortRecords, expenseRatio,
  noiOf, capOf, egimOf, lookupAddressText, NO_CLUSTER,
} from './apartment-comps-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearApartmentComps,
} from './apartment-comps-store.js';
import { onSourcesUpdated } from './market-data-channel.js';

const PREF_KEY = 'aptcomps.v1';
const MISSING = '**';
const PAGE = 300;
const DEFAULT_KINDS = KIND_GROUPS.map(k => k.id);

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

const $ = (id) => document.getElementById(id);

// --- Init --------------------------------------------------------------------

export async function initApartmentComps() {
  const $status = $('ac-folder-status');
  if (!$status) return;
  ui = {
    $status,
    $error: $('ac-folder-error'),
    $pick: $('ac-pick-folder'), $pickFallback: $('ac-pick-fallback'),
    $rescan: $('ac-rescan'), $clear: $('ac-clear'),
    $folderToggle: $('ac-folder-toggle'), $folderBody: $('ac-folder-body'),
    $empty: $('ac-empty'), $about: $('ac-about'),
    $summaryWrap: $('ac-summary-wrap'), $summary: $('ac-summary'), $summaryNote: $('ac-summary-note'),
    $tableWrap: $('ac-table-wrap'), $table: $('ac-table'), $count: $('ac-count'),
    $kinds: $('ac-kinds'), $ptypes: $('ac-ptypes'),
    $clusters: $('ac-clusters'), $clusterMenu: $('ac-cluster-menu'), $clusterSummary: $('ac-cluster-summary'),
    $active: $('ac-active-filters'),
    data: null, records: [], open: new Set(), shown: PAGE,
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the comparables locally (IndexedDB is unavailable).');
    return;
  }
  wireFolder();
  wireFilters();
  await loadFromStore();
  onSourcesUpdated(['aptcomps'], async () => { await loadFromStore(); await maybeAutoRefresh(); });
  await maybeAutoRefresh();
}

function showError(msg) {
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}
function setStatus(text) { ui.$status.textContent = text; }

// --- Folder ------------------------------------------------------------------

function wireFolder() {
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
      if (!handle) { showError('No folder is saved yet — choose the ApartmentComps folder first.'); return; }
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
    await clearApartmentComps();
    ui.data = null;
    ui.records = [];
    render();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
}

async function runImport(handle, { force = false } = {}) {
  setStatus('Reading folder…');
  const summary = await importFromDirectory(handle, { force });
  await loadFromStore();
  setStatus(summaryText(summary));
}

function summaryText(s) {
  if (!s) return noDataText();
  const built = s.built_at ? new Date(s.built_at).toLocaleString('en-CA') : 'unknown';
  const docs = s.documents != null ? `, ${s.documents} documents (${s.checked || 0} checked)` : '';
  return `${fInt(s.db)} database rows${docs}; built ${built}; held in this browser only` +
    (s.no_handle ? '. Re-pick the folder to load an update.' : ', and the folder is re-checked each visit.');
}
function noDataText() {
  return 'No apartment comparables are published with this site. Choose the firm\'s ApartmentComps folder ' +
    '(written by apartment-comps-rebuild.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.records = ui.data?.records || [];
  await placeInClusters(ui.records);
  ui.$clear.hidden = !ui.data;
  setStatus(ui.data ? summaryText(await getManifest()) : noDataText());
  render();
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

/**
 * Give each Winnipeg record its City neighbourhood, cluster and community
 * area from the committed address index (wpg-address.js). Kept on the
 * in-memory records only; a record the index cannot place has no cluster.
 */
async function placeInClusters(records) {
  if (!records.length) return;
  const idx = await loadWpgAddressIndex();
  if (!idx) return;
  const seen = new Map();
  for (const r of records) {
    if (r.city && !/winnipeg/i.test(r.city)) continue;
    const text = lookupAddressText(r.address);
    if (!text) continue;
    if (!seen.has(text)) {
      let hit = lookupAddress(idx, text);
      // "441 Marion St E": retry without a direction the City doesn't use.
      const bare = text.replace(/\s+(N|S|E|W)$/i, '');
      if (!hit.ok && bare !== text) hit = lookupAddress(idx, bare);
      seen.set(text, hit.ok ? hit : null);
    }
    const hit = seen.get(text);
    if (hit) {
      r.cluster = hit.cluster;
      r.neighbourhood = hit.neighbourhood;
      r.community = hit.communityArea;
    }
  }
}

function renderFolderBody() {
  const collapsed = !!ui.data && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !ui.data;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

// --- Filters -----------------------------------------------------------------

const FILTER_DEFAULTS = {
  q: '', dateFrom: '', dateTo: '', yrFrom: '', yrTo: '', suitesMin: '', suitesMax: '',
  kinds: DEFAULT_KINDS, ptypes: null, clusters: null, projected: 'all', heat: '',
  paysHydro: 'any', paysHeat: 'any', paysWater: 'any', mode: 'suite',
  withExp: true, assumed: false, conf: true, unchecked: false,
  sort: 'date', dir: 'desc',
};

const prefs = () => ({ ...FILTER_DEFAULTS, ...ui.prefs });

const INPUTS = [
  ['ac-search', 'q', 'value'], ['ac-date-from', 'dateFrom', 'value'], ['ac-date-to', 'dateTo', 'value'],
  ['ac-yr-from', 'yrFrom', 'value'], ['ac-yr-to', 'yrTo', 'value'],
  ['ac-suites-min', 'suitesMin', 'value'], ['ac-suites-max', 'suitesMax', 'value'],
  ['ac-heat', 'heat', 'value'], ['ac-pays-hydro', 'paysHydro', 'value'],
  ['ac-pays-heat', 'paysHeat', 'value'], ['ac-pays-water', 'paysWater', 'value'],
  ['ac-with-exp', 'withExp', 'checked'], ['ac-assumed', 'assumed', 'checked'],
  ['ac-conf', 'conf', 'checked'], ['ac-unchecked', 'unchecked', 'checked'],
];

function wireFilters() {
  for (const [id, key, prop] of INPUTS) {
    const el = $(id);
    const ev = el.type === 'search' || el.type === 'number' ? 'input' : 'change';
    el.addEventListener(ev, () => { setFilter({ [key]: el[prop] }); });
  }
  for (const name of ['ac-projected', 'ac-mode']) {
    $(name).addEventListener('change', (e) => {
      if (e.target.name !== name) return;
      setFilter({ [name === 'ac-mode' ? 'mode' : 'projected']: e.target.value });
    });
  }
  ui.$kinds.addEventListener('change', () => {
    setFilter({ kinds: [...ui.$kinds.querySelectorAll('input:checked')].map(x => x.value) });
  });
  ui.$ptypes.addEventListener('change', () => {
    setFilter({ ptypes: [...ui.$ptypes.querySelectorAll('input:checked')].map(x => x.value) });
  });
  ui.$clusters.addEventListener('change', () => {
    const all = ui.$clusters.querySelectorAll('input');
    const on = [...ui.$clusters.querySelectorAll('input:checked')].map(x => x.value);
    setFilter({ clusters: on.length === all.length ? null : on });
  });
  $('ac-clusters-all').addEventListener('click', () => setFilter({ clusters: null }));
  $('ac-clusters-none').addEventListener('click', () => setFilter({ clusters: [] }));
  const $menu = ui.$clusterMenu;
  document.addEventListener('click', (e) => { if ($menu.open && !$menu.contains(e.target)) $menu.open = false; });
  $menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $menu.open = false; $menu.querySelector('summary').focus(); } });
  // Clear every filter; the display choices (metric, sort, folder panel) stay.
  $('ac-reset').addEventListener('click', () => {
    const p = prefs();
    const keep = { folderCollapsed: ui.prefs.folderCollapsed, mode: p.mode, sort: p.sort, dir: p.dir };
    setPref(PREF_KEY, keep);
    ui.prefs = keep;
    ui.shown = PAGE;
    syncInputs();
    render();
  });
  $('ac-download-xlsx').addEventListener('click', () => exportExcel().catch(err => {
    console.error('[apartment-comps excel]', err);
    showError('Excel export failed: ' + (err?.message || err));
  }));
  ui.$table.addEventListener('click', onTableClick);
  ui.$table.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.ac-row')) { e.preventDefault(); onTableClick(e); }
  });
  syncInputs();
}

let renderTimer = 0;
function setFilter(patch) {
  ui.prefs = savePrefs(patch);
  ui.shown = PAGE;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 'q' in patch ? 150 : 0);
}

function syncInputs() {
  const p = prefs();
  for (const [id, key, prop] of INPUTS) $(id)[prop] = p[key];
  for (const name of ['ac-projected', 'ac-mode']) {
    const v = name === 'ac-mode' ? p.mode : p.projected;
    const r = document.querySelector(`input[name="${name}"][value="${v}"]`);
    if (r) r.checked = true;
  }
}

function renderChoiceLists() {
  const p = prefs();
  const kinds = new Set(p.kinds);
  const present = new Set(ui.records.map(kindGroup));
  ui.$kinds.innerHTML = KIND_GROUPS.filter(k => present.has(k.id)).map(k => {
    const n = ui.records.filter(r => kindGroup(r) === k.id).length;
    return `<label class="flex items-center gap-2"><input type="checkbox" value="${k.id}" ${kinds.has(k.id) ? 'checked' : ''}/> ${escapeHtml(k.label)} <span class="text-neutral-400 text-xs">${fInt(n)}</span></label>`;
  }).join('');
  const ptypes = [...new Set(ui.records.map(r => r.ptype || 'apartment'))]
    .sort((a, b) => Object.keys(PTYPE_LABELS).indexOf(a) - Object.keys(PTYPE_LABELS).indexOf(b));
  const sel = p.ptypes ? new Set(p.ptypes) : new Set(ptypes);
  renderClusterList(p);
  ui.$ptypes.innerHTML = ptypes.map(t => {
    const n = ui.records.filter(r => (r.ptype || 'apartment') === t).length;
    return `<label class="flex items-center gap-2"><input type="checkbox" value="${escapeHtml(t)}" ${sel.has(t) ? 'checked' : ''}/> ${escapeHtml(PTYPE_LABELS[t] || t)} <span class="text-neutral-400 text-xs">${fInt(n)}</span></label>`;
  }).join('');
}

function renderClusterList(p) {
  const counts = new Map();
  for (const r of ui.records) {
    const c = r.cluster || NO_CLUSTER;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const names = [...counts.keys()].filter(c => c !== NO_CLUSTER).sort((a, b) => a.localeCompare(b));
  if (counts.has(NO_CLUSTER)) names.push(NO_CLUSTER);
  const sel = p.clusters ? new Set(p.clusters) : null;
  ui.$clusters.innerHTML = names.map(c =>
    `<label class="flex items-center gap-2"><input type="checkbox" value="${escapeHtml(c)}" ${!sel || sel.has(c) ? 'checked' : ''}/> ${escapeHtml(c)} <span class="text-neutral-400 text-xs">${fInt(counts.get(c))}</span></label>`).join('');
  ui.$clusterSummary.textContent = !sel ? 'All clusters'
    : sel.size === 0 ? 'No clusters'
    : sel.size === 1 ? [...sel][0]
    : `${sel.size} of ${names.length} clusters`;
}

/** A line naming the active filters, so a narrowed view is never mistaken for everything. */
function renderActiveFilters() {
  const p = prefs();
  const on = [];
  if (p.q) on.push(`"${p.q}"`);
  if (p.clusters) on.push(p.clusters.length === 1 ? p.clusters[0] : `${p.clusters.length} clusters`);
  if (p.kinds.length !== DEFAULT_KINDS.length) on.push('type');
  if (p.dateFrom || p.dateTo) on.push(`dates ${p.dateFrom || '…'} to ${p.dateTo || '…'}`);
  if (p.yrFrom || p.yrTo) on.push(`built ${p.yrFrom || '…'}–${p.yrTo || '…'}`);
  if (p.suitesMin || p.suitesMax) on.push(`${p.suitesMin || '…'}–${p.suitesMax || '…'} suites`);
  if (p.ptypes) on.push('property type');
  if (p.projected !== 'all') on.push(p.projected === 'actual' ? 'current / actual' : 'pro forma');
  if (p.heat) on.push(`heat: ${HEAT_LABELS[p.heat]}`);
  for (const [k, u] of [['paysHydro', 'hydro'], ['paysHeat', 'heat'], ['paysWater', 'water']]) {
    if (p[k] !== 'any') on.push(`tenant pays ${u}: ${p[k] === 'Y' ? 'yes' : 'no'}`);
  }
  if (!p.withExp) on.push('records without expenses included');
  if (!p.conf) on.push('CIMs hidden');
  if (p.unchecked) on.push('unchecked only');
  ui.$active.hidden = !on.length;
  ui.$active.textContent = on.length ? `Filtered by ${on.join(', ')}.` : '';
}

function currentFilter() {
  const p = prefs();
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    q: p.q, dateFrom: p.dateFrom, dateTo: p.dateTo,
    yrFrom: n(p.yrFrom), yrTo: n(p.yrTo), suitesMin: n(p.suitesMin), suitesMax: n(p.suitesMax),
    kinds: new Set(p.kinds), ptypes: p.ptypes ? new Set(p.ptypes) : null,
    clusters: p.clusters ? new Set(p.clusters) : null,
    projected: p.projected, heat: p.heat,
    pays: { hydro: p.paysHydro, heat: p.paysHeat, water: p.paysWater },
    withExpenses: p.withExp, showConf: p.conf, unchecked: p.unchecked,
  };
}

// --- Rendering ---------------------------------------------------------------

function render() {
  renderFolderBody();
  const has = ui.records.length > 0;
  ui.$empty.hidden = has;
  ui.$about.hidden = !has;
  ui.$summaryWrap.hidden = !has;
  ui.$tableWrap.hidden = !has;
  if (!has) { ui.$summary.innerHTML = ''; ui.$table.innerHTML = ''; return; }
  renderChoiceLists();
  renderActiveFilters();
  const p = prefs();
  const opts = { mode: p.mode, assumed: p.assumed };
  ui.filtered = sortRecords(filterRecords(ui.records, currentFilter()), p.sort, p.dir, opts);
  renderSummary(ui.filtered, opts);
  renderTable(ui.filtered, opts);
}

const fX = (v) => (v == null || !Number.isFinite(v) ? MISSING : v.toFixed(2));
const fmtMetric = (v, mode) => (mode === 'egi' ? fPctFrac1(v, MISSING) : fUsd(v, MISSING));
const MODE_LABEL = { suite: '$ per suite per year', egi: '% of EGI', annual: 'annual $' };

function renderSummary(rows, opts) {
  const sum = summarize(rows, opts);
  const egis = rows.map(r => egiOf(r, opts)).filter(v => v != null);
  ui.$summaryNote.textContent =
    `${fInt(rows.length)} records match. Expenses as ${MODE_LABEL[opts.mode]}` +
    (opts.assumed ? ', including the database allowances.' : ', reported figures only (database allowances left out).') +
    ` Each row counts only the records that give that category${opts.mode === 'suite' ? ' and a suite count' : opts.mode === 'egi' ? ' and an EGI' : ''}.` +
    (egis.length ? '' : ' No record in the selection has income figures.');
  const tr = (s) => {
    const f = (v) => (s.fmt === 'pct' ? fPctFrac1(v, MISSING) : s.fmt === 'x' ? fX(v) : fmtMetric(v, opts.mode));
    return `<tr${s.strong ? ' class="font-semibold"' : ''}${s.gap ? ' style="border-top:2px solid #999"' : ''}><td class="ac-addr">${escapeHtml(s.label)}</td>` +
      `<td>${f(s.median)}</td><td>${f(s.mean)}</td><td>${f(s.min)}</td><td>${f(s.max)}</td><td>${fInt(s.n)}</td></tr>`;
  };
  ui.$summary.innerHTML = `<table class="cmhc-table cmhc-table-compact"><thead><tr>
    <th>Category</th><th>Median</th><th>Average</th><th>Low</th><th>High</th><th>Records</th></tr></thead>
    <tbody>${sum.map(tr).join('')}</tbody></table>`;
}

const TABLE_COLS = [
  { id: 'date', label: 'Date' }, { id: 'address', label: 'Address' }, { id: 'cluster', label: 'Cluster' },
  { id: 'kind', label: 'Type' },
  { id: 'suites', label: 'Suites' }, { id: 'yr', label: 'Built' }, { id: 'price', label: 'Price' },
  { id: 'per_suite', label: 'Price / suite' }, { id: 'egi', label: 'EGI' },
  { id: 'egim', label: 'EGIM', title: 'Effective gross income multiplier: price ÷ EGI' },
  ...COLUMNS.map(c => ({ id: c.id, label: c.label, title: c.title, metric: true })),
  { id: 'total', label: 'Total exp.', metric: true }, { id: 'ratio', label: 'Exp. ratio', title: 'Total expenses as a % of EGI' },
  { id: 'noi', label: 'NOI' }, { id: 'cap', label: 'Cap' },
];

function badges(r) {
  const out = [];
  if (r.conf) out.push('<span class="ac-badge ac-badge-conf" title="Confidential offering memorandum">CIM</span>');
  if (r.src === 'doc' && !r.checked) out.push('<span class="ac-badge ac-badge-warn" title="Not yet checked against the document">unchecked</span>');
  if (r.src === 'doc' && isProjected(r)) out.push(`<span class="ac-badge ac-badge-proj" title="${escapeHtml(r.period || r.scenario || 'Projected figures')}">pro forma</span>`);
  return out.join('');
}

function cellMetric(r, cats, opts) {
  const cv = columnValue(r, cats, opts);
  if (!cv) return MISSING;
  const v = normalize(cv.v, r, opts.mode, opts);
  return fmtMetric(v, opts.mode) + (cv.assumed ? '<sup title="Database allowance">a</sup>' : '');
}

function rowHtml(r, opts) {
  const price = priceOf(r);
  const egi = egiOf(r, opts);
  const total = totalExpenses(r, opts);
  const priceNote = r.price_kind && r.price_kind !== 'sale' ? ` <span class="text-neutral-500">(${escapeHtml(r.price_kind)})</span>` : '';
  const open = ui.open.has(r.id);
  const cells = [
    escapeHtml(r.date || MISSING),
    `${escapeHtml(r.address || MISSING)}${badges(r)}`,
    escapeHtml(r.cluster || MISSING),
    escapeHtml(KIND_LABEL[kindGroup(r)] || r.kind || ''),
    fInt(r.suites, MISSING), escapeHtml(r.yr_text || (r.yr ? String(r.yr) : MISSING)),
    fUsd(price, MISSING) + priceNote,
    fUsd(price && r.suites ? price / r.suites : null, MISSING),
    opts.mode === 'suite' ? fUsd(egi != null && r.suites ? egi / r.suites : null, MISSING) : fUsd(egi, MISSING),
    fX(egimOf(r, opts)),
    ...COLUMNS.map(c => cellMetric(r, c.cats, opts)),
    fmtMetric(normalize(total, r, opts.mode, opts), opts.mode),
    fPctFrac1(expenseRatio(r, opts), MISSING),
    fUsd(noiOf(r), MISSING), fPctFrac1(capOf(r), MISSING),
  ];
  const tds = cells.map((c, i) => `<td${i === 1 || i === 2 ? ' class="ac-addr"' : ''}>${c}</td>`).join('');
  const row = `<tr class="ac-row" data-id="${escapeHtml(r.id)}" tabindex="0" aria-expanded="${open}">${tds}</tr>`;
  return open ? row + `<tr class="ac-detail"><td colspan="${TABLE_COLS.length}">${detailHtml(r, opts)}</td></tr>` : row;
}

function renderTable(rows, opts) {
  const p = prefs();
  const shown = rows.slice(0, ui.shown);
  ui.$count.textContent = `${fInt(rows.length)} records` +
    (rows.length > shown.length ? `, showing the first ${fInt(shown.length)}` : '') +
    `. EGI ${opts.mode === 'suite' ? 'per suite' : 'annual'}; expense columns as ${MODE_LABEL[opts.mode]}. Click a column to sort, a row for its detail.`;
  const head = TABLE_COLS.map(c => {
    const arrow = p.sort === c.id ? (p.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const aria = p.sort === c.id ? ` aria-sort="${p.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th${aria}${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><button type="button" data-sort="${c.id}">${escapeHtml(c.label)}${arrow}</button></th>`;
  }).join('');
  const more = rows.length > shown.length
    ? `<p class="mt-2"><button type="button" class="text-sm underline text-accent-600" data-more="1">Show ${fInt(Math.min(PAGE, rows.length - shown.length))} more</button></p>` : '';
  ui.$table.innerHTML = `<table class="cmhc-table cmhc-table-compact"><thead><tr>${head}</tr></thead>
    <tbody>${shown.map(r => rowHtml(r, opts)).join('') || `<tr><td colspan="${TABLE_COLS.length}">No records match these filters.</td></tr>`}</tbody></table>${more}`;
}

function onTableClick(e) {
  const sortBtn = e.target.closest('button[data-sort]');
  if (sortBtn) {
    const id = sortBtn.dataset.sort;
    const p = prefs();
    const dir = p.sort === id ? (p.dir === 'asc' ? 'desc' : 'asc') : (id === 'address' || id === 'kind' || id === 'cluster' ? 'asc' : 'desc');
    setFilter({ sort: id, dir });
    return;
  }
  if (e.target.closest('button[data-more]')) {
    ui.shown += PAGE;
    render();
    return;
  }
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    ui.open.add(jump.dataset.jump);
    const at = (ui.filtered || []).findIndex(x => x.id === jump.dataset.jump);
    if (at >= ui.shown) ui.shown = at + 1;
    render();
    ui.$table.querySelector(`tr.ac-row[data-id="${CSS.escape(jump.dataset.jump)}"]`)?.scrollIntoView({ block: 'center' });
    return;
  }
  const row = e.target.closest('tr.ac-row');
  if (!row) return;
  const id = row.dataset.id;
  if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
  render();
  ui.$table.querySelector(`tr.ac-row[data-id="${CSS.escape(id)}"]`)?.focus();
}

// --- Row detail ----------------------------------------------------------------

function dl(pairs) {
  return `<dl>${pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

const yesNo = (v) => (v === 'Y' ? 'yes' : v === 'N' ? 'no' : null);

function detailHtml(r, opts) {
  const egi = egiOf(r, opts);
  const facts = dl([
    ['Source', r.src === 'db' ? `Database, ${escapeHtml(r.sheet)} row ${r.row}${r.section ? ` (${escapeHtml(r.section)})` : ''}` : `Document: ${escapeHtml(r.file)}${r.pages ? `, ${escapeHtml(r.pages)}` : ''}`],
    ['Record', escapeHtml([r.kind, r.scenario && `${r.scenario}${r.period ? ` — ${r.period}` : ''}`].filter(Boolean).join(' · '))],
    ['Other addresses', r.other_addresses ? escapeHtml(r.other_addresses) : null],
    ['Neighbourhood', r.cluster ? escapeHtml([r.neighbourhood, r.cluster, r.community].filter(Boolean).join(' · ')) : null],
    ['MLS # / area', [r.mls, r.area].filter(Boolean).map(escapeHtml).join(' / ') || null],
    ['Property type', escapeHtml(PTYPE_LABELS[r.ptype] || r.ptype || '')],
    ['Suite mix', r.mix ? escapeHtml(Object.entries(r.mix).map(([k, v]) => `${v} ${k === 'bach' ? 'bach' : k.replace('b', '') + '-bed'}`).join(', ')) : null],
    ['Commercial units', r.commercial_units ? fInt(r.commercial_units) : null],
    ['Building area', r.gba ? `${fInt(r.gba)} sf` : null],
    ['List price', r.list_price && r.list_price !== r.price ? fUsd(r.list_price) : null],
  ]);
  const utils = dl([
    ['Heat', r.heat ? escapeHtml(r.heat) + (heatGroup(r) ? ` (${escapeHtml(HEAT_LABELS[heatGroup(r)])})` : '') : null],
    ['Hot water', r.hot_water ? escapeHtml(r.hot_water) : null],
    ['Hydro metering', r.metering ? escapeHtml(r.metering) : null],
    ['Tenants pay', r.tenants_pay ? escapeHtml(r.tenants_pay)
      : r.pays ? escapeHtml(Object.entries(r.pays).map(([u, v]) => `${u} ${yesNo(v)}`).join(', ')) : null],
    ['Parking', r.parking ? escapeHtml(r.parking) : null],
    ['Laundry', r.laundry ? escapeHtml(r.laundry) : null],
    ['Notes', r.notes ? escapeHtml(r.notes) : null],
    ['Review note', r.review ? escapeHtml(r.review) + (r.confidence ? ` <em>(confidence ${escapeHtml(r.confidence)})</em>` : '') : null],
  ]);

  const catRows = (labels, isIncome) => Object.keys(labels).map(cat => {
    const e = (isIncome ? r.inc : r.exp)?.[cat];
    if (!e) return '';
    const counted = catValue(r, cat, opts) != null;
    const per = r.suites ? e.v / r.suites : null;
    return `<tr${counted ? '' : ' class="text-neutral-400"'}><td>${escapeHtml(labels[cat])}${e.a ? '<sup title="Database allowance">a</sup>' : ''}</td>
      <td class="num">${fUsd(e.v)}</td><td class="num">${fUsd(per, MISSING)}</td><td class="num">${fPctFrac1(egi ? e.v / egi : null, MISSING)}</td></tr>`;
  }).join('');
  const egiRow = egi != null ? `<tr class="font-semibold"><td>EGI</td><td class="num">${fUsd(egi)}</td><td class="num">${fUsd(r.suites ? egi / r.suites : null, MISSING)}</td><td></td></tr>` : '';
  const total = totalExpenses(r, opts);
  const totalRow = total != null ? `<tr class="font-semibold"><td>Total expenses</td><td class="num">${fUsd(total)}</td><td class="num">${fUsd(r.suites ? total / r.suites : null, MISSING)}</td><td class="num">${fPctFrac1(expenseRatio(r, opts), MISSING)}</td></tr>` : '';
  const stated = [['Stated total expenses', r.total_exp], ['Stated NOI', r.noi]].filter(([, v]) => v != null)
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">${fUsd(v)}</td><td></td><td></td></tr>`).join('');
  const egim = egimOf(r, opts);
  const ratios = `<tr><td>EGIM</td><td class="num">${fX(egim)}</td><td></td><td></td></tr>` +
    `<tr><td>Cap rate</td><td class="num">${fPctFrac1(capOf(r), MISSING)}</td><td></td><td></td></tr>`;
  const breakdown = `<table class="cmhc-table cmhc-table-compact ac-lines"><thead><tr><th>Category</th><th>Annual</th><th>Per suite</th><th>% EGI</th></tr></thead>
    <tbody>${catRows(INCOME_LABELS, true)}${egiRow}${catRows(EXPENSE_LABELS, false)}${totalRow}${stated}${ratios}</tbody></table>
    ${opts.assumed ? '' : '<p class="text-xs text-neutral-500 mt-1">Greyed lines are database allowances, left out while "Include assumed allowances" is off.</p>'}`;

  const lines = r.lines?.length ? `<h4 class="font-semibold mt-2 mb-1">As printed in the document</h4>
    <table class="cmhc-table cmhc-table-compact ac-lines"><thead><tr><th>Line</th><th>Annual</th><th>Category</th><th>Basis / note</th></tr></thead><tbody>${
      r.lines.map(([label, amt, cat, basis, note]) => `<tr><td>${escapeHtml(label || '')}</td><td class="num">${amt == null ? MISSING : cat === 'stated_cap' ? fPctFrac1(amt) : fUsd(amt)}</td>
        <td>${escapeHtml(EXPENSE_LABELS[cat] || INCOME_LABELS[cat] || cat)}</td><td>${escapeHtml([basis, note].filter(Boolean).join(' — '))}</td></tr>`).join('')
    }</tbody></table>` : '';
  const comments = r.comments?.length ? `<h4 class="font-semibold mt-2 mb-1">Cell comments</h4><ul class="list-disc ml-5">${
    r.comments.map(c => `<li><strong>${escapeHtml(INCOME_LABELS[c.col] || EXPENSE_LABELS[c.col] || c.col)}:</strong> ${escapeHtml(c.text)}</li>`).join('')}</ul>` : '';
  const others = sameProperty(ui.records, r);
  const visible = new Set((ui.filtered || []).map(x => x.id));
  const item = (o) => {
    const text = `${escapeHtml(o.date || '**')} · ${escapeHtml(KIND_LABEL[kindGroup(o)] || o.kind || '')}${o.scenario ? ` (${escapeHtml(o.scenario)})` : ''} · ${fUsd(o.price, MISSING)}`;
    const link = visible.has(o.id)
      ? `<button type="button" class="underline text-accent-600" data-jump="${escapeHtml(o.id)}">${text}</button>`
      : `${text} <span class="text-neutral-500">(hidden by the filters)</span>`;
    return `<li>${link}${o.conf ? ' <span class="ac-badge ac-badge-conf">CIM</span>' : ''}${o.src === 'db' ? ' <span class="text-neutral-500">database</span>' : ''}</li>`;
  };
  const history = others.length ? `<h4 class="font-semibold mt-2 mb-1">Other records of this property</h4><ul class="ml-1">${
    others.map(item).join('')}</ul><p class="text-xs text-neutral-500">Matched by street number and name.</p>` : '';
  return `<div class="ac-detail-grid"><div>${facts}${utils}</div><div>${breakdown}${lines}</div><div>${comments}${history}</div></div>`;
}

// --- Excel export --------------------------------------------------------------

async function exportExcel() {
  const rows = ui.filtered || [];
  if (!rows.length) { showError('No records to export.'); return; }
  const { default: ExcelJS } = await import('exceljs');
  const p = prefs();
  const opts = { mode: p.mode, assumed: p.assumed };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Housing & Economic Data';
  wb.created = new Date();
  const head = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C1014' } } };

  const ws = wb.addWorksheet('Records', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const incCats = Object.keys(INCOME_LABELS), expCats = Object.keys(EXPENSE_LABELS);
  const cols = [
    ['Date', 11], ['Address', 26], ['Neighbourhood cluster', 22], ['Neighbourhood', 20], ['Type', 12], ['Scenario', 14], ['Confidential', 8], ['Checked', 8],
    ['Property type', 14], ['Suites', 7], ['Year built', 10], ['Price', 12], ['Price type', 9], ['Heat', 16],
    ['Tenants pay', 16], ...incCats.map(c => [INCOME_LABELS[c], 12]), ['EGI', 12],
    ...expCats.map(c => [EXPENSE_LABELS[c], 12]), ['Total expenses', 13], ['Expense ratio', 9], ['NOI', 12],
    ['Cap rate', 8], ['EGIM', 7], ['Assumed allowances', 20], ['Source', 40], ['Notes / review', 50],
  ];
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.getRow(1).eachCell(c => Object.assign(c, head));
  for (const r of rows) {
    const assumedCats = [...Object.entries(r.inc || {}), ...Object.entries(r.exp || {})].filter(([, e]) => e.a).map(([k]) => k);
    ws.addRow([
      r.date || null, r.address || null, r.cluster || null, r.neighbourhood || null, KIND_LABEL[kindGroup(r)] || r.kind || null,
      r.scenario ? `${r.scenario}${r.period ? ` — ${r.period}` : ''}` : null,
      r.conf ? 'Y' : null, r.src === 'doc' ? (r.checked ? 'Y' : 'N') : null,
      PTYPE_LABELS[r.ptype] || r.ptype || null, r.suites ?? null, r.yr_text || r.yr || null,
      priceOf(r), r.price_kind || null, r.heat || null,
      r.tenants_pay || (r.pays ? Object.entries(r.pays).map(([u, v]) => `${u} ${yesNo(v)}`).join(', ') : null),
      ...incCats.map(c => catValue(r, c, opts)), egiOf(r, opts),
      ...expCats.map(c => catValue(r, c, opts)), totalExpenses(r, opts), expenseRatio(r, opts), noiOf(r), capOf(r),
      egimOf(r, opts),
      assumedCats.length ? (opts.assumed ? 'included: ' : 'left out: ') + assumedCats.join(', ') : null,
      r.src === 'db' ? `DB ${r.sheet} row ${r.row}` : r.file, [r.notes, r.review].filter(Boolean).join(' | ') || null,
    ]);
  }
  const money = cols.findIndex(c => c[0] === 'Price') + 1;
  ws.getColumn(money).numFmt = '#,##0';
  for (let i = cols.findIndex(c => c[0] === INCOME_LABELS.rent) + 1; i <= cols.findIndex(c => c[0] === 'NOI') + 1; i++) ws.getColumn(i).numFmt = '#,##0';
  ws.getColumn(cols.findIndex(c => c[0] === 'Cap rate') + 1).numFmt = '0.00%';
  ws.getColumn(cols.findIndex(c => c[0] === 'Expense ratio') + 1).numFmt = '0.0%';
  ws.getColumn(cols.findIndex(c => c[0] === 'EGIM') + 1).numFmt = '0.00';

  const ss = wb.addWorksheet('Summary');
  ss.addRow([`Apartment income & expenses — ${rows.length} records, expenses as ${MODE_LABEL[opts.mode]}${opts.assumed ? ' (allowances included)' : ' (reported figures only)'}`]).font = { bold: true };
  ss.addRow([]);
  const hr = ss.addRow(['Category', 'Median', 'Average', 'Low', 'High', 'Records']);
  hr.eachCell(c => Object.assign(c, head));
  for (const s of summarize(rows, opts)) {
    const row = ss.addRow([s.label, s.median, s.mean, s.min, s.max, s.n]);
    const fmt = s.fmt === 'pct' || (!s.fmt && opts.mode === 'egi') ? '0.0%' : s.fmt === 'x' ? '0.00' : '#,##0';
    for (let i = 2; i <= 5; i++) row.getCell(i).numFmt = fmt;
  }
  [28, 12, 12, 12, 12, 9].forEach((w, i) => { ss.getColumn(i + 1).width = w; });
  ss.addRow([]);
  ss.addRow(['Exported', new Date().toISOString().slice(0, 10)]);
  ss.addRow(['Caveat', 'Includes brokers\' confidential material where CIM records are shown. Not for redistribution.']);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `apartment-income-expenses-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
