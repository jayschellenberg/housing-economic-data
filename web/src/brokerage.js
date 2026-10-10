/*
 * Brokerage Reports tab — Winnipeg office, industrial, retail and hotel market
 * figures as PUBLISHED by the brokerages' market reports (Capital Group,
 * Colliers, CBRE, CBRE Hotels, Avison Young): vacancy / availability, asking
 * rents, absorption, supply and construction; hotel occupancy, ADR, RevPAR.
 * One line per publisher, never averaged: each measures differently.
 *
 * NO BROKERAGE DATA SHIPS WITH THE SITE. Brokerage-Reports/ingest/run.bat
 * parses the report PDFs into brokerage.json and publishes it to
 * SharedInfo\AppMarketData\BrokerageReports; the user nominates that folder
 * here and the browser reads it locally (brokerage-store.js), as the Johnson
 * Report and FCC Farmland tabs do.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  SOURCE, SECTORS, SECTOR_METRICS, PUBLISHER_ORDER, seriesIndex, publishersFor, areasFor, totalLines, cardInput, latestTable,
  periodLabel, coverage, years, metricLabel, unitOfMetric, fmtValue, areaLabel,
  investmentGeos, investmentSegments, investmentLines, investmentGeoLabel,
  overallCapLines, momentumGroups, segmentShort, rateComparisonInput, mergeIdenticalSeries, NEWMARK_TYPE,
  INVESTMENT_SURVEY_METRICS,
} from './brokerage-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearBrokerage,
} from './brokerage-store.js';

const PREF_KEY = 'brokerage.v1';
const DEFAULT_FROM_YEARS = 6;   // charts show this many years back when "from" is blank

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

export async function initBrokerage() {
  const $status = document.getElementById('bk-folder-status');
  const $grid = document.getElementById('bk-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('bk-folder-error'),
    $pick: document.getElementById('bk-pick-folder'),
    $pickFallback: document.getElementById('bk-pick-fallback'),
    $rescan: document.getElementById('bk-rescan'),
    $clear: document.getElementById('bk-clear'),
    $folderToggle: document.getElementById('bk-folder-toggle'),
    $folderBody: document.getElementById('bk-folder-body'),
    $sector: document.getElementById('bk-sector'),
    $viewSection: document.getElementById('bk-view-section'),
    $invSection: document.getElementById('bk-inv-section'),
    $invByCity: document.getElementById('bk-inv-by-city'),
    $invCompare: document.getElementById('bk-inv-compare'),
    $invCity: document.getElementById('bk-inv-city'),
    $invCityWrap: document.getElementById('bk-inv-city-wrap'),
    $invSegment: document.getElementById('bk-inv-segment'),
    $invSegmentWrap: document.getElementById('bk-inv-segment-wrap'),
    $viewTotals: document.getElementById('bk-view-totals'),
    $viewDetail: document.getElementById('bk-view-detail'),
    $publisher: document.getElementById('bk-publisher'),
    $publisherSection: document.getElementById('bk-publisher-section'),
    $areaSection: document.getElementById('bk-area-section'),
    $areaMenu: document.getElementById('bk-area-menu'),
    $areaToggles: document.getElementById('bk-area-toggles'),
    $areaSummary: document.getElementById('bk-area-summary-text'),
    $pubSection: document.getElementById('bk-pubs-section'),
    $pubToggles: document.getElementById('bk-pub-toggles'),
    $yearFrom: document.getElementById('bk-year-from'),
    $labels: document.getElementById('bk-value-labels'),
    $forecasts: document.getElementById('bk-forecasts'),
    $sectionMenu: document.getElementById('bk-section-menu'),
    $sections: document.getElementById('bk-section-toggles'),
    $sectionSummary: document.getElementById('bk-section-summary-text'),
    $xlsx: document.getElementById('bk-download-xlsx'),
    $empty: document.getElementById('bk-empty'),
    $about: document.getElementById('bk-about'),
    $defs: document.getElementById('bk-definitions'),
    data: null,
    idx: new Map(),
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the brokerage data locally (IndexedDB is unavailable).');
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
      if (!handle) { showError('No folder is saved yet — choose the BrokerageReports folder first.'); return; }
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
    await clearBrokerage();
    ui.data = null;
    ui.idx = new Map();
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  ui.$sector.addEventListener('change', () => { ui.prefs = savePrefs({ sector: ui.$sector.value }); renderPickers(); renderCharts(); });
  for (const $r of [ui.$viewTotals, ui.$viewDetail]) {
    $r.addEventListener('change', () => { ui.prefs = savePrefs({ view: ui.$viewDetail.checked ? 'detail' : 'totals' }); renderPickers(); renderCharts(); });
  }
  ui.$publisher.addEventListener('change', () => { ui.prefs = savePrefs({ publisher: ui.$publisher.value }); renderAreaToggles(); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: Number(ui.$yearFrom.value) || null }); renderCharts(); });
  ui.$labels.addEventListener('change', () => { ui.prefs = savePrefs({ valueLabels: ui.$labels.checked }); renderCharts(); });
  ui.$forecasts.addEventListener('change', () => { ui.prefs = savePrefs({ forecasts: ui.$forecasts.checked }); renderCharts(); });
  const setInv = (patch) => { ui.prefs = savePrefs({ inv: { ...(ui.prefs.inv || {}), ...patch } }); renderInvestmentPickers(); renderCharts(); };
  ui.$invByCity.addEventListener('change', () => setInv({ mode: 'city' }));
  ui.$invCompare.addEventListener('change', () => setInv({ mode: 'compare' }));
  ui.$invCity.addEventListener('change', () => setInv({ geo: ui.$invCity.value }));
  ui.$invSegment.addEventListener('change', () => {
    const prev = typeof ui.prefs.inv?.segment === 'object' && ui.prefs.inv.segment ? ui.prefs.inv.segment : {};
    setInv({ segment: { ...prev, [investmentSelection().type]: ui.$invSegment.value } });
  });
  document.getElementById('bk-areas-all').addEventListener('click', () => setAreasOff([]));
  document.getElementById('bk-areas-none').addEventListener('click', () => setAreasOff(currentAreas().map(a => areaKey(a))));
  document.getElementById('bk-sections-all').addEventListener('click', () => setMetricsOff([]));
  document.getElementById('bk-sections-none').addEventListener('click', () => setMetricsOff(sectorMetrics()));
  for (const $menu of [ui.$sectionMenu, ui.$areaMenu]) {
    document.addEventListener('click', (e) => { if ($menu.open && !$menu.contains(e.target)) $menu.open = false; });
    $menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $menu.open = false; $menu.querySelector('summary').focus(); } });
  }
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[brokerage excel]', err);
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
  const span = s.first && s.last ? `${periodLabel(s.first)} to ${periodLabel(s.last)}` : '';
  return `${s.editions} report editions (${span}), ${s.figures} figures, read ${when}; ` +
    (s.no_handle ? 'held in this browser only. Re-pick the folder to load an update.'
                 : 'held in this browser only. The folder is re-checked each visit.');
}
function noDataText() {
  return 'No brokerage data is published with this site. Choose the firm\'s BrokerageReports folder ' +
    '(published by Brokerage-Reports\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.idx = seriesIndex(ui.data);
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
  renderSectorPicker();
  renderPickers();
  renderCharts();
}

function renderFolderBody() {
  const collapsed = !!ui.data && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !ui.data;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

/** Sectors with Winnipeg brokerage reports. */
const WINNIPEG_SECTORS = new Set(['industrial', 'office', 'retail', 'hotel']);

