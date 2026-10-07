/*
 * Yardi Rental tab — purpose-built apartment rents, new-lease rent change,
 * vacancy, turnover, length of stay, digital leasing and operating expenses
 * from the quarterly Yardi Canadian National Multifamily Report: 12 CMAs and
 * National, by bedroom type, and expenses by province.
 *
 * NO YARDI DATA SHIPS WITH THE SITE (the report is copyrighted). The PDFs are
 * parsed by Yardi-Rental/ingest/parse_yardi.py into yardi.json and published
 * to SharedInfo\AppMarketData\RentalData; the user nominates that folder here
 * and the browser reads it locally (yardi-store.js).
 *
 * Laid out like the Johnson Report tab: a sidebar quarter (edition) picker
 * that also ends the charts, one centre at a time (Winnipeg by default),
 * unit-type checkboxes for the unit-type charts and the quarter table,
 * section toggles, and one "About these charts" note. Figures read
 * off the report's charts rather than its tables are approximate; the note
 * says which.
 */

import * as Plot from '@observablehq/plot';
import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { themed, PALETTE, gridMarks, frameMark, plotWidth, plotHeight, fitPlotWidth } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  SOURCE, CMAS, DEFAULT_CENTRES, DEFAULT_FROM, PROVINCES, CMA_PROVINCE, SEGMENTS, METRICS, GROUPS,
  CENTRE_CHARTS, BEDROOM_CHARTS, EXPENSE_METRICS,
  qOrd, qLabel, indexObs, toCardInput, quarterRanges, expenseQuarter, valueAt,
} from './yardi-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearYardi,
} from './yardi-store.js';

const PREF_KEY = 'yardi.v1';
const MISSING = '**';

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

// --- Init --------------------------------------------------------------------

