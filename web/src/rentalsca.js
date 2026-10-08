/*
 * Rentals.ca tab — monthly average ASKING rents for listed rental units, by
 * city, province and property type, from the Rentals.ca & Urbanation
 * National Rent Report (January 2024 on).
 *
 * NO RENTALS.CA DATA SHIPS WITH THE SITE. RentalsCa/ingest/run.bat collects
 * the reports from the Internet Archive, parses them into rentalsca.json and
 * publishes it to SharedInfo\AppMarketData\RentalData; the user nominates
 * that folder here and the browser reads it locally (rentalsca-store.js).
 *
 * Laid out like the Yardi Rental tab: a month picker that also ends the
 * charts, one centre at a time (Winnipeg by default), unit-type checkboxes,
 * a property-type
 * choice for the city figures, section toggles and one "About" note. Months
 * estimated from a neighbouring report's change columns are listed there.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { unitLineStyle } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  SOURCE, CANADA, DEFAULT_CENTRES, SEGMENTS, UNITS, UNIT_LABEL, PROPERTY_TYPES, GROUPS,
  mOrd, mLabel, reportMonth, indexObs, centreSource, valueAt, toCardInput, monthRanges, cityList, reportedMonths,
} from './rentalsca-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearRentalsCa,
} from './rentalsca-store.js';

const PREF_KEY = 'rentalsca.v1';
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

/** Re-read the store when the tab is shown again (the Rent Comparison tab can load it too). */
export function refreshRentalsCa() {
  if (ui) loadFromStore().catch(err => console.error('[rentalsca refresh]', err));
}

export async function initRentalsCa() {
  const $status = document.getElementById('rc-folder-status');
  const $grid = document.getElementById('rc-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('rc-folder-error'),
    $pick: document.getElementById('rc-pick-folder'),
    $pickFallback: document.getElementById('rc-pick-fallback'),
    $rescan: document.getElementById('rc-rescan'),
    $clear: document.getElementById('rc-clear'),
    $folderToggle: document.getElementById('rc-folder-toggle'),
    $folderBody: document.getElementById('rc-folder-body'),
    $month: document.getElementById('rc-month'),
    $yearFrom: document.getElementById('rc-year-from'),
    $segment: document.getElementById('rc-segment'),
    $centre: document.getElementById('rc-centre'),
    $units: document.getElementById('rc-units'),
    $sectionMenu: document.getElementById('rc-section-menu'),
    $sections: document.getElementById('rc-section-toggles'),
    $sectionSummary: document.getElementById('rc-section-summary-text'),
    $xlsx: document.getElementById('rc-download-xlsx'),
    $empty: document.getElementById('rc-empty'),
    $about: document.getElementById('rc-about'),
    $estimates: document.getElementById('rc-about-estimates'),
    data: null,
    index: new Map(),
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the Rentals.ca data locally (IndexedDB is unavailable).');
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
    await clearRentalsCa();
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
  document.getElementById('rc-sections-all').addEventListener('click', () => setGroups(GROUPS.map(g => g.id)));
  document.getElementById('rc-sections-none').addEventListener('click', () => setGroups([]));
  for (const $menu of [ui.$sectionMenu]) {
    document.addEventListener('click', (e) => { if ($menu.open && !$menu.contains(e.target)) $menu.open = false; });
    $menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $menu.open = false; $menu.querySelector('summary').focus(); } });
  }
  ui.$month.addEventListener('change', () => { ui.prefs = savePrefs({ month: ui.$month.value }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null }); renderCharts(); });
  ui.$segment.addEventListener('change', (e) => {
    if (e.target.name !== 'rc-segment') return;
    ui.prefs = savePrefs({ segment: e.target.value });
    renderCharts();
  });
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[rentalsca excel]', err);
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
  const span = s.first && s.last ? `${mLabel(s.first)} to ${mLabel(s.last)}` : '';
  return `${s.reports} reports (data ${span}), read ${when}; ` +
    (s.no_handle ? 'held in this browser only. Re-pick the folder to load an update.'
                 : 'held in this browser only. The folder is re-checked each visit.');
}
function noDataText() {
  return 'No Rentals.ca data is published with this site. Choose the firm\'s RentalData folder ' +
    '(published by RentalsCa\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.index = indexObs(ui.data);
  ui.cities = cityList(ui.data);
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
  renderMonthPicker();
  renderSegment();
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

function renderMonthPicker() {
  const $sel = ui.$month;
  $sel.replaceChildren();
  const ms = [...(ui.data?.months || [])].sort((a, b) => mOrd(b) - mOrd(a));
  const reported = reportedMonths(ui.data);
  for (const m of ms) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = reported.has(m) ? `${mLabel(m)} (${mLabel(reportMonth(m))} report)` : `${mLabel(m)} (estimated)`;
    $sel.appendChild(opt);
  }
  if (ui.prefs.month && ms.includes(ui.prefs.month)) $sel.value = ui.prefs.month;
  else if (ms.length) $sel.value = ms[0];
  $sel.disabled = ms.length === 0;
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$yearFrom.placeholder = ms.length ? ms[ms.length - 1].slice(0, 4) : 'year';
}

