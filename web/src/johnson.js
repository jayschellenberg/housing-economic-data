/*
 * Johnson Report tab — Winnipeg commercial vacancy, lease rates and sales
 * summaries from "The Johnson Report" (semi-annual, June / December).
 *
 * NO JOHNSON DATA SHIPS WITH THE SITE (it is copyrighted subscriber
 * material). The user parses their Word editions with
 * Johnson-Report/ingest/parse_johnson.py, which writes a `web-data/` folder,
 * and nominates that folder here. The browser reads it locally, keeps the
 * JSON in IndexedDB (johnson-store.js) and re-reads changed files on the
 * next visit. Nothing is uploaded and no other visitor sees it.
 *
 * Two views of the same data, chosen in the sidebar:
 *   - "As published": one edition's own tables — its 10-year look-back as
 *     printed — the snapshot for retrospective work.
 *   - "Long series": every edition up to the chosen one merged, latest
 *     edition wins, so June and December readings interleave into one
 *     semi-annual line back to the earliest edition's own look-back.
 *
 * Charts use the Market Indicators card (title / subtitle with source /
 * plot / source caption / PNG / data table), so exports match the rest of the
 * site. District charts can also be drawn as grouped bars, the form the
 * appraiser's existing Excel charts take.
 */

import * as Plot from '@observablehq/plot';
import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { themed, PALETTE, gridMarks, frameMark, plotWidth, plotHeight, fitPlotWidth, sfTickFormat } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { indicatorFmt } from './format.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  CHARTS, GROUPS, AGGREGATE_LABELS, chartPoints, toCardInput, allDistricts, sourceLabel,
  districtPicker, expandSelection,
  editionLabel, sortEditions, lineLabels,
} from './johnson-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getAllEditions, getManifest, clearJohnson,
} from './johnson-store.js';

const PREF_KEY = 'johnson.v1';

let ui = null;

// --- Prefs -------------------------------------------------------------------

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

export async function initJohnson() {
  const $status = document.getElementById('jr-folder-status');
  const $grid = document.getElementById('jr-chart-grid');
  if (!$status || !$grid) return;

  ui = {
    $status,
    $grid,
    $error: document.getElementById('jr-folder-error'),
    $pick: document.getElementById('jr-pick-folder'),
    $pickFallback: document.getElementById('jr-pick-fallback'),
    $rescan: document.getElementById('jr-rescan'),
    $clear: document.getElementById('jr-clear'),
    $edition: document.getElementById('jr-edition'),
    $viewRadios: [...document.querySelectorAll('input[name="jr-view"]')],
    $styleRadios: [...document.querySelectorAll('input[name="jr-style"]')],
    $districts: document.getElementById('jr-districts'),
    $districtMenu: document.getElementById('jr-district-menu'),
    $folderToggle: document.getElementById('jr-folder-toggle'),
    $folderBody: document.getElementById('jr-folder-body'),
    $districtSummary: document.getElementById('jr-district-summary-text'),
    $districtsAll: document.getElementById('jr-districts-all'),
    $districtsNone: document.getElementById('jr-districts-none'),
    $yearFrom: document.getElementById('jr-year-from'),
    $yearTo: document.getElementById('jr-year-to'),
    $sections: document.getElementById('jr-section-toggles'),
    $jump: document.getElementById('jr-jump-list'),
    $xlsx: document.getElementById('jr-download-xlsx'),
    $empty: document.getElementById('jr-empty'),
    // One "About these charts" note at the foot of the page, in place of a
    // "What does this mean?" on every card (Jason, 2026-09-30).
    $about: document.getElementById('jr-about'),
    editions: [],
    districts: [],
    cards: new Map(),      // chart id → { card, render, setOpenPanels, kind }
    prefs: loadPrefs(),
  };

  if (!storeAvailable()) {
    showError('This browser cannot store the Johnson data locally (IndexedDB is unavailable).');
    return;
  }

  wireControls();
  await loadFromStore();
  await maybeAutoRefresh();
}