export async function initYardi() {
  const $status = document.getElementById('yr-folder-status');
  const $grid = document.getElementById('yr-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('yr-folder-error'),
    $pick: document.getElementById('yr-pick-folder'),
    $pickFallback: document.getElementById('yr-pick-fallback'),
    $rescan: document.getElementById('yr-rescan'),
    $clear: document.getElementById('yr-clear'),
    $folderToggle: document.getElementById('yr-folder-toggle'),
    $folderBody: document.getElementById('yr-folder-body'),
    $quarter: document.getElementById('yr-quarter'),
    $yearFrom: document.getElementById('yr-year-from'),
    $quarterFrom: document.getElementById('yr-quarter-from'),
    $centre: document.getElementById('yr-centre'),
    $units: document.getElementById('yr-units'),
    $sectionMenu: document.getElementById('yr-section-menu'),
    $sections: document.getElementById('yr-section-toggles'),
    $sectionSummary: document.getElementById('yr-section-summary-text'),
    $xlsx: document.getElementById('yr-download-xlsx'),
    $empty: document.getElementById('yr-empty'),
    $about: document.getElementById('yr-about'),
    $approx: document.getElementById('yr-about-approx'),
    data: null,
    index: new Map(),
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the Yardi data locally (IndexedDB is unavailable).');
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
      if (!handle) { showError('No folder is saved yet — choose the RentalData folder first.'); return; }
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
    await clearYardi();
    ui.data = null;
    ui.index = new Map();
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  ui.$centre.addEventListener('change', () => { ui.prefs = savePrefs({ centre: ui.$centre.value }); renderCharts(); });
  document.getElementById('yr-sections-all').addEventListener('click', () => setGroups(GROUPS.map(g => g.id)));
  document.getElementById('yr-sections-none').addEventListener('click', () => setGroups([]));
  for (const $menu of [ui.$sectionMenu]) {
    document.addEventListener('click', (e) => { if ($menu.open && !$menu.contains(e.target)) $menu.open = false; });
    $menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $menu.open = false; $menu.querySelector('summary').focus(); } });
  }
  ui.$quarter.addEventListener('change', () => { ui.prefs = savePrefs({ quarter: ui.$quarter.value }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null }); renderCharts(); });
  ui.$quarterFrom.addEventListener('change', () => { ui.prefs = savePrefs({ quarterFrom: ui.$quarterFrom.value }); renderCharts(); });
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[yardi excel]', err);
    showError('Excel export failed: ' + (err?.message || err));
  }));
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
  return `${s.editions} editions (data ${s.first} to ${s.last}), read ${when}; ` +
    (s.no_handle ? 'held in this browser only. Re-pick the folder to load an update.'
                 : 'held in this browser only. The folder is re-checked each visit.');
}
function noDataText() {
  return 'No Yardi data is published with this site. Choose the firm\'s RentalData folder ' +
    '(published by Yardi-Rental\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.index = indexObs(ui.data);
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

// --- Sidebar -----------------------------------------------------------------

function renderAll() {
  renderFolderBody();
  renderQuarterPicker();
  renderCentrePicker();
  renderUnitToggles();
  renderSectionToggles();
  renderCharts();
}

function renderFolderBody() {
  const collapsed = !!ui.data && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !ui.data;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

/** The editions, newest first, as the quarter picker lists them. */
function editionsDesc() {
  return [...(ui.data?.editions || [])].sort((a, b) => qOrd(b.id) - qOrd(a.id));
}

function renderQuarterPicker() {
  const $sel = ui.$quarter;
  $sel.replaceChildren();
  const eds = editionsDesc();
  for (const e of eds) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.label} (${e.cover} report)`;
    $sel.appendChild(opt);
  }
  if (ui.prefs.quarter && eds.some(e => e.id === ui.prefs.quarter)) $sel.value = ui.prefs.quarter;
  else if (eds.length) $sel.value = eds[0].id;
  $sel.disabled = eds.length === 0;
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$yearFrom.placeholder = DEFAULT_FROM.slice(0, 4);
  ui.$quarterFrom.value = String(ui.prefs.quarterFrom || DEFAULT_FROM.slice(-1));
}

/** One centre at a time (Jason, 2026-10-07); an older multi-centre pref keeps its first pick. */
function selectedCentre() {
  const p = ui.prefs;
  if (CMAS.includes(p.centre)) return p.centre;
  const old = Array.isArray(p.centres) ? CMAS.find(c => p.centres.includes(c) && c !== 'National') : null;
  return old || DEFAULT_CENTRES[0];
}

function renderCentrePicker() {
  ui.$centre.replaceChildren();
  for (const c of CMAS) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    ui.$centre.appendChild(opt);
  }
  ui.$centre.value = selectedCentre();
}

/** Unit types: All units + the four bedroom types. */
const UNIT_TYPES = [{ id: 'total', label: 'All units' }, ...SEGMENTS];

function selectedUnits() {
  const saved = ui.prefs.units;
  return Array.isArray(saved) ? UNIT_TYPES.filter(u => saved.includes(u.id)) : UNIT_TYPES.slice();
}

function renderUnitToggles() {
  const on = new Set(selectedUnits().map(u => u.id));
  ui.$units.replaceChildren();
  for (const u of UNIT_TYPES) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(u.id);
    cb.addEventListener('change', () => {
      const next = new Set(selectedUnits().map(x => x.id));
      if (cb.checked) next.add(u.id); else next.delete(u.id);
      ui.prefs = savePrefs({ units: UNIT_TYPES.map(x => x.id).filter(id => next.has(id)) });
      renderCharts();
    });
    const text = document.createElement('span'); text.textContent = u.label;
    label.append(cb, text);
    ui.$units.appendChild(label);
  }
}

function enabledGroups() {
  const saved = ui.prefs.groups;
  return new Set(Array.isArray(saved) ? saved : GROUPS.map(g => g.id));
}

function setGroups(ids) {
  const next = new Set(ids);
  ui.prefs = savePrefs({ groups: GROUPS.map(g => g.id).filter(id => next.has(id)) });
  renderSectionToggles();
  renderCharts();
}

function renderSectionToggles() {
  const on = enabledGroups();
  ui.$sections.replaceChildren();
  const shown = GROUPS.filter(g => on.has(g.id)).map(g => g.label);
  ui.$sectionSummary.textContent = shown.length === GROUPS.length ? `All sections (${GROUPS.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.join(', ')
    : `${shown.length} of ${GROUPS.length} sections`;
  for (const g of GROUPS) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(g.id);
    cb.addEventListener('change', () => {
      const next = enabledGroups();
      if (cb.checked) next.add(g.id); else next.delete(g.id);
      setGroups([...next]);
    });
    const text = document.createElement('span'); text.textContent = g.label;
    label.append(cb, text);
    ui.$sections.appendChild(label);
  }
}

// --- Selection -----------------------------------------------------------------

function selection() {
  const eds = editionsDesc();
  const q = ui.$quarter.value || eds[0]?.id || null;
  const edition = (ui.data?.editions || []).find(e => e.id === q) || null;
  // Charts start at the chosen quarter + year; by default Q3 2023, when the
  // bedroom-type detail begins (Jason, 2026-10-07). A blank year keeps 2023.
  const from = `${ui.prefs.yearFrom || DEFAULT_FROM.slice(0, 4)}Q${ui.prefs.quarterFrom || DEFAULT_FROM.slice(-1)}`;
  const centre = selectedCentre();
  return { q, edition, from, centre, centres: [centre], units: selectedUnits() };
}

/** "Yardi Canadian National Multifamily Report, Q3 2026" — the edition
 *  whose data quarter is selected (its cover is one quarter later). */
function sourceFor(edition) {
  return edition ? `${SOURCE}, ${edition.cover}` : SOURCE;
}

// --- Charts ------------------------------------------------------------------

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  if (!ui.data) { ui.$empty.hidden = false; ui.$about.hidden = true; return; }
  ui.$empty.hidden = true;
  ui.$about.hidden = false;

  const sel = selection();
  const source = sourceFor(sel.edition);
  const range = { from: sel.from, to: sel.q };
  const on = enabledGroups();
  const drawnSections = [];
  const approx = [];   // { chart, quarters } — chart-read points actually drawn

  const section = (g) => {
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = `yr-section-${g.id}`;
    s.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    s.querySelector('h2').textContent = g.label;
    return s;
  };

  // Every Yardi chart's Y axis starts at 0 (or below, if a series dips
  // negative) — Jason, 2026-10-07.
  const lineCard = ($cards, id, { title, subtitle = '', lines, zeroBased = true, nameInSubtitle = true }) => {
    // Lines join across a missing edition (Q3 2024, Q1 2026): the gap is a
    // report the firm lacks, not a quarter Yardi left out. The About note says so.
    const input = toCardInput(id, ui.index, lines, { ...range, bridge: true });
    if (!input.records.length) return false;
    for (const a of input.approx) approx.push({ chart: title, label: a.label, quarters: a.quarters });
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title, sourceLabel: source, table: true,
      zeroBased, mirrorY: false,
      // "Source: …" alone, bottom-right, 10 pt in print; no company name on
      // subscriber figures (as on Johnson Report and Cap Rates).
      sourceInCaption: true, signed: false, captionPt: 10,
    });
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: 'quarter', subtitle, singleSeriesInSubtitle: nameInSubtitle, dashedIds: [],
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
    return true;
  };

  for (const g of GROUPS) {
    if (!on.has(g.id)) continue;
    const s = section(g);
    const $cards = s.querySelector('[data-role="cards"]');
    let drawn = 0;

    if (g.id === 'total' || g.id === 'leasing') {
      for (const ch of CENTRE_CHARTS.filter(c => c.group === g.id)) {
        // The rent charts always carry National beside the centre (Jason,
        // 2026-10-07); the others show the centre alone.
        const withNational = ch.withNational && sel.centre !== 'National';
        const geos = withNational ? [sel.centre, 'National'] : [sel.centre];
        const lines = geos.map(geo => ({ label: geo, geo, seg: 'total', metric: ch.metric }));
        if (lineCard($cards, `yardi_${ch.id}`, {
          // The centre already leads the title; don't repeat it in the subtitle.
          title: `${geos.join(' & ')} ${ch.title}`, subtitle: ch.subtitle || '', lines, nameInSubtitle: false,
        })) drawn++;
      }
    } else if (g.id === 'bedroom') {
      // One chart per measure, a line per ticked unit type (All units too:
      // its in-place rent is the chart-read history line).
      for (const ch of BEDROOM_CHARTS) {
        const lines = sel.units.map(u => ({ label: u.label, geo: sel.centre, seg: u.id, metric: ch.metric }));
        if (lineCard($cards, `yardi_bed_${ch.id}_${slug(sel.centre)}`, {
          title: `${sel.centre} ${ch.title}`, lines,
        })) drawn++;
      }
    } else if (g.id === 'tables') {
      drawn += quarterTables($cards, sel, source);
    } else if (g.id === 'expense') {
      drawn += expenseCards($cards, sel);
    }
    if (drawn) { $grid.appendChild(s); drawnSections.push({ id: s.id, label: g.label }); }
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = sel.units.length ? 'Nothing to draw for this quarter and section selection.' : 'No unit types ticked.';
    $grid.appendChild(p);
  }
  renderApproxNote(approx);
}