/** The Newmark property type drawn in a sector, or null when it has no Newmark rates. */
function newmarkTypeFor(id) {
  const t = NEWMARK_TYPE[id];
  return t && investmentSegments(ui.idx, t).length ? t : null;
}
const newmarkType = () => newmarkTypeFor(selectedSector());

function sectorHasData(id) {
  if (id === 'multifamily') return !!newmarkTypeFor(id);
  return publishersFor(ui.idx, id).length > 0;
}

function selectedSector() {
  const ids = SECTORS.map(s => s.id).filter(sectorHasData);
  if (ids.includes(ui.prefs.sector)) return ui.prefs.sector;
  return ids[0] || SECTORS[0].id;
}
const sectorMetrics = () => SECTOR_METRICS[selectedSector()] || [];
const viewDetail = () => ui.prefs.view === 'detail';

function renderSectorPicker() {
  ui.$sector.replaceChildren();
  for (const s of SECTORS) {
    if (ui.data && !sectorHasData(s.id)) continue;
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.label;
    ui.$sector.appendChild(opt);
  }
  ui.$sector.disabled = !ui.data;
  if (ui.data) ui.$sector.value = selectedSector();
  ui.$viewDetail.checked = viewDetail();
  ui.$viewTotals.checked = !viewDetail();
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$labels.checked = !!ui.prefs.valueLabels;
  ui.$forecasts.checked = ui.prefs.forecasts !== false;
}

function selectedPublisher() {
  const pubs = publishersFor(ui.idx, selectedSector());
  return pubs.includes(ui.prefs.publisher) ? ui.prefs.publisher : (pubs[0] || '');
}

function renderPickers() {
  const sector = selectedSector();
  const pubs = publishersFor(ui.idx, sector);
  // Newmark's Canadian-city rates have their own city / class pickers; a
  // sector without Winnipeg reports (multifamily, investment trends) has no
  // Winnipeg pickers at all.
  const nmType = newmarkType();
  ui.$invSection.hidden = !ui.data || !nmType;
  if (nmType) renderInvestmentPickers();
  const winnipeg = WINNIPEG_SECTORS.has(sector);
  ui.$viewSection.hidden = !winnipeg;
  if (!winnipeg) {
    ui.$publisherSection.hidden = true;
    ui.$pubSection.hidden = true;
    ui.$areaSection.hidden = true;
    ui.$forecasts.parentElement.hidden = true;
    renderSectionToggles();
    return;
  }
  // one publisher's submarkets / classes
  ui.$publisherSection.hidden = !ui.data || !viewDetail();
  ui.$publisher.replaceChildren();
  for (const p of pubs) {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    ui.$publisher.appendChild(opt);
  }
  ui.$publisher.disabled = !pubs.length;
  if (pubs.length) ui.$publisher.value = selectedPublisher();
  // publishers on the totals view
  ui.$pubSection.hidden = !ui.data || viewDetail();
  ui.$pubToggles.replaceChildren();
  const off = new Set(pubsOff());
  for (const p of pubs) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !off.has(p);
    cb.addEventListener('change', () => {
      const next = new Set(pubsOff());
      if (cb.checked) next.delete(p); else next.add(p);
      ui.prefs = savePrefs({ pubsOff: { ...(ui.prefs.pubsOff || {}), [sector]: [...next] } });
      renderCharts();
    });
    const text = document.createElement('span'); text.textContent = p;
    label.append(cb, text);
    ui.$pubToggles.appendChild(label);
  }
  ui.$forecasts.parentElement.hidden = sector !== 'hotel';
  renderAreaToggles();
  renderSectionToggles();
}