function showError(msg) {
  if (!ui.$error) return;
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}

function setStatus(text) {
  ui.$status.textContent = text;
}

// --- Folder ------------------------------------------------------------------

function wireControls() {
  const { $pick, $pickFallback, $rescan, $clear } = ui;

  if (fsAccessSupported()) {
    $pick.hidden = false;
    $pickFallback.hidden = true;
    $pick.addEventListener('click', async () => {
      showError('');
      try {
        const handle = await pickDirectory();
        await runImport(handle, { force: true });
      } catch (err) {
        if (err?.name !== 'AbortError') showError(err?.message || String(err));
      }
    });
    $rescan.addEventListener('click', async () => {
      showError('');
      const handle = await getSavedDirectory();
      if (!handle) { showError('No folder is saved yet — choose the folder first.'); return; }
      const perm = await directoryPermission(handle, { request: true });
      if (perm !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle, { force: true }); }
      catch (err) { showError(err?.message || String(err)); }
    });
  } else {
    $pick.hidden = true;
    $pickFallback.hidden = false;
    $rescan.hidden = true;
    $pickFallback.addEventListener('change', async () => {
      showError('');
      try {
        setStatus('Reading…');
        const summary = await importFromFileList($pickFallback.files, { onProgress: progress });
        await loadFromStore();
        setStatus(summaryText(summary));
      } catch (err) {
        showError(err?.message || String(err));
      } finally {
        $pickFallback.value = '';
      }
    });
  }

  $clear.addEventListener('click', async () => {
    await clearJohnson();
    ui.editions = [];
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });

  // Once editions are loaded the folder controls are rarely needed: the status
  // line stays visible and the buttons + help fold away (remembered per browser).
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });

  ui.$edition.addEventListener('change', () => {
    ui.prefs = savePrefs({ edition: ui.$edition.value });
    renderCharts();
  });
  ui.$viewRadios.forEach(r => r.addEventListener('change', () => {
    if (r.checked) { ui.prefs = savePrefs({ view: r.value }); renderCharts(); }
  }));
  ui.$styleRadios.forEach(r => r.addEventListener('change', () => {
    if (r.checked) { ui.prefs = savePrefs({ style: r.value }); renderCharts(); }
  }));
  const onYear = () => {
    ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null, yearTo: ui.$yearTo.value || null });
    renderCharts();
  };
  ui.$yearFrom.addEventListener('change', onYear);
  ui.$yearTo.addEventListener('change', onYear);
  ui.$districtsAll.addEventListener('click', () => setDistricts(ui.districts));
  ui.$districtsNone.addEventListener('click', () => setDistricts([]));
  // District dropdown closes on an outside click or Esc.
  document.addEventListener('click', (e) => { if (ui.$districtMenu.open && !ui.$districtMenu.contains(e.target)) ui.$districtMenu.open = false; });
  ui.$districtMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ui.$districtMenu.open = false; ui.$districtMenu.querySelector('summary').focus(); } });

  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[johnson excel]', err);
    showError('Excel export failed: ' + (err?.message || err));
  }));
}

function progress({ done, total, label }) {
  setStatus(`Reading ${done + 1 > total ? total : done + 1} of ${total} (${label})…`);
}

async function runImport(handle, { force = false } = {}) {
  setStatus('Reading folder…');
  const summary = await importFromDirectory(handle, { onProgress: progress, force });
  await loadFromStore();
  setStatus(summaryText(summary));
}

function summaryText(s) {
  if (!s) return noDataText();
  const span = s.first && s.last ? `${s.first} to ${s.last}` : '';
  const when = s.imported_at ? new Date(s.imported_at).toLocaleString('en-CA') : '';
  return `${s.editions} edition${s.editions === 1 ? '' : 's'} loaded (${span}), read ${when}. ` +
    (s.no_handle
      ? 'Held in this browser only; re-pick the folder to load new editions.'
      : 'Held in this browser only; the folder is re-checked each visit.');
}