/** Data quarters between the first and last edition with no edition held. */
function missingEditions() {
  const ids = (ui.data?.editions || []).map(e => e.id).sort((a, b) => qOrd(a) - qOrd(b));
  if (!ids.length) return [];
  const have = new Set(ids);
  const out = [];
  for (let o = qOrd(ids[0]); o <= qOrd(ids[ids.length - 1]); o++) {
    const q = `${Math.floor(o / 4)}Q${(o % 4) + 1}`;
    if (!have.has(q)) out.push(q);
  }
  return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Which drawn points came off Yardi's charts rather than its tables. */
function renderApproxNote(approx) {
  const $n = ui.$approx;
  $n.replaceChildren();
  // The all-units rent level, alone or as the "All units" line of the
  // unit-type rent chart, is chart-read throughout.
  const isRentLevel = (a) => a.chart.endsWith('Average In-Place Rent') || (a.chart.includes('In-Place Rent by Unit Type') && a.label === 'All units');
  const qs = approx.filter(a => !isRentLevel(a)).flatMap(a => a.quarters);
  const parts = [];
  if (approx.some(isRentLevel)) {
    parts.push('Average in-place rent (all units) is read entirely off the report’s history chart: the tables give only its year-over-year change.');
  }
  if (qs.length) {
    parts.push(`On the year-over-year, new-lease and vacancy charts, ${quarterRanges(qs)} come from the history charts too, because no report table covers them (a CMA missing from that quarter’s table, or an edition missing from the folder). Year-over-year change there is worked out from the chart’s rent levels.`);
  }
  const missing = missingEditions();
  if (missing.length) {
    parts.push(`Where no report is held for a quarter (${quarterRanges(missing)}), measures that only come from the tables have no figure; their lines join the quarters either side.`);
  }
  parts.push('Expense per unit is read off the report’s bar charts. Checked against the figures quoted in the reports’ text, chart readings are within about 0.1 percentage points and $5.');
  for (const t of parts) {
    const p = document.createElement('p');
    p.textContent = t;
    $n.appendChild(p);
  }
}

// --- Quarter tables -------------------------------------------------------------

const fmtCell = (units, v) => {
  if (v == null || !Number.isFinite(v)) return MISSING;
  if (units === 'percent') return `${v.toFixed(1)}%`;
  if (units === 'dollar') return `$${Math.round(v).toLocaleString('en-CA')}`;
  if (units === 'months') return String(Math.round(v));
  return String(Math.round(v));
};

// Short headings: the wide all-units table must fit a 1950 px PNG at 12 pt.
const COL_HEAD = {
  rent: 'In-Place Rent', rent_yoy: 'Rent Y/Y', lol: 'New Lease', vacancy: 'Vacancy',
  turnover: 'Turnover', turnover_q: 'Turnover (Qtr)', renewal: 'Renewal',
  stay: 'Stay (mo.)', digital_conv: 'Digital Conv.', digital_per100: 'Prospects /100',
  exp_rm: 'Repairs & Maint.', exp_ctrl: 'Controllable', exp_total: 'Total Expense',
};

/**
 * One table for the centre and quarter: a row per ticked unit type (Jason,
 * 2026-10-07 — it replaced an all-units table plus four one-row bedroom
 * tables). Columns a quarter never published (renewal %, quarterly turnover)
 * drop out; length of stay and digital leasing exist for All units only.
 */
const TABLE_METRICS = ['rent', 'rent_yoy', 'lol', 'vacancy', 'turnover', 'turnover_q', 'renewal', 'stay', 'digital_conv', 'digital_per100'];

function quarterTables($cards, sel, source) {
  const cell = (seg, m) => {
    const p = (ui.index.get(`${sel.centre}|${seg}|${m}`) || []).find(x => x.q === sel.q && x.src === 't');
    return p && Number.isFinite(p.v) ? p.v : null;
  };
  // Short row labels: "1-Bedroom" wrapped in the nine-column PNG.
  const rows = sel.units.map(u => ({ geo: u.label.replace('-Bedroom', '-Bed'), values: TABLE_METRICS.map(m => cell(u.id, m)) }));
  const keep = TABLE_METRICS.map((_, i) => rows.some(r => r.values[i] != null));
  const t = {
    cols: TABLE_METRICS.filter((_, i) => keep[i]),
    rows: rows.map(r => ({ geo: r.geo, values: r.values.filter((_, i) => keep[i]) })).filter(r => r.values.some(v => v != null)),
  };
  if (!t.rows.length) return 0;
  buildTableCard($cards, {
    id: `yardi_table_${slug(sel.centre)}`, title: `${sel.centre} Rent, Vacancy and Turnover — ${qLabel(sel.q)}`,
    subtitle: 'As published', table: t, highlight: new Set(), source, wide: true, rowHead: 'Unit type',
  });
  return 1;
}

function buildTableCard(container, { id, title, subtitle, table, highlight, source, wide = false, rowHead = 'CMA' }) {
  const card = document.createElement('section');
  card.className = `chart-card cmhc-indicator-card${wide ? ' md:col-span-2' : ''}`;
  card.dataset.chartId = id;
  const { cols, rows } = table;
  const head = cols.map(m => `<th>${escapeHtml(COL_HEAD[m] || m)}</th>`).join('');
  const body = rows.map(r => `<tr${highlight.has(r.geo) ? ' class="font-semibold"' : ''}><td>${escapeHtml(r.geo)}</td>${
    r.values.map((v, i) => `<td>${fmtCell(METRICS[cols[i]]?.units, v)}</td>`).join('')}</tr>`).join('');
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none">
      <table class="cmhc-table cmhc-table-compact"><thead><tr><th>${escapeHtml(rowHead)}</th>${head}</tr></thead>
      <tbody>${body}</tbody></table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = `Source: ${source}`;
  // Exported at 12 pt table text and a 10 pt caption, cropped to the table's
  // height — the Cap Rates table convention (Jason, 2026-10-02).
  const CAPTION_IMAGE_PX = (10 / 72) * EXPORT_DPI;
  const TABLE_IMAGE_PX = (12 / 72) * EXPORT_DPI;
  const $scroll = card.querySelector('[data-role="plot"]');
  const $table = $scroll.querySelector('table');
  const $cells = [...$table.querySelectorAll('th, td')];
  const setTable = (px) => {
    $table.style.setProperty('font-size', `${px.toFixed(2)}px`);
    for (const c of $cells) {
      c.style.setProperty('padding', `${(px * 0.2).toFixed(2)}px ${(px * 0.5).toFixed(2)}px`);
      c.style.setProperty('line-height', '1.15');
    }
  };
  // 12 pt at the width-limited scale; a 13-CMA table is taller (or wider)
  // than the frame at that size, so shrink the text until it fits.
  const fit = () => {
    const sW = EXPORT_W / card.offsetWidth;
    $source.style.setProperty('font-size', `${(CAPTION_IMAGE_PX / sW).toFixed(2)}px`, 'important');
    let px = TABLE_IMAGE_PX / sW;
    setTable(px);
    for (let i = 0; i < 8; i++) {
      const over = Math.max((card.offsetHeight * (EXPORT_W / card.offsetWidth)) / EXPORT_H,
        $table.scrollWidth / Math.max(1, $scroll.clientWidth));
      if (over <= 1.005) break;
      px = (px / over) * 0.98;
      setTable(px);
    }
  };
  setExportCropHeight(card);
  setExportRedraw(card, (h) => {
    if (h == null) {
      $source.style.removeProperty('font-size');
      $scroll.style.removeProperty('overflow');
      $table.style.removeProperty('font-size');
      for (const c of $cells) { c.style.removeProperty('padding'); c.style.removeProperty('line-height'); }
      return;
    }
    $scroll.style.setProperty('overflow', 'visible');
    fit();
  });
  const tsv = [
    [rowHead, ...cols.map(m => COL_HEAD[m] || m)].join('\t'),
    ...rows.map(r => [r.geo, ...r.values.map((v, i) => fmtCell(METRICS[cols[i]]?.units, v))].join('\t')),
  ].join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[yardi png]', err));
  ui.cards.set(id, { card });
  return card;
}

// --- Expenses -------------------------------------------------------------------

function expenseCards($cards, sel) {
  const eq = expenseQuarter(ui.index, sel.q);
  if (!eq) return 0;
  const edition = (ui.data.editions || []).find(e => e.id === eq);
  const source = sourceFor(edition);
  const highlight = new Set(sel.centres.map(c => CMA_PROVINCE[c]).filter(Boolean));
  const monthly = eq === '2025Q3';
  const note = monthly
    ? 'Annual, per unit; the report plotted monthly figures, shown here × 12 (approximate)'
    : 'Trailing 12 months, per unit; read off the report’s chart (approximate)';
  let n = 0;
  for (const m of EXPENSE_METRICS) {
    const rows = PROVINCES.map(p => ({ prov: p, value: valueAt(ui.index, p, 'total', m, eq) }))
      .filter(r => r.value != null).sort((a, b) => b.value - a.value);
    if (!rows.length) continue;
    const title = `${METRICS[m].label === 'Total Expense' ? 'Operating Expense' : METRICS[m].label} per Unit by Province — ${qLabel(eq)}`;
    buildExpenseBarCard($cards, { id: `yardi_${m}`, title, subtitle: note, rows, highlight, source });
    n++;
  }
  // The table follows the sidebar too: the selected centres' provinces
  // (Winnipeg → Manitoba), in centre order; all provinces when none is ticked.
  const provs = [...new Set(sel.centres.map(c => CMA_PROVINCE[c]).filter(Boolean))];
  const t = {
    cols: EXPENSE_METRICS,
    rows: (provs.length ? provs : PROVINCES).map(p => ({ geo: p, values: EXPENSE_METRICS.map(m => valueAt(ui.index, p, 'total', m, eq)) }))
      .filter(r => r.values.some(v => v != null)),
  };
  if (!provs.length) t.rows.sort((a, b) => (b.values[2] ?? 0) - (a.values[2] ?? 0));
  if (t.rows.length) {
    const where = provs.length && provs.length <= 2 ? `${provs.join(' & ')} ` : '';
    buildTableCard($cards, {
      id: 'yardi_table_expense',
      title: `${where}Annual Operating Expense per Unit${where ? '' : ' by Province'} — ${qLabel(eq)}`,
      subtitle: note, table: t, highlight: provs.length ? new Set() : highlight, source, rowHead: 'Province',
    });
    n++;
  }
  return n;
}

function buildExpenseBarCard(container, { id, title, subtitle, rows, highlight, source }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div data-role="plot" style="min-height:240px"></div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions"><button type="button" data-role="dl-png">Download PNG</button></div>`;
  container.appendChild(card);
  const $plot = card.querySelector('[data-role="plot"]');
  const $source = card.querySelector('[data-role="source"]');
  const $caption = card.querySelector('.chart-caption');
  $source.textContent = `Source: ${source}`;
  let exportH = null;
  const draw = () => {
    $plot.replaceChildren();
    const width = plotWidth($plot);
    const maxV = Math.max(...rows.map(r => r.value), 0);
    // Selected centres' provinces in the second palette colour, National in
    // the third, the rest in the first — Yardi's own "highlight one bar" look.
    const colour = (p) => (highlight.has(p) && p !== 'National' ? PALETTE[1] : p === 'National' ? PALETTE[2] : PALETTE[0]);
    const svg = Plot.plot(themed({
      width,
      height: exportH ?? plotHeight(width, 340),
      marginTop: 20, marginBottom: 70, marginLeft: 60,
      x: { label: null, domain: rows.map(r => r.prov), tickRotate: -30, padding: 0.35, tickFormat: (d) => d },
      y: { label: null, domain: [0, maxV * 1.12], grid: true, tickFormat: (v) => `$${Number(v).toLocaleString('en-CA')}` },
      marks: [
        ...gridMarks(),
        Plot.barY(rows, { x: 'prov', y: 'value', fill: (d) => colour(d.prov),
          title: (d) => `${d.prov}: $${Math.round(d.value).toLocaleString('en-CA')}` }),
        Plot.text(rows, { x: 'prov', y: 'value', text: (d) => `$${Math.round(d.value).toLocaleString('en-CA')}`, dy: -7, fontSize: 10 }),
        frameMark(),
      ],
    }));
    $plot.appendChild(svg);
  };
  draw();
  fitPlotWidth($plot, draw);
  setExportRedraw(card, (h) => {
    exportH = h;
    draw();
    if (h == null) { $caption.style.removeProperty('font-size'); return; }
    for (let i = 0; i < 2; i++) {
      const scale = Math.min(EXPORT_W / card.offsetWidth, EXPORT_H / card.offsetHeight);
      $caption.style.setProperty('font-size', `${((10 / 72) * EXPORT_DPI / scale).toFixed(2)}px`, 'important');
    }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[yardi png]', err));
  ui.cards.set(id, { card });
}

// --- Excel (data) ---------------------------------------------------------------
// One sheet per visible trend chart (quarter down the side, one column per
// line), the selected quarter's tables, and every observation with its
// source (table or chart) so a reader can tell exact from approximate.

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const sel = selection();
  const range = { from: sel.from, to: sel.q };
  const on = enabledGroups();
  const used = new Set();
  const sheetName = (t) => {
    let name = t.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim();
    let n = 1;
    while (used.has(name)) name = `${name.slice(0, 25)} ${++n}`;
    used.add(name);
    return name;
  };
  const writeSeries = (title, lines) => {
    const { records, seriesMeta } = toCardInput('x', ui.index, lines, range);
    if (!records.length) return;
    const ws = wb.addWorksheet(sheetName(title));
    ws.addRow([title]).font = { bold: true };
    ws.addRow([`Source: ${sourceFor(sel.edition)}`]);
    ws.addRow([]);
    ws.addRow(['Quarter', ...seriesMeta.map(s => s.chartLabel)]).font = { bold: true };
    const byKey = new Map(records.map(r => [`${r.id}\u0000${r.date}`, r.value]));
    const dates = [...new Set(records.map(r => r.date))].sort();
    const pct = seriesMeta[0].units === 'percent';
    for (const d of dates) {
      const q = `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} ${d.slice(0, 4)}`;
      const row = ws.addRow([q, ...seriesMeta.map(s => {
        const v = byKey.get(`${s.id}\u0000${d}`);
        return v == null ? null : pct ? Math.round(v * 10) / 1000 : v;
      })]);
      if (pct) row.eachCell((c, i) => { if (i > 1 && typeof c.value === 'number') c.numFmt = '0.0%'; });
    }
    ws.getColumn(1).width = 12;
  };
  if (on.has('total') || on.has('leasing')) {
    for (const ch of CENTRE_CHARTS.filter(c => on.has(c.group))) {
      const geos = ch.withNational && sel.centre !== 'National' ? [sel.centre, 'National'] : [sel.centre];
      writeSeries(`${geos.join(' & ')} ${ch.title}`, geos.map(geo => ({ label: geo, geo, seg: 'total', metric: ch.metric })));
    }
  }
  if (on.has('bedroom')) {
    for (const ch of BEDROOM_CHARTS) {
      writeSeries(`${sel.centre} ${ch.title}`,
        sel.units.map(u => ({ label: u.label, geo: sel.centre, seg: u.id, metric: ch.metric })));
    }
  }
  const all = wb.addWorksheet('All observations');
  all.addRow(['Quarter', 'Geography', 'Segment', 'Measure', 'Value', 'Read from', 'Edition (data quarter)']).font = { bold: true };
  const segLabel = Object.fromEntries([['total', 'All units'], ...SEGMENTS.map(s => [s.id, s.label])]);
  for (const [q, geo, seg, metric, v, src, ed] of ui.data.obs) {
    if (qOrd(q) > qOrd(sel.q)) continue;
    all.addRow([qLabel(q), geo, segLabel[seg] || seg, METRICS[metric]?.label || metric, v,
      src === 't' ? 'Table (exact)' : 'Chart (approximate)', qLabel(ed)]);
  }
  [10, 28, 12, 30, 10, 20, 20].forEach((w, i) => { all.getColumn(i + 1).width = w; });
  const meta = wb.addWorksheet('About');
  meta.addRow([`${SOURCE} — parsed from the PDF editions`]);
  meta.addRow([`Selected quarter: ${qLabel(sel.q)} (${sel.edition?.cover || ''} report)`]);
  meta.addRow(['Percent values are stored as fractions (0.036 = 3.6%). Rents and expenses in dollars per unit (rent monthly, expenses annual).']);
  meta.addRow([`Exported ${new Date().toISOString().slice(0, 10)} from a locally held copy; not published with the site.`]);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `YardiRental_${sel.q}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