// --- Investment rates (Newmark, Canadian cities) ------------------------------------

/** { mode, type, geo, segment } for the sector's Newmark rates, every field
 *  resolved against what the data holds. The class is remembered per type. */
function investmentSelection() {
  const p = ui.prefs.inv || {};
  const mode = p.mode === 'compare' ? 'compare' : 'city';
  const type = NEWMARK_TYPE[selectedSector()] || 'Industrial';
  const geos = investmentGeos(ui.idx);
  const geo = geos.includes(p.geo) ? p.geo : (geos[0] || 'Canada');
  const segs = investmentSegments(ui.idx, type);
  const want = typeof p.segment === 'object' && p.segment ? p.segment[type] : null;
  const segment = segs.includes(want) ? want : (segs[0] || '');
  return { mode, type, geo, segment, geos, segs };
}

function fillSelect($sel, options, value) {
  $sel.replaceChildren();
  for (const [v, label] of options) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    $sel.appendChild(opt);
  }
  if (options.length) $sel.value = value;
  $sel.disabled = !options.length;
}

function renderInvestmentPickers() {
  const sel = investmentSelection();
  ui.$invByCity.checked = sel.mode === 'city';
  ui.$invCompare.checked = sel.mode === 'compare';
  fillSelect(ui.$invCity, sel.geos.map(g => [g, investmentGeoLabel(g)]), sel.geo);
  fillSelect(ui.$invSegment, sel.segs.map(s => [s, segmentShort(s, sel.type)]), sel.segment);
  ui.$invCityWrap.hidden = sel.mode !== 'city';
  ui.$invSegmentWrap.hidden = sel.mode !== 'compare';
}

function pubsOff() {
  const off = ui.prefs.pubsOff?.[selectedSector()];
  return Array.isArray(off) ? off : [];
}

// --- Areas (one publisher's submarkets / classes) -------------------------------

const areaKey = (a) => `${a.geo}|${a.segment}`;
function currentAreas() {
  return ui.data ? areasFor(ui.idx, selectedSector(), selectedPublisher()) : [];
}
function areasOff() {
  const off = ui.prefs.areasOff?.[`${selectedSector()}|${selectedPublisher()}`];
  return Array.isArray(off) ? off : null;   // null = default (totals + the first few)
}
function setAreasOff(keys) {
  ui.prefs = savePrefs({ areasOff: { ...(ui.prefs.areasOff || {}), [`${selectedSector()}|${selectedPublisher()}`]: keys } });
  renderAreaToggles();
  renderCharts();
}
/** Default detail selection: everything up to 8 areas, else the first 8 (totals first). */
function defaultAreasOff(areas) {
  return areas.length <= 8 ? [] : areas.slice(8).map(areaKey);
}