function segment() {
  return ui.prefs.segment === 'ac' ? 'ac' : 'all';
}

function renderSegment() {
  for (const r of ui.$segment.querySelectorAll('input[name="rc-segment"]')) r.checked = r.value === segment();
}

/** Canada first, then the cities by name. */
function allCentres() {
  return [CANADA, ...(ui.cities || [])];
}

/** One centre at a time (Jason, 2026-10-07); an older multi-centre pref keeps its first city. */
function selectedCentre() {
  const all = allCentres();
  const p = ui.prefs;
  if (all.includes(p.centre)) return p.centre;
  const old = Array.isArray(p.centres) ? all.find(c => p.centres.includes(c) && c !== CANADA) : null;
  return old || (all.includes(DEFAULT_CENTRES[0]) ? DEFAULT_CENTRES[0] : all[0]);
}

function renderCentrePicker() {
  ui.$centre.replaceChildren();
  for (const c of allCentres()) {
    const opt = document.createElement('option');
    const prov = ui.data?.city_province?.[c];
    opt.value = c; opt.textContent = prov ? `${c} (${prov})` : c;
    ui.$centre.appendChild(opt);
  }
  ui.$centre.disabled = !ui.data;
  if (ui.data) ui.$centre.value = selectedCentre();
}

/** Default: the three unit types the city table carries. */
const DEFAULT_UNITS = ['total', '1br', '2br'];

function selectedUnits() {
  const saved = ui.prefs.units;
  const on = new Set(Array.isArray(saved) ? saved : DEFAULT_UNITS);
  return UNITS.filter(u => on.has(u.id));
}