function noDataText() {
  return 'No Johnson Report data is published with this site. Run parse_johnson.py over your Word ' +
    'editions, then choose the web-data folder it writes. The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  const eds = (await getAllEditions()) || [];
  ui.editions = sortEditions(eds);
  ui.$clear.hidden = ui.editions.length === 0;
  const manifest = await getManifest();
  setStatus(ui.editions.length ? summaryText(manifest) : noDataText());
  renderAll();
}

/** On a return visit with a saved handle: re-import silently when the folder changed. */
async function maybeAutoRefresh() {
  if (!fsAccessSupported()) return;
  const handle = await getSavedDirectory();
  if (!handle) return;
  const perm = await directoryPermission(handle);
  if (perm === 'granted') {
    const upd = await checkForUpdates(handle);
    if (upd?.count) {
      try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); }
    }
    return;
  }
  if (perm === 'prompt') {
    // Chrome wants a click before re-granting; offer one rather than nag.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs underline text-accent-600 ml-1';
    btn.textContent = ui.editions.length ? 'Check the saved folder for new editions' : 'Re-open the saved folder';
    btn.addEventListener('click', async () => {
      btn.remove();
      const p = await directoryPermission(handle, { request: true });
      if (p !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); }
    });
    ui.$status.appendChild(btn);
  }
}

// --- Sidebar -----------------------------------------------------------------

function renderAll() {
  renderFolderBody();
  renderEditionPicker();
  renderDistrictPicker();
  renderSectionToggles();
  renderCharts();
}