function renderAreaToggles() {
  const areas = currentAreas();
  ui.$areaSection.hidden = !ui.data || !viewDetail() || !areas.length;
  ui.$areaToggles.replaceChildren();
  const off = new Set(areasOff() ?? defaultAreasOff(areas));
  const shown = areas.filter(a => !off.has(areaKey(a)));
  ui.$areaSummary.textContent = shown.length === areas.length ? `All (${areas.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.map(a => a.label).join(', ')
    : `${shown.length} of ${areas.length}`;
  for (const a of areas) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !off.has(areaKey(a));
    cb.addEventListener('change', () => {
      const next = new Set(areasOff() ?? defaultAreasOff(areas));
      if (cb.checked) next.delete(areaKey(a)); else next.add(areaKey(a));
      setAreasOff(areas.map(areaKey).filter(k => next.has(k)));
    });
    const text = document.createElement('span'); text.textContent = a.label;
    label.append(cb, text);
    ui.$areaToggles.appendChild(label);
  }
}

// --- Sections (metrics) ------------------------------------------------------------

function metricsOff() {
  const off = ui.prefs.metricsOff?.[selectedSector()];
  return Array.isArray(off) ? off : [];
}
function setMetricsOff(ids) {
  ui.prefs = savePrefs({ metricsOff: { ...(ui.prefs.metricsOff || {}), [selectedSector()]: ids } });
  renderSectionToggles();
  renderCharts();
}
/** Metrics with at least one figure for the selected sector. */
function availableMetrics() {
  const sector = selectedSector();
  const have = new Set();
  // Newmark's multifamily rates are stored under sector 'investment'
  const dataSector = sector === 'multifamily' ? 'investment' : sector;
  for (const s of ui.idx.values()) {
    if (s.sector === dataSector && s.points.length && (sector !== 'multifamily' || s.segment.startsWith('Multifamily '))) have.add(s.metric);
  }
  if (newmarkType()) { have.add('newmark'); have.add('rate_comparison'); }
  return sectorMetrics().filter(m => have.has(m));
}

function renderSectionToggles() {
  const ms = availableMetrics();
  const off = new Set(metricsOff());
  ui.$sections.replaceChildren();
  const shown = ms.filter(m => !off.has(m));
  ui.$sectionSummary.textContent = shown.length === ms.length ? `All sections (${ms.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.map(m => metricLabel(ui.data, m)).join(', ')
    : `${shown.length} of ${ms.length} sections`;
  for (const m of ms) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !off.has(m);
    cb.addEventListener('change', () => {
      const next = new Set(metricsOff());
      if (cb.checked) next.delete(m); else next.add(m);
      setMetricsOff(ms.filter(x => next.has(x)));
    });
    const text = document.createElement('span'); text.textContent = metricLabel(ui.data, m);
    label.append(cb, text);
    ui.$sections.appendChild(label);
  }
}

// --- Charts ------------------------------------------------------------------

/** The lines to draw: publishers' totals, or one publisher's selected areas. */
function selectedLines() {
  const sector = selectedSector();
  if (!WINNIPEG_SECTORS.has(sector)) return investmentLines(ui.idx, investmentSelection());
  if (!viewDetail()) {
    const off = new Set(pubsOff());
    return totalLines(ui.idx, sector).filter(l => !off.has(l.publisher)).map(l => ({ ...l, label: l.publisher }));
  }
  const pub = selectedPublisher();
  const areas = currentAreas();
  const off = new Set(areasOff() ?? defaultAreasOff(areas));
  return areas.filter(a => !off.has(areaKey(a))).map(a => ({ publisher: pub, geo: a.geo, segment: a.segment, label: a.label }));
}

/** Caption naming only the publishers with a line on this card (CBRE prints
 *  industrial availability, not vacancy, so it must not be cited there). */
function sourceFor(publishers) {
  const pubs = [...new Set(publishers)].sort((a, b) => pubRank(a) - pubRank(b) || a.localeCompare(b));
  if (pubs.length === 1 && pubs[0] === 'Newmark') return NEWMARK_SOURCE.survey;
  return pubs.length ? `${pubs.join(', ')} market reports` : SOURCE;
}
const NEWMARK_SOURCE = {
  survey: 'Newmark Valuation & Advisory, North American Market Survey (1Q and Mid-Year editions)',
  trends: 'Newmark Valuation & Advisory, Canadian Investment Trends Survey',
};
const pubRank = (p) => { const i = PUBLISHER_ORDER.indexOf(p); return i < 0 ? 99 : i; };

const CAVEAT = {
  ocr: 'some figures were read by OCR from an image-only PDF (CBRE 2024 Q3–Q4) — check them against the report before quoting',
  approx_map: 'node figures are read off the snapshot\'s map by position',
  headline: 'from the report\'s headline panel (rounded)',
  approx_chart: 'read off the report\'s chart (only the latest quarter is printed as a number)',
  derived: 'terminal cap rate = going-in cap rate + Newmark\'s reversion spread',
};

function cardTitle(newmark, sectorLabel, metric) {
  const m = metricLabel(ui.data, metric);
  if (!newmark) return `Winnipeg ${sectorLabel} ${m}`;
  const sel = investmentSelection();
  return sel.mode === 'compare' ? `${sel.segment} — ${m}, by city` : `${investmentGeoLabel(sel.geo)} ${sel.type} — ${m}`;
}
function sectionTitle(newmark, sectorLabel, metric) {
  if (!newmark) return `${sectorLabel} — ${metricLabel(ui.data, metric)}`;
  const sel = investmentSelection();
  const what = sel.mode === 'compare' ? sel.segment : `${investmentGeoLabel(sel.geo)} ${sel.type}`;
  return `${what} — ${metricLabel(ui.data, metric)}`;
}

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  if (!ui.data) { ui.$empty.hidden = false; ui.$about.hidden = true; return; }
  ui.$empty.hidden = true;
  ui.$about.hidden = false;
  renderDefinitions();

  const sector = selectedSector();
  const sectorLabel = SECTORS.find(s => s.id === sector)?.label || sector;
  const ys = years(ui.idx);
  const lastYear = ys[ys.length - 1] || new Date().getUTCFullYear();
  // the last six years for the quarterly Winnipeg reports; everything for the rest
  const recent = WINNIPEG_SECTORS.has(sector) && sector !== 'hotel';
  const from = ui.prefs.yearFrom || (recent ? lastYear - DEFAULT_FROM_YEARS + 1 : null);
  const ctx = { range: { from, to: null }, labels: !!ui.prefs.valueLabels, off: new Set(metricsOff()), open, drawn: [], sector, sectorLabel };

  if (WINNIPEG_SECTORS.has(sector)) {
    const view = viewDetail() ? 'detail' : 'totals';
    renderPairs(ctx, {
      dataSector: sector, lines: selectedLines(), newmark: false,
      metrics: availableMetrics().filter(m => m !== 'newmark'),
      idOf: (m) => `bk_${sector}_${m}_${view}`,
      // Office and industrial compare publishers: a statistic only one firm
      // prints has nothing to compare and is left out (Jason, 2026-10-09) —
      // except availability rate, which stands beside vacancy rate as CBRE's
      // counterpart to it, joined by any firm that also prints one (2026-10-10).
      skip: (metric, input) => !viewDetail() && (sector === 'office' || sector === 'industrial') && metric !== 'availability_rate'
        && new Set(input.seriesMeta.map(m => m.id.split(':')[1])).size < 2,
      subtitle: viewDetail() ? `${selectedPublisher()}, as published` : 'As published by each firm — definitions differ, see below',
      forecasts: sector === 'hotel' && ui.prefs.forecasts !== false,
    });
  }
  const nmType = newmarkType();
  if (nmType && !ctx.off.has('newmark')) renderNewmark(ctx, nmType);
  if (sector === 'investment') renderInvestmentExtras(ctx.off, ctx.labels, open, ctx.drawn);

  const { drawn } = ctx;
  const cov = coverageSection();
  if (cov) { $grid.appendChild(cov); drawn.push({ id: cov.id, label: 'Reports on disk' }); }
  if (drawn.length > 1) $grid.prepend(buildJumpBar(drawn));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'Nothing to show for this selection.';
    $grid.appendChild(p);
  }
}