function renderUnitToggles() {
  const on = new Set(selectedUnits().map(u => u.id));
  ui.$units.replaceChildren();
  for (const u of UNITS) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(u.id);
    cb.addEventListener('change', () => {
      const next = new Set(selectedUnits().map(x => x.id));
      if (cb.checked) next.add(u.id); else next.delete(u.id);
      ui.prefs = savePrefs({ units: UNITS.map(x => x.id).filter(id => next.has(id)) });
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

// --- Selection ---------------------------------------------------------------

function selection() {
  const ms = ui.data?.months || [];
  const month = ui.$month.value || ms[ms.length - 1] || null;
  const from = ui.prefs.yearFrom ? `${ui.prefs.yearFrom}-01` : null;
  const centre = selectedCentre();
  // The centre's province (Winnipeg → Manitoba); Canada for Canada.
  const province = centre === CANADA ? CANADA : (ui.data?.city_province?.[centre] || null);
  return { month, from, centre, province, units: selectedUnits(), seg: segment() };
}

function sourceFor(month) {
  if (!month) return SOURCE;
  const reported = reportedMonths(ui.data).has(month);
  return reported ? `${SOURCE}, ${mLabel(reportMonth(month))}` : SOURCE;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// --- Charts ------------------------------------------------------------------

// Units the city table carries (Rentals.ca publishes no city studio / 3-bed).
const CITY_UNITS = new Set(['total', '1br', '2br']);

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
  const source = sourceFor(sel.month);
  const range = { from: sel.from, to: sel.month };
  const on = enabledGroups();
  const drawnSections = [];
  const derived = [];

  // byUnit: a unit-type breakdown, coloured and dashed as on the CMHC tabs.
  const lineCard = ($cards, id, { title, subtitle = '', lines, units, byUnit = false }) => {
    const input = toCardInput(id, ui.index, lines.map(l => ({ ...l, units })), range);
    if (!input.records.length) return false;
    for (const d of input.derived) derived.push(...d.months);
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title, sourceLabel: source, table: true,
      // Y from 0 (or below, if a series dips negative) — Jason, 2026-10-07.
      zeroBased: true, mirrorY: false,
      sourceInCaption: true, signed: false, captionPt: 10,
    });
    const unitOf = new Map(lines.map(l => [`${id}:${l.label}`, l.unit]));
    const style = byUnit ? unitLineStyle(input.seriesMeta, (sid) => unitOf.get(sid)) : { dashedIds: [] };
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: 'month', subtitle, singleSeriesInSubtitle: true, ...style,
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
    return true;
  };

  for (const g of GROUPS) {
    if (!on.has(g.id)) continue;
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = `rc-section-${g.id}`;
    s.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    s.querySelector('h2').textContent = g.id === 'city' ? `${g.label} — ${SEGMENTS[sel.seg]}` : g.label;
    const $cards = s.querySelector('[data-role="cards"]');
    let drawn = 0;

    if (g.id === 'city') {
      // One chart per measure, a line per ticked unit type (Jason, 2026-10-07).
      const cityUnits = sel.units.filter(u => CITY_UNITS.has(u.id));
      for (const [id, metric, title, units] of [['rent', 'rent', 'Average Asking Rent', 'dollar'],
                                                ['yoy', 'yoy', 'Asking Rent Change, Year over Year', 'percent']]) {
        const lines = cityUnits.map(u => ({ label: u.label, ...centreSource(sel.centre, sel.seg), unit: u.id, metric }));
        if (lineCard($cards, `rentalsca_${id}_${sel.seg}_${slug(sel.centre)}`, {
          title: `${sel.centre} ${title}`, subtitle: SEGMENTS[sel.seg], lines, units, byUnit: true,
        })) drawn++;
      }
    } else if (g.id === 'province' && sel.province) {
      // Apartments & condos: the one province series that runs from 2024.
      for (const [id, metric, title, units] of [['rent', 'rent', 'Average Asking Rent', 'dollar'],
                                                ['yoy', 'yoy', 'Asking Rent Change, Year over Year', 'percent']]) {
        const lines = sel.units.map(u => ({ label: u.label, level: 'province', geo: sel.province, seg: 'ac', unit: u.id, metric }));
        if (lineCard($cards, `rentalsca_prov_${id}_${slug(sel.province)}`, {
          title: `${sel.province} ${title}`, subtitle: SEGMENTS.ac, lines, units, byUnit: true,
        })) drawn++;
      }
    } else if (g.id === 'national') {
      for (const u of sel.units.filter(x => CITY_UNITS.has(x.id))) {
        const lines = PROPERTY_TYPES.map(t => ({ label: t.label, level: 'national', geo: CANADA, seg: t.id, unit: u.id, metric: 'rent' }));
        const what = u.id === 'total' ? 'Average Asking Rent' : `${u.label} Asking Rent`;
        if (lineCard($cards, `rentalsca_nat_${u.id}`, { title: `Canada ${what} by Property Type`, lines, units: 'dollar' })) drawn++;
      }
    } else if (g.id === 'tables') {
      drawn += monthTables($cards, sel, source);
    }
    if (drawn) { $grid.appendChild(s); drawnSections.push({ id: s.id, label: g.label }); }
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = sel.units.length ? 'Nothing to draw for this month and section selection.' : 'No unit types ticked.';
    $grid.appendChild(p);
  }
  renderEstimateNote(derived);
}

function renderEstimateNote(derived) {
  const $n = ui.$estimates;
  $n.replaceChildren();
  const reported = reportedMonths(ui.data);
  const noReport = (ui.data?.months || []).filter(m => !reported.has(m));
  const parts = [];
  if (noReport.length) {
    parts.push(`No report table survives for ${monthRanges(noReport)}. Those months are estimated from the next report's month-over-month change or the following year's year-over-year change, so they are approximate (to within a few dollars).`);
  }
  const other = derived.filter(m => reported.has(m));
  if (other.length) {
    parts.push(`A centre missing from a month's table (for example Winnipeg in January 2025) is estimated the same way: ${monthRanges(other)} on the charts shown.`);
  }
  for (const t of parts) {
    const p = document.createElement('p');
    p.textContent = t;
    $n.appendChild(p);
  }
}

// --- Month tables --------------------------------------------------------------

const fmtMoney = (p) => (p ? `$${Math.round(p.v).toLocaleString('en-CA')}${p.src === 'd' ? '*' : ''}` : MISSING);
const fmtPct = (p) => (p ? `${p.v.toFixed(1)}%` : MISSING);

/**
 * One table for the centre and month, laid out as Jason asked (2026-10-07):
 * a row for the centre (the chosen property types) and a row for its
 * province (apartments & condos); a column group per ticked unit type —
 * 1-BR, 2-BR … with All units last — each with the rent, M/M and Y/Y.
 * Rentals.ca publishes M/M for cities only; Canada's and the provinces' M/M
 * are computed from consecutive months' published rents (parser src "c").
 */
function monthTables($cards, sel, source) {
  const m = sel.month;
  const units = [...sel.units.filter(u => u.id !== 'total'), ...sel.units.filter(u => u.id === 'total')];
  const places = [{ label: sel.centre, spec: centreSource(sel.centre, sel.seg), cityOnly: true }];
  // Canada's centre row already is the national figure; a second Canada row
  // (apartments & condos) only adds something when the segment differs.
  if (sel.province && !(sel.province === CANADA && sel.seg === 'ac')) {
    places.push({ label: sel.province === CANADA && sel.centre === CANADA ? `${CANADA} (apartments & condos)` : sel.province,
      spec: { level: 'province', geo: sel.province, seg: 'ac' } });
  }
  const at = (pl, unit, metric) => (pl.cityOnly && !CITY_UNITS.has(unit) ? null : valueAt(ui.index, { ...pl.spec, unit, metric }, m));
  const SUB = ['rent', 'mom', 'yoy'];
  const fmt = (metric, p) => (metric === 'rent' ? fmtMoney(p) : fmtPct(p));
  const rows = places.map(pl => [pl.label, ...units.flatMap(u => SUB.map(mt => fmt(mt, at(pl, u.id, mt))))])
    .filter(r => r.slice(1).some(x => x !== MISSING));
  const span = SUB.length;
  const cells = (r, i) => r.slice(1 + span * i, 1 + span * (i + 1));
  const cols = units.map((u, i) => ({ u, i })).filter(({ i }) => rows.some(r => cells(r, i).some(x => x !== MISSING)));
  if (!rows.length || !cols.length) return 0;
  const keep = (r) => [r[0], ...cols.flatMap(({ i }) => cells(r, i))];
  const short = (u) => u.label.replace('-Bedroom', '-BR');
  buildTableCard($cards, {
    id: `rentalsca_table_${slug(sel.centre)}`,
    title: `${sel.centre} Average Asking Rents — ${mLabel(m)}`,
    subtitle: places.length > 1 ? `${sel.centre}: ${SEGMENTS[sel.seg].toLowerCase()}; ${places[1].label}: ${SEGMENTS.ac.toLowerCase()}` : SEGMENTS[sel.seg],
    groups: cols.map(({ u }) => short(u)),
    head: ['', ...cols.flatMap(() => ['Rent', 'M/M', 'Y/Y'])],
    rows: rows.map(keep), source, wide: true,
  });
  return 1;
}

function buildTableCard(container, { id, title, subtitle, head, rows, source, wide = false, groups = null }) {
  const card = document.createElement('section');
  card.className = `chart-card cmhc-indicator-card${wide ? ' md:col-span-2' : ''}`;
  card.dataset.chartId = id;
  const estimated = rows.some(r => r.some(x => /\d\*$/.test(String(x))));  // "$1,409*", not the "**" no-figure mark
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}${estimated ? '; * estimated' : ''}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none;min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead>${groups
        // A column group per unit type over its Rent / Y/Y pair.
        ? `<tr><th rowspan="2"></th>${groups.map(g => `<th colspan="${(head.length - 1) / groups.length}">${escapeHtml(g)}</th>`).join('')}</tr><tr>${head.slice(1).map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
        : `<tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`}</thead>
      <tbody>${rows.map(r => `<tr>${r.map(x => `<td>${escapeHtml(String(x))}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = `Source: ${source}`;
  // 12 pt table text and a 10 pt caption in the 1950 px PNG, cropped to the
  // table, shrinking only if a long centre list will not fit (as on Yardi).
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
  // Copied headers name the group too: "1-BR Rent", "1-BR Y/Y".
  const per = groups ? (head.length - 1) / groups.length : 1;
  const flatHead = groups ? [head[0], ...head.slice(1).map((h, i) => `${groups[Math.floor(i / per)]} ${h}`)] : head;
  const tsv = [flatHead, ...rows].map(r => r.join('\t')).join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[rentalsca png]', err));
  ui.cards.set(id, { card });
}

// --- Excel (data) ----------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const sel = selection();
  const segLabel = { ...SEGMENTS, apt: 'Purpose-built apartments', condo: 'Condo apartments', house: 'Houses & townhouses' };
  const metricLabel = { rent: 'Average asking rent', mom: 'Change, month over month', yoy: 'Change, year over year' };
  const ws = wb.addWorksheet('Observations');
  ws.addRow([`${SOURCE} — to ${mLabel(sel.month)}`]).font = { bold: true };
  ws.addRow(['Rents in dollars per month; changes in percent. "Estimated" = worked out from a neighbouring report\'s change columns; "Computed" = M/M for Canada and the provinces, from two months\' published rents.']);
  ws.addRow([]);
  ws.addRow(['Month', 'Level', 'Geography', 'Property types', 'Unit', 'Measure', 'Value', 'Read from', 'Report']).font = { bold: true };
  for (const [m, geo, level, seg, unit, metric, v, src, rep] of ui.data.obs) {
    if (mOrd(m) > mOrd(sel.month)) continue;
    ws.addRow([mLabel(m), level, geo, segLabel[seg] || seg, UNIT_LABEL[unit] || unit, metricLabel[metric] || metric, v,
      src === 't' ? 'Report table' : src === 'c' ? 'Computed from report rents' : 'Estimated',
      rep ? `${mLabel(reportMonth(rep))} report` : '']);
  }
  [16, 10, 26, 26, 12, 26, 10, 14, 22].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `RentalsCa_${sel.month}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