function renderFolderBody() {
  // With nothing loaded the folder controls are the only way in, so never hide them.
  const loaded = ui.editions.length > 0;
  const collapsed = loaded && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !loaded;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

function renderEditionPicker() {
  const $sel = ui.$edition;
  $sel.replaceChildren();
  const eds = [...ui.editions].reverse();      // newest first
  for (const ed of eds) {
    const opt = document.createElement('option');
    opt.value = ed.id;
    opt.textContent = editionLabel(ed);
    $sel.appendChild(opt);
  }
  const want = ui.prefs.edition;
  if (want && eds.some(e => e.id === want)) $sel.value = want;
  else if (eds.length) $sel.value = eds[0].id;
  $sel.disabled = eds.length === 0;

  const view = ui.prefs.view || 'series';
  ui.$viewRadios.forEach(r => { r.checked = r.value === view; });
  const style = ui.prefs.style || 'lines';
  ui.$styleRadios.forEach(r => { r.checked = r.value === style; });
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$yearTo.value = ui.prefs.yearTo || '';
}

// Selections are stored as the report's own district names; the picker shows
// one checkbox per group of them (districtPicker). Overall / Total are not in
// the list: those lines are always drawn.
function selectedDistricts() {
  const saved = ui.prefs.districts;
  if (Array.isArray(saved)) return expandSelection(saved, ui.pickerItems || districtPicker(ui.districts));
  return ui.districts.slice();
}

function setDistricts(list) {
  ui.prefs = savePrefs({ districts: list });
  renderDistrictPicker();
  renderCharts();
}

function renderDistrictPicker() {
  ui.districts = allDistricts(ui.editions);
  ui.pickerItems = districtPicker(ui.districts);
  const chosen = new Set(selectedDistricts());
  const $box = ui.$districts;
  $box.replaceChildren();
  renderDistrictSummary();
  if (!ui.districts.length) {
    const hint = document.createElement('span');
    hint.className = 'text-xs text-neutral-500';
    hint.textContent = 'Districts appear once data is loaded.';
    $box.appendChild(hint);
    return;
  }
  for (const item of ui.pickerItems) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    if (item.members.length > 1) label.title = `Covers: ${item.members.join(', ')}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.members.some(m => chosen.has(m));
    cb.addEventListener('change', () => {
      const next = new Set(selectedDistricts());
      for (const m of item.members) { if (cb.checked) next.add(m); else next.delete(m); }
      ui.prefs = savePrefs({ districts: ui.districts.filter(x => next.has(x)) });
      renderDistrictSummary();
      renderCharts();
    });
    const text = document.createElement('span');
    text.textContent = item.label;
    label.append(cb, text);
    $box.appendChild(label);
  }
}

/** The dropdown's closed face: "All districts (12)", "3 of 12", a name or two. */
function renderDistrictSummary() {
  const items = ui.pickerItems || [];
  const chosen = new Set(selectedDistricts());
  const shown = items.filter(it => it.members.some(m => chosen.has(m))).map(it => it.label);
  ui.$districtSummary.textContent = !items.length ? 'No data'
    : shown.length === items.length ? `All districts (${items.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.join(', ')
    : `${shown.length} of ${items.length} districts`;
}

function enabledGroups() {
  const saved = ui.prefs.groups;
  if (!Array.isArray(saved)) return new Set(GROUPS.map(g => g.id));
  const on = new Set(saved);
  // Saved before Industrial vacancy + leasing merged: either one ⇒ Industrial.
  if (on.has('ind_vac') || on.has('ind_lease')) on.add('industrial');
  return on;
}

function renderSectionToggles() {
  const on = enabledGroups();
  ui.$sections.replaceChildren();
  ui.$jump.replaceChildren();
  for (const g of GROUPS) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on.has(g.id);
    cb.addEventListener('change', () => {
      const next = enabledGroups();
      if (cb.checked) next.add(g.id); else next.delete(g.id);
      ui.prefs = savePrefs({ groups: GROUPS.map(x => x.id).filter(id => next.has(id)) });
      renderCharts();
    });
    const text = document.createElement('span');
    text.textContent = g.label;
    label.append(cb, text);
    ui.$sections.appendChild(label);

    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#jr-section-${g.id}`;
    a.className = 'underline text-accent-600';
    a.textContent = g.label;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(`jr-section-${g.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(a);
    ui.$jump.appendChild(li);
  }
}

// --- Charts ------------------------------------------------------------------

function currentSelection() {
  const view = ui.prefs.view || 'series';
  const editionId = ui.$edition.value || (ui.editions.length ? ui.editions[ui.editions.length - 1].id : null);
  return { view, editionId };
}

// Charts open on the last ten years (Jason, 2026-10-01): with "from" left
// blank they start ten calendar years back from the "to" year, or from the
// selected edition's year (June 2026 → 2017–2026). The box's placeholder
// shows the year in use; typing a year overrides it, as on Cap Rates.
const DEFAULT_YEARS = 10;

function defaultYearFrom() {
  const id = ui.$edition.value || (ui.editions.length ? ui.editions[ui.editions.length - 1].id : null);
  const base = Number(ui.prefs.yearTo) || ui.editions.find(e => e.id === id)?.year;
  return base ? base - (DEFAULT_YEARS - 1) : null;
}

function monthRange() {
  const dflt = defaultYearFrom();
  ui.$yearFrom.placeholder = dflt ? String(dflt) : 'from';
  const fromYear = ui.prefs.yearFrom || dflt;
  const from = fromYear ? `${fromYear}-01` : null;
  const to = ui.prefs.yearTo ? `${ui.prefs.yearTo}-12` : null;
  return { monthFrom: from, monthTo: to };
}

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();

  if (!ui.editions.length) {
    ui.$empty.hidden = false;
    ui.$about.hidden = true;
    return;
  }
  ui.$empty.hidden = true;
  ui.$about.hidden = false;

  const sel = currentSelection();
  const source = sourceLabel(ui.editions, sel);
  const districts = selectedDistricts();
  const groupsOn = enabledGroups();
  const style = ui.prefs.style || 'lines';
  const { monthFrom, monthTo } = monthRange();
  // The subtitle is only the plotted range ("June 2000 to June 2026"); the
  // edition is in the caption's source line, and which view is on is the
  // sidebar's business (Jason, 2026-09-30).
  const drawnSections = [];

  for (const g of GROUPS) {
    if (!groupsOn.has(g.id)) continue;
    const charts = CHARTS.filter(c => c.group === g.id);
    const section = document.createElement('section');
    section.className = 'cmhc-mi-section';
    section.id = `jr-section-${g.id}`;
    section.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    section.querySelector('h2').textContent = g.label;
    const $cards = section.querySelector('[data-role="cards"]');
    let drawn = 0;

    for (const chart of charts) {
      const points = chartPoints(chart, ui.editions, sel);
      if (!points.length) continue;
      const keep = chart.district ? districts : (chart.defaultRows || null);
      const input = toCardInput(chart, points, { keep, lineOrder: chart.district ? ui.districts : (chart.lineOrder || null) });
      if (!input.records.length) continue;
      drawn++;

      if (style === 'bars' && chart.district) {
        const card = buildBarCard($cards, { chart, source });
        card.render(points, { keep: districts, monthFrom, monthTo, lineOrder: ui.districts, subtitle: chart.subtitle || '' });
        ui.cards.set(chart.id, { card: card.card, setOpenPanels: () => {} });
        continue;
      }

      const card = buildIndicatorCard($cards, {
        chartId: `johnson_${chart.id}`,
        fileStem: `johnson_${chart.id}`,
        title: displayTitle(chart),
        sourceLabel: source,
        table: true,
        zeroBased: true,
        mirrorY: false,
        // "Source: Johnson Report, <edition>" alone, bottom-right, 10 pt in
        // print; no company name on subscriber figures (as on Cap Rates).
        sourceInCaption: true, signed: false, captionPt: 10,
      });
      card.render(input.records, input.seriesMeta, {
        // Semi-annual measures name the month; annual ones only the year.
        rangeSubtitle: chart.family ? 'month' : 'year',
        // The chart's own specifics, where its title leaves them out.
        subtitle: chart.subtitle || '',
        // One line drawn → no legend; its name leads the subtitle instead.
        singleSeriesInSubtitle: true,
        dashedIds: input.dashedIds,
        monthFrom,
        monthTo,
      });
      card.setOpenPanels(open.get(chart.id) || []);
      ui.cards.set(chart.id, { card: card.card, setOpenPanels: card.setOpenPanels });
    }

    if (drawn) { $grid.appendChild(section); drawnSections.push({ id: section.id, label: g.label }); }
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));

  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'Nothing to draw for this edition, view and section selection.';
    $grid.appendChild(p);
  }
}

/** A chart's title as shown: every Johnson figure is Winnipeg's, so the card,
 *  the PNG and the Excel sheet say so — "Winnipeg Retail Vacancy by District
 *  — Total Inventory" (Jason, 2026-09-30). */
function displayTitle(chart) {
  return chart.title.startsWith('Winnipeg ') ? chart.title : `Winnipeg ${chart.title}`;
}

// --- Grouped-bar card ----------------------------------------------------------
// The form the appraiser's Excel charts take: districts along the x-axis, one
// bar per period, the last ten periods. Same chrome as the indicator card so
// the PNG and Word/Excel exports look alike.

function buildBarCard(container, { chart, source }) {
  const card = document.createElement('section');
  // Full width of the grid: a dozen districts × ten periods needs the room.
  card.className = 'chart-card cmhc-indicator-card md:col-span-2';
  card.dataset.chartId = `johnson_${chart.id}`;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(displayTitle(chart))}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot" style="min-height:240px"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No data for this selection.</div>
    <div class="chart-caption chart-caption-sourced">
      <span class="chart-source" data-role="source"></span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
  `;
  container.appendChild(card);
  const $sub = card.querySelector('[data-role="sub"]');
  const $plot = card.querySelector('[data-role="plot"]');
  const $empty = card.querySelector('[data-role="empty"]');
  const $png = card.querySelector('[data-role="dl-png"]');
  const $source = card.querySelector('[data-role="source"]');
  const $caption = card.querySelector('.chart-caption');
  const fmtV = indicatorFmt(chart.units);

  // Source alone, bottom-right, no company name — same as the line cards
  // (signed: false). 10 pt in the exported image: the card is scaled to fit
  // the 1950 × 1050 frame, so the CSS size is 10 pt at 300 DPI over that scale.
  $source.textContent = `Source: ${source}`;
  const fitCaptionForExport = (h) => {
    if (h == null) { $caption.style.removeProperty('font-size'); return; }
    for (let i = 0; i < 2; i++) {
      const scale = Math.min(EXPORT_W / card.offsetWidth, EXPORT_H / card.offsetHeight);
      $caption.style.setProperty('font-size', `${((10 / 72) * EXPORT_DPI / scale).toFixed(2)}px`, 'important');
    }
  };

  const MAX_PERIODS = 10;

  function draw(points, opts) {
    $plot.replaceChildren();
    const keep = new Set(opts.keep || []);
    let rows = points.filter(p => keep.has(p.line) || AGGREGATE_LABELS.has(p.line));
    if (opts.monthFrom) rows = rows.filter(p => p.date >= `${opts.monthFrom}-01`);
    if (opts.monthTo) rows = rows.filter(p => p.date <= `${opts.monthTo}-31`);
    const dates = [...new Set(rows.map(p => p.date))].sort().slice(-MAX_PERIODS);
    const dateSet = new Set(dates);
    rows = rows.filter(p => dateSet.has(p.date));
    if (!rows.length) {
      $sub.textContent = opts.subtitle || '';
      $empty.hidden = false; $png.disabled = true;
      return;
    }
    $empty.hidden = true; $png.disabled = false;

    const order = opts.lineOrder || [];
    const idx = new Map(order.map((l, i) => [l, i]));
    const districts = lineLabels(rows).sort((a, b) => (idx.get(a) ?? 1e9) - (idx.get(b) ?? 1e9));
    // Semi-annual measures name the season; annual ones are just the year.
    const periodLabel = (d) => {
      const [y, m] = d.split('-');
      if (!chart.family) return y;
      return m === '06' ? `Jun ${y}` : `Dec ${y}`;
    };
    const periods = dates.map(periodLabel);
    const data = rows.map(p => ({ district: p.line, period: periodLabel(p.date), value: p.value }));
    const maxV = Math.max(...data.map(d => d.value), 0);
    const width = plotWidth($plot);
    const isPct = chart.units === 'percent';
    const yDomain = [0, maxV * 1.12];
    const yTick = isPct ? (v) => `${v}%` : chart.units === 'sf' ? sfTickFormat(yDomain) : fmtV;
    const svg = Plot.plot(themed({
      width,
      height: exportH ?? plotHeight(width, 380),
      marginTop: 20, marginBottom: 70, marginLeft: 54,
      fx: { label: null, domain: districts, tickRotate: -35, padding: 0.12 },
      // No inset: the theme's 16px default per side is more than a facet is
      // wide once a dozen districts share the card, and the bars collapse to 0.
      x: { axis: null, label: null, domain: periods, inset: 0 },
      y: { label: isPct ? 'Vacancy (%)' : null, tickFormat: yTick, domain: yDomain, grid: true },
      color: { domain: periods, range: PALETTE, legend: false, label: null },
      marks: [
        ...gridMarks(),
        Plot.barY(data, { fx: 'district', x: 'period', y: 'value', fill: 'period',
          title: (d) => `${d.district} · ${d.period}: ${isPct ? d.value + '%' : fmtV(d.value)}` }),
        frameMark(),
      ],
    }));
    const legend = document.createElement('div');
    legend.className = 'cmhc-plot-legend';
    periods.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'cmhc-plot-legend-item';
      item.innerHTML = `<span class="cmhc-plot-legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span><span class="cmhc-plot-legend-text"></span>`;
      item.querySelector('.cmhc-plot-legend-text').textContent = p;
      legend.appendChild(item);
    });
    const wrap = document.createElement('div');
    wrap.className = 'cmhc-plot-wrap';
    wrap.append(svg, legend);
    $plot.appendChild(wrap);

    // Spelled out like the line cards' subtitle: "June 2016 to December 2025",
    // or "2016 to 2025" for annual measures.
    const longLabel = (d) => {
      const [y, m] = d.split('-');
      if (!chart.family) return y;
      return `${m === '06' ? 'June' : 'December'} ${y}`;
    };
    const first = longLabel(dates[0]), last = longLabel(dates[dates.length - 1]);
    const range = first === last ? first : `${first} to ${last}`;
    $sub.textContent = opts.subtitle ? `${opts.subtitle} — ${range}` : range;
    $png.onclick = () => downloadCardPng(card, `johnson_${chart.id}_bars_${new Date().toISOString().slice(0, 10)}.png`, {
      filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
    }).catch(err => console.error('[johnson png]', err));
  }

  let last = null;
  let exportH = null;
  function render(points, opts) { last = [points, opts]; draw(points, opts); }
  fitPlotWidth($plot, () => { if (last) draw(...last); });
  setExportRedraw(card, (h) => { exportH = h; if (last) draw(...last); fitCaptionForExport(h); });
  return { card, render };
}

// --- Excel (data) --------------------------------------------------------------
// One sheet per visible chart: Date down the side, one column per line. Values
// are the numbers, not formatted strings, so they compute in Excel.

async function exportData() {
  if (!ui.editions.length) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const sel = currentSelection();
  const source = sourceLabel(ui.editions, sel);
  const districts = selectedDistricts();
  const groupsOn = enabledGroups();
  const usedNames = new Set();

  for (const g of GROUPS) {
    if (!groupsOn.has(g.id)) continue;
    for (const chart of CHARTS.filter(c => c.group === g.id)) {
      const points = chartPoints(chart, ui.editions, sel);
      if (!points.length) continue;
      const keep = chart.district ? districts : (chart.defaultRows || null);
      const { records, seriesMeta } = toCardInput(chart, points, { keep, lineOrder: chart.district ? ui.districts : (chart.lineOrder || null) });
      if (!records.length) continue;
      let name = chart.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim();
      let n = 1;
      while (usedNames.has(name)) name = `${name.slice(0, 25)} ${++n}`;
      usedNames.add(name);
      const ws = wb.addWorksheet(name);
      ws.addRow([displayTitle(chart)]);
      if (chart.subtitle) ws.addRow([chart.subtitle]);
      ws.addRow([`Source: ${source}`]);
      ws.addRow([]);
      const header = ['Date', ...seriesMeta.map(s => s.chartLabel)];
      ws.addRow(header).font = { bold: true };
      const dates = [...new Set(records.map(r => r.date))].sort();
      const byKey = new Map(records.map(r => [`${r.id}\u0000${r.date}`, r.value]));
      for (const d of dates) {
        ws.addRow([d, ...seriesMeta.map(s => byKey.get(`${s.id}\u0000${d}`) ?? null)]);
      }
      ws.getColumn(1).width = 12;
      for (let c = 2; c <= header.length; c++) ws.getColumn(c).width = Math.max(12, header[c - 1].length + 2);
    }
  }
  const meta = wb.addWorksheet('About');
  meta.addRow(['The Johnson Report — Winnipeg commercial real estate summary tables']);
  meta.addRow([`View: ${sel.view === 'edition' ? 'as published in one edition' : 'long series, latest edition wins'}`]);
  meta.addRow([`Edition: ${editionLabel(ui.editions.find(e => e.id === sel.editionId))}`]);
  meta.addRow([`Exported ${new Date().toISOString().slice(0, 10)} from a locally held copy; not published with the site.`]);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `JohnsonReport_${sel.editionId}_${sel.view}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