/**
 * One chart per statistic, two to a section: both charts beside each other on
 * the first row, their latest-figures tables on the second (Jason, 2026-10-10;
 * industrial's first pair is vacancy rate / CBRE's availability rate).
 * Newmark's charts merge identical lines and draw the rest layered, so Class A
 * and Class B stay visible where they coincide.
 */
function renderPairs(ctx, { dataSector, lines, metrics, idOf, newmark, skip = () => false, subtitle, forecasts = false, tableLabel = null }) {
  const { $grid } = ui;
  let openPair = null;
  for (const metric of metrics) {
    if (ctx.off.has(metric)) continue;
    const id = idOf(metric);
    let input = cardInput(id, ui.idx, dataSector, metric, lines, ctx.range, { forecasts });
    if (!input.records.length || skip(metric, input)) continue;
    if (newmark) input = mergeIdenticalSeries(input);
    const join = !!openPair;
    const s = join ? openPair.section : document.createElement('section');
    if (!join) {
      s.className = 'cmhc-mi-section';
      s.id = `bk-section-${newmark ? 'newmark-' : ''}${metric}`;
      s.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
      s.querySelector('h2').textContent = sectionTitle(newmark, ctx.sectorLabel, metric);
    } else {
      s.querySelector('h2').textContent += ` / ${metricLabel(ui.data, metric)}`;
    }
    const $cards = s.querySelector('[data-role="cards"]');
    const unit = unitOfMetric(metric);
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title: cardTitle(newmark, ctx.sectorLabel, metric),
      sourceLabel: sourceFor(input.seriesMeta.map(m => m.id.split(':')[1])), table: true,
      // every rate and dollar axis starts at 0 (Jason, 2026-10-09: all % charts, every project)
      zeroBased: unit === 'pct' || unit === 'psf' || unit === 'cad' || unit === 'bps', mirrorY: false, sourceInCaption: true, signed: false, captionPt: 10,
    });
    const caveats = input.flags.filter(f => CAVEAT[f]).map(f => CAVEAT[f]);
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: ctx.sector === 'hotel' ? 'year' : 'quarter', subtitle: caveats.length ? `${subtitle}. Note: ${caveats.join('; ')}` : subtitle,
      singleSeriesInSubtitle: true, dashedIds: input.dashedIds, layered: newmark,
      valueLabels: ctx.labels ? { format: (v) => fmtValue(v, unit) } : null,
    });
    card.setOpenPanels(ctx.open.get(id) || []);
    ui.cards.set(id, { card: card.card });
    const $table = latestCard($cards, dataSector, metric, lines, unit, null, tableLabel);
    const jump = `${newmark && WINNIPEG_SECTORS.has(ctx.sector) ? 'Newmark: ' : ''}${metricLabel(ui.data, metric)}`;
    if (join) {
      // chart row first: move this chart ahead of the first statistic's table
      if (openPair.table) $cards.insertBefore(card.card, openPair.table);
      ctx.drawn[ctx.drawn.length - 1].label += ` / ${metricLabel(ui.data, metric)}`;
      openPair = null;
      continue;
    }
    openPair = { section: s, table: $table };
    $grid.appendChild(s);
    ctx.drawn.push({ id: s.id, label: jump });
  }
}

/**
 * Newmark's survey rates for the sector's property type (Canadian cities —
 * Newmark does not survey Winnipeg): a heading that says so inside a Winnipeg
 * sector, the cap-vs-discount charts, then one chart per statistic.
 */
function renderNewmark(ctx, type) {
  const sel = investmentSelection();
  const lines = investmentLines(ui.idx, sel);
  if (!lines.length) return;
  if (WINNIPEG_SECTORS.has(ctx.sector)) {
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = 'bk-section-newmark';
    s.innerHTML = '<h2 class="cmhc-mi-section-title"></h2><p class="text-sm text-neutral-600 max-w-3xl"></p>';
    s.querySelector('h2').textContent = `Newmark — ${type.toLowerCase()} investment rates, Canadian cities`;
    s.querySelector('p').textContent = 'Newmark Valuation & Advisory does not survey Winnipeg. Below are its going-in cap, terminal cap '
      + 'and discount rates and growth assumptions for Calgary, Edmonton, Montreal, Toronto, Vancouver and the Canada average; '
      + 'pick the city or class under "Newmark — Canadian cities" in the sidebar.';
    ui.$grid.appendChild(s);
    ctx.drawn.push({ id: s.id, label: 'Newmark (Canadian cities)' });
  }
  if (!ctx.off.has('rate_comparison')) renderRateComparison(lines, ctx.range, ctx.labels, ctx.open, ctx.drawn);
  const have = new Set();
  for (const x of ui.idx.values()) if (x.sector === 'investment' && x.segment.startsWith(`${type} `) && x.points.length) have.add(x.metric);
  renderPairs(ctx, {
    dataSector: 'investment', lines, newmark: true,
    metrics: INVESTMENT_SURVEY_METRICS.filter(m => have.has(m)),
    idOf: (m) => `bk_newmark_${type}_${m}_${sel.mode}`,
    subtitle: 'Newmark V&A survey; Q1 = 1Q edition, Q3 = Mid-Year Update',
    tableLabel: `Newmark ${type.toLowerCase()}, Canadian cities`,
  });
}

/**
 * Going-in cap, terminal cap and discount rate on one chart per survey line:
 * one card per class for a city, or per city for a class. Two to a row, like
 * the faceted charts of Jason's old R notebook (Newmark Knight Frank\R,
 * retired 2026-10-10).
 */
function renderRateComparison(lines, range, labels, open, drawn) {
  if (!lines.length) return;
  const sel = investmentSelection();
  const s = document.createElement('section');
  s.className = 'cmhc-mi-section';
  s.id = 'bk-section-rate_comparison';
  const what = sel.mode === 'compare' ? `${sel.segment}, by city` : `${investmentGeoLabel(sel.geo)} ${sel.type}, by class`;
  s.innerHTML = '<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>';
  s.querySelector('h2').textContent = `${what} — going-in cap vs terminal cap vs discount rate`;
  const $cards = s.querySelector('[data-role="cards"]');
  for (const ln of lines) {
    const id = `bk_investment_ratecmp_${ln.geo}_${ln.segment}`.replace(/[^\w]+/g, '_');
    const input = mergeIdenticalSeries({ ...rateComparisonInput(id, ui.idx, ln, range), flags: [] });
    if (!input.records.length) continue;
    const name = `${investmentGeoLabel(ln.geo)} ${ln.segment}`;
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title: `${name} — going-in cap, terminal cap and discount rate`,
      sourceLabel: NEWMARK_SOURCE.survey, table: true,
      zeroBased: true, mirrorY: false, sourceInCaption: true, signed: false, captionPt: 10,
    });
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: 'quarter',
      subtitle: 'Newmark V&A survey; Q1 = 1Q edition, Q3 = Mid-Year Update. Terminal cap = going-in + reversion spread',
      singleSeriesInSubtitle: false, dashedIds: input.dashedIds, layered: true,
      valueLabels: labels ? { format: (v) => fmtValue(v, 'pct') } : null,
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
  }
  if (!$cards.childElementCount) return;
  ui.$grid.appendChild(s);
  drawn.push({ id: s.id, label: WINNIPEG_SECTORS.has(selectedSector()) ? 'Newmark: cap vs discount rate' : 'Cap vs discount rate' });
}

/**
 * Newmark's Canadian Investment Trends Survey: the overall cap rate chart
 * (2006 on, read off the report's chart), the momentum-ratio barometers, the
 * national figures its text quotes, and its commentary.
 */
function renderInvestmentExtras(off, labels, open, drawn) {
  const { $grid } = ui;
  const newSection = (id, title) => {
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = id;
    s.innerHTML = '<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>';
    s.querySelector('h2').textContent = title;
    $grid.appendChild(s);
    drawn.push({ id, label: title });
    return s.querySelector('[data-role="cards"]');
  };

  if (!off.has('overall_cap_rate')) {
    const lines = overallCapLines(ui.idx);
    const id = 'bk_investment_overall_cap_rate';
    const input = cardInput(id, ui.idx, 'investment', 'overall_cap_rate', lines, { from: ui.prefs.yearFrom || null, to: null });
    if (input.records.length) {
      const $cards = newSection('bk-section-overall_cap_rate', 'Canada — overall cap rates, four benchmark asset classes');
      const card = buildIndicatorCard($cards, {
        chartId: id, fileStem: id, title: 'Canada — overall cap rate (OCR), four benchmark asset classes and the BoC 10-year bond',
        sourceLabel: NEWMARK_SOURCE.trends, table: true,
        zeroBased: true, mirrorY: false, sourceInCaption: true, signed: false, captionPt: 10,
      });
      const latest = ui.idx.get(`Newmark|investment|Canada|${lines[0].segment}|overall_cap_rate|`)?.points.slice(-1)[0]?.period || '';
      card.render(input.records, input.seriesMeta, {
        rangeSubtitle: 'quarter',
        subtitle: `Quarterly, read off the report's chart; the latest quarter (${periodLabel(latest)}) is the value it prints`,
        singleSeriesInSubtitle: true, dashedIds: input.seriesMeta.filter(m => /average/i.test(m.chartLabel)).map(m => m.id),
        valueLabels: labels ? { format: (v) => fmtValue(v, 'pct') } : null,
      });
      card.setOpenPanels(open.get(id) || []);
      ui.cards.set(id, { card: card.card });
      latestCard($cards, 'investment', 'overall_cap_rate', lines, 'pct', NEWMARK_SOURCE.trends);
    }
  }

  if (!off.has('momentum_ratio')) {
    const g = momentumGroups(ui.idx);
    if (g.location.length || g.type.length || g.combo.length) {
      const $cards = newSection('bk-section-momentum_ratio', 'Investor demand — momentum ratio (buy % / sell %)');
      const sub = 'Newmark\'s ratio of surveyed investors buying to those selling; positive = more buyers than sellers. Read off the report\'s bar charts; ** = not in that edition';
      for (const [key, title] of [['location', 'Momentum ratio by city, all products'], ['type', 'Momentum ratio by property type, Canada'],
        ['combo', 'Momentum ratio — top and bottom 15 city / product combinations']]) {
        if (!g[key].length) continue;
        const t = latestTable(ui.idx, 'investment', 'momentum_ratio', g[key], 4);
        buildTableCard($cards, {
          id: `bk_investment_momentum_${key}`, title, subtitle: sub,
          head: [key === 'location' ? 'City' : key === 'type' ? 'Property type' : 'City — product', ...t.periods.map(periodLabel)],
          rows: t.rows.map(r => [r.label, ...r.values.map(v => fmtValue(v, 'ratio'))]),
          source: NEWMARK_SOURCE.trends, wide: key === 'combo',
        });
      }
    }
  }

  if (!off.has('investment_volume')) {
    const rows = [];
    const want = ['investment_volume', 'availability_rate', 'leasing_sf'];
    const pts = (ui.data.obs || []).filter(o => o.publisher === 'Newmark' && want.includes(o.metric));
    if (pts.length) {
      const $cards = newSection('bk-section-investment_volume', 'Canada — national figures quoted in the report');
      const periods = [...new Set(pts.map(o => o.period))].sort().reverse();
      const keyOf = (o) => `${o.metric}|${o.segment}`;
      const series = [...new Set(pts.map(keyOf))].sort((a, b) => want.indexOf(a.split('|')[0]) - want.indexOf(b.split('|')[0]) || a.localeCompare(b));
      for (const k of series) {
        const [metric, segment] = k.split('|');
        const by = new Map(pts.filter(o => keyOf(o) === k).map(o => [o.period, o]));
        rows.push([`${metricLabel(ui.data, metric)} — ${segment}`, ...periods.map(p => (by.has(p) ? fmtValue(by.get(p).value, unitOfMetric(metric)) : ''))]);
      }
      buildTableCard($cards, {
        id: 'bk_investment_national', title: 'Investment volume, availability and leasing — Canada',
        subtitle: 'As quoted in the Investment Trends Survey\'s text (volumes by calendar year; a "year ago" figure is the one the text compares with)',
        head: ['Figure', ...periods.map(periodLabel)], rows, source: NEWMARK_SOURCE.trends, wide: true,
      });
    }
  }

  const notes = (ui.data.commentary || []).filter(c => c.publisher === 'Newmark');
  if (notes.length) {
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = 'bk-section-commentary';
    s.innerHTML = '<h2 class="cmhc-mi-section-title">Newmark commentary — Canadian Investment Trends Survey</h2>';
    const editions = [...new Set(notes.map(c => c.period))].sort().reverse();
    editions.forEach((ed, i) => {
      const wrap = document.createElement('details');
      wrap.className = 'chart-card cmhc-indicator-card mb-3';
      wrap.open = i === 0;
      const summary = document.createElement('summary');
      summary.className = 'chart-title cursor-pointer';
      summary.textContent = `${periodLabel(ed)} edition`;
      wrap.appendChild(summary);
      let lastTitle = null;
      for (const c of notes.filter(n => n.period === ed)) {
        if (c.title && c.title !== lastTitle) {
          const h = document.createElement('h3');
          h.className = 'font-semibold text-neutral-800 mt-3';
          h.textContent = c.title;
          wrap.appendChild(h);
          lastTitle = c.title;
        }
        const para = document.createElement('p');
        para.className = 'text-sm text-neutral-700 mt-1';
        if (c.heading) {
          const b = document.createElement('strong');
          b.textContent = `${c.heading}. `;
          para.appendChild(b);
        }
        para.appendChild(document.createTextNode(c.text));
        wrap.appendChild(para);
      }
      const src = document.createElement('p');
      src.className = 'text-xs text-neutral-500 mt-2';
      src.textContent = `Source: ${NEWMARK_SOURCE.trends}, ${periodLabel(ed)} — quoted verbatim.`;
      wrap.appendChild(src);
      s.appendChild(wrap);
    });
    $grid.appendChild(s);
    drawn.push({ id: s.id, label: 'Commentary' });
  }
}

/** The last six periods of each drawn line, as published. Returns the card element. */
function latestCard($cards, sector, metric, lines, unit, source = null, what = null) {
  const t = latestTable(ui.idx, sector, metric, lines, 6);
  if (!t.rows.length || !t.periods.length) return null;
  const flagged = t.rows.some(r => r.flags.some(f => f.length));
  return buildTableCard($cards, {
    id: `bk_${sector}_${metric}_latest`,
    title: `${metricLabel(ui.data, metric)} — latest published figures`,
    subtitle: `${what || SECTORS.find(s => s.id === sector)?.label || sector}; ** = not published for that period` + (flagged ? '; † read by OCR, off a map or off a chart' : ''),
    head: ['Series', ...t.periods.map(periodLabel)],
    rows: t.rows.map(r => [r.label, ...r.values.map((v, i) => fmtValue(v, unit) + (r.flags[i].length ? ' †' : ''))]),
    source: source || sourceFor(t.rows.map(r => r.publisher)),
  });
}

/** Which editions each publisher has on disk and the quarters that are missing. */
function coverageSection() {
  const rows = coverage(ui.data).filter(r => r.sector === selectedSector());
  if (!rows.length) return null;
  const s = document.createElement('section');
  s.className = 'cmhc-mi-section';
  s.id = 'bk-section-coverage';
  s.innerHTML = '<h2 class="cmhc-mi-section-title">Reports on disk</h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>';
  const qc = (ui.data.qc || []).filter(q => q.sector === selectedSector() || q.sector === 'office+industrial');
  buildTableCard(s.querySelector('[data-role="cards"]'), {
    id: 'bk_coverage',
    title: `${SECTORS.find(x => x.id === selectedSector())?.label} reports read`,
    subtitle: `Quarters with no PDF between a series' first edition and the sector's latest are listed as missing; "never published" quarters were checked on the publisher's website. ${qc.length} parser note(s) in qc_flags.csv.`,
    head: ['Publisher', 'Editions', 'First', 'Latest', 'Missing', 'Never published'],
    rows: rows.map(r => [r.publisher, String(r.editions), periodLabel(r.first), periodLabel(r.last),
      r.missing.map(periodLabel).join(', ') || '—', r.unpublished.map(periodLabel).join(', ') || '—']),
    source: 'Brokerage-Reports/ingest/parse_brokerage.py',
  });
  return s;
}

function renderDefinitions() {
  const defs = ui.data?.definitions || {};
  ui.$defs.replaceChildren();
  const pubs = publishersFor(ui.idx, selectedSector());
  if (newmarkType() && !pubs.includes('Newmark')) pubs.push('Newmark');
  for (const p of pubs) {
    if (!defs[p]) continue;
    const dt = document.createElement('dt'); dt.className = 'font-semibold text-neutral-700 mt-2'; dt.textContent = p;
    const dd = document.createElement('dd'); dd.className = 'text-neutral-700'; dd.textContent = defs[p];
    ui.$defs.append(dt, dd);
  }
}

// --- Table card (the FCC tab's, trimmed) ---------------------------------------------

function buildTableCard(container, { id, title, subtitle, head, rows, source, wide = false }) {
  const card = document.createElement('section');
  card.className = `chart-card cmhc-indicator-card${wide ? ' md:col-span-2' : ''}`;
  card.dataset.chartId = id;
  const cell = (x) => `<td>${escapeHtml(String(x))}</td>`;
  const body = rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('');
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none;min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
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
  const tsv = [head, ...rows].map(r => r.join('\t')).join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[brokerage png]', err));
  ui.cards.set(id, { card });
  return card;
}

// --- Excel (data) ----------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const d = ui.data;
  const srcById = new Map((d.sources || []).map(s => [s.id, s]));

  const ws = wb.addWorksheet('Figures');
  ws.addRow([`${SOURCE} — Winnipeg figures as published (Newmark: Canadian cities); one row per printed figure. prev_q = the prior quarter as restated in that edition; ocr = read by OCR; approx_map = read off a map; approx_chart = read off a chart; derived = terminal cap rate (going-in + reversion spread).`]);
  ws.addRow([]);
  ws.addRow(['Publisher', 'Sector', 'Period', 'Date', 'Geography', 'Segment', 'Metric', 'Label', 'Value', 'Unit', 'Flag', 'Report file', 'Page']).font = { bold: true };
  for (const o of d.obs || []) {
    ws.addRow([o.publisher, o.sector, o.period, o.date, o.geo, o.segment, o.metric, metricLabel(d, o.metric), o.value, o.unit, o.flag, srcById.get(o.src)?.file || o.src, o.page]);
  }
  [26, 12, 9, 12, 22, 16, 22, 30, 14, 7, 18, 56, 6].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(9).numFmt = '#,##0.00';

  const wr = wb.addWorksheet('Reports');
  wr.addRow(['Publisher', 'Sector', 'Period', 'File', 'Folder']).font = { bold: true };
  for (const s of d.sources || []) wr.addRow([s.publisher, s.sector, s.period, s.file, s.folder]);
  [26, 18, 9, 60, 44].forEach((w, i) => { wr.getColumn(i + 1).width = w; });

  const wm = wb.addWorksheet('Missing editions');
  wm.addRow(['Publisher', 'Sector', 'Period']).font = { bold: true };
  for (const m of d.missing || []) wm.addRow([m.publisher, m.sector, m.period]);
  [26, 14, 9].forEach((w, i) => { wm.getColumn(i + 1).width = w; });

  const wq = wb.addWorksheet('Parser notes');
  wq.addRow(['Publisher', 'Sector', 'Period', 'File', 'Note']).font = { bold: true };
  for (const q of d.qc || []) wq.addRow([q.publisher, q.sector, q.period, q.file, q.note]);
  [26, 14, 9, 50, 90].forEach((w, i) => { wq.getColumn(i + 1).width = w; });

  if ((d.commentary || []).length) {
    const wc = wb.addWorksheet('Commentary');
    wc.addRow(['Publisher', 'Edition', 'Page', 'Page title', 'Heading', 'Text (verbatim)', 'Report file']).font = { bold: true };
    for (const c of d.commentary) {
      const r = wc.addRow([c.publisher, c.period, c.page, c.title, c.heading, c.text, srcById.get(c.src)?.file || c.src]);
      r.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    }
    [12, 9, 6, 40, 14, 110, 50].forEach((w, i) => { wc.getColumn(i + 1).width = w; });
  }

  const wd = wb.addWorksheet('Definitions');
  wd.addRow(['Publisher', 'How it measures']).font = { bold: true };
  for (const [p, t] of Object.entries(d.definitions || {})) { const r = wd.addRow([p, t]); r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; }
  wd.getColumn(1).width = 28; wd.getColumn(2).width = 120;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Brokerage_Reports_Winnipeg_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export { areaLabel };
