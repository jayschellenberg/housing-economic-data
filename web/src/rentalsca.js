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
 * charts, a centre checklist (Winnipeg + Canada by default), a property-type
 * choice for the city figures, section toggles and one "About" note. Months
 * estimated from a neighbouring report's change columns are listed there.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
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
    $centreMenu: document.getElementById('rc-centre-menu'),
    $centres: document.getElementById('rc-centres'),
    $centreSummary: document.getElementById('rc-centre-summary-text'),
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
  document.getElementById('rc-centres-all').addEventListener('click', () => setCentres(allCentres()));
  document.getElementById('rc-centres-none').addEventListener('click', () => setCentres([]));
  document.getElementById('rc-sections-all').addEventListener('click', () => setGroups(GROUPS.map(g => g.id)));
  document.getElementById('rc-sections-none').addEventListener('click', () => setGroups([]));
  for (const $menu of [ui.$centreMenu, ui.$sectionMenu]) {
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

function selectedCentres() {
  const saved = ui.prefs.centres;
  const all = allCentres();
  return Array.isArray(saved) ? all.filter(c => saved.includes(c)) : DEFAULT_CENTRES.filter(c => all.includes(c));
}

function setCentres(list) {
  ui.prefs = savePrefs({ centres: allCentres().filter(c => list.includes(c)) });
  renderCentrePicker();
  renderCharts();
}

function renderCentrePicker() {
  const chosen = new Set(selectedCentres());
  ui.$centres.replaceChildren();
  for (const c of allCentres()) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = chosen.has(c);
    cb.addEventListener('change', () => {
      const next = new Set(selectedCentres());
      if (cb.checked) next.add(c); else next.delete(c);
      setCentres([...next]);
    });
    const text = document.createElement('span');
    const prov = ui.data?.city_province?.[c];
    text.textContent = prov ? `${c} (${prov})` : c;
    label.append(cb, text);
    ui.$centres.appendChild(label);
  }
  const shown = orderedCentres([...chosen]);
  const total = allCentres().length;
  ui.$centreSummary.textContent = !ui.data ? 'No data'
    : shown.length === total ? `All centres (${total})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.join(', ')
    : `${shown.length} of ${total} centres`;
}

/** Cities first (Winnipeg takes the first colour), Canada last as the benchmark. */
function orderedCentres(list) {
  const set = new Set(list);
  return [...allCentres().filter(c => c !== CANADA && set.has(c)), ...(set.has(CANADA) ? [CANADA] : [])];
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
  const centres = orderedCentres(selectedCentres());
  // Provinces of the chosen cities (Winnipeg → Manitoba), then Canada.
  const provinces = [...new Set(centres.filter(c => c !== CANADA).map(c => ui.data?.city_province?.[c]).filter(Boolean))];
  return { month, from, centres, provinces, seg: segment() };
}

function sourceFor(month) {
  if (!month) return SOURCE;
  const reported = reportedMonths(ui.data).has(month);
  return reported ? `${SOURCE}, ${mLabel(reportMonth(month))}` : SOURCE;
}

function centreTitle(title, centres) {
  if (centres.length === 1) return `${centres[0]} ${title}`;
  if (centres.length === 2) return `${centres[0]} & ${centres[1]} ${title}`;
  return title;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// --- Charts ------------------------------------------------------------------

const CENTRE_CHARTS = [
  { id: '1br', unit: '1br', metric: 'rent', title: '1-Bedroom Average Asking Rent', units: 'dollar' },
  { id: '2br', unit: '2br', metric: 'rent', title: '2-Bedroom Average Asking Rent', units: 'dollar' },
  { id: 'total', unit: 'total', metric: 'rent', title: 'Average Asking Rent, All Units', units: 'dollar' },
  { id: '1br_yoy', unit: '1br', metric: 'yoy', title: '1-Bedroom Asking Rent Change, Year over Year', units: 'percent' },
  { id: '2br_yoy', unit: '2br', metric: 'yoy', title: '2-Bedroom Asking Rent Change, Year over Year', units: 'percent' },
];

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

  const lineCard = ($cards, id, { title, subtitle = '', lines, units }) => {
    const input = toCardInput(id, ui.index, lines.map(l => ({ ...l, units })), range);
    if (!input.records.length) return false;
    for (const d of input.derived) derived.push(...d.months);
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title, sourceLabel: source, table: true,
      zeroBased: false, mirrorY: false,
      sourceInCaption: true, signed: false, captionPt: 10,
    });
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: 'month', subtitle, singleSeriesInSubtitle: true, dashedIds: [],
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
      for (const ch of CENTRE_CHARTS) {
        const lines = sel.centres.map(c => ({ label: c, ...centreSource(c, sel.seg), unit: ch.unit, metric: ch.metric }));
        if (lineCard($cards, `rentalsca_${ch.id}_${sel.seg}`, {
          title: centreTitle(ch.title, sel.centres), subtitle: SEGMENTS[sel.seg], lines, units: ch.units,
        })) drawn++;
      }
    } else if (g.id === 'province') {
      // Apartments & condos: the one province series that runs from 2024.
      for (const p of [...sel.provinces, CANADA]) {
        const lines = UNITS.map(u => ({ label: u.label, level: 'province', geo: p, seg: 'ac', unit: u.id, metric: 'rent' }));
        if (lineCard($cards, `rentalsca_prov_${slug(p)}`, {
          title: `${p} Average Asking Rent by Unit Type`, subtitle: SEGMENTS.ac, lines, units: 'dollar',
        })) drawn++;
      }
      const yoy = [...sel.provinces, CANADA].map(p => ({ label: p, level: 'province', geo: p, seg: 'ac', unit: 'total', metric: 'yoy' }));
      if (lineCard($cards, 'rentalsca_prov_yoy', {
        title: 'Asking Rent Change by Province, Year over Year', subtitle: `${SEGMENTS.ac}, all units`, lines: yoy, units: 'percent',
      })) drawn++;
    } else if (g.id === 'national') {
      for (const [id, unit, title] of [['total', 'total', 'Canada Average Asking Rent by Property Type'],
                                       ['1br', '1br', 'Canada 1-Bedroom Asking Rent by Property Type'],
                                       ['2br', '2br', 'Canada 2-Bedroom Asking Rent by Property Type']]) {
        const lines = PROPERTY_TYPES.map(t => ({ label: t.label, level: 'national', geo: CANADA, seg: t.id, unit, metric: 'rent' }));
        if (lineCard($cards, `rentalsca_nat_${id}`, { title, lines, units: 'dollar' })) drawn++;
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
    p.textContent = sel.centres.length ? 'Nothing to draw for this month and section selection.' : 'No centres selected.';
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

function monthTables($cards, sel, source) {
  let n = 0;
  const m = sel.month;
  // City table: only the sidebar's centres (as on the Yardi tab).
  const cityRows = sel.centres.map(c => {
    const at = (unit, metric) => valueAt(ui.index, { ...centreSource(c, sel.seg), unit, metric }, m);
    return [c, fmtMoney(at('1br', 'rent')), fmtPct(at('1br', 'mom')), fmtPct(at('1br', 'yoy')),
      fmtMoney(at('2br', 'rent')), fmtPct(at('2br', 'mom')), fmtPct(at('2br', 'yoy')), fmtMoney(at('total', 'rent'))];
  }).filter(r => r.slice(1).some(x => x !== MISSING));
  if (cityRows.length) {
    buildTableCard($cards, {
      id: `rentalsca_table_city_${sel.seg}`,
      title: `${centreTitle('Average Asking Rents', sel.centres)} — ${mLabel(m)}`,
      subtitle: SEGMENTS[sel.seg],
      head: ['Centre', '1-Bed', 'M/M', 'Y/Y', '2-Bed', 'M/M', 'Y/Y', 'All Units'],
      rows: cityRows, source, wide: true,
    });
    n++;
  }
  const provRows = [...sel.provinces, CANADA].map(p => {
    const at = (unit, metric) => valueAt(ui.index, { level: 'province', geo: p, seg: 'ac', unit, metric }, m);
    return [p, ...UNITS.map(u => fmtMoney(at(u.id, 'rent'))), fmtPct(at('total', 'yoy'))];
  }).filter(r => r.slice(1).some(x => x !== MISSING));
  if (provRows.length) {
    buildTableCard($cards, {
      id: 'rentalsca_table_province',
      title: `Average Asking Rents by Province and Unit Type — ${mLabel(m)}`,
      subtitle: SEGMENTS.ac,
      head: ['Province', ...UNITS.map(u => u.label), 'Y/Y (all units)'],
      rows: provRows, source, wide: true,
    });
    n++;
  }
  return n;
}

function buildTableCard(container, { id, title, subtitle, head, rows, source, wide = false }) {
  const card = document.createElement('section');
  card.className = `chart-card cmhc-indicator-card${wide ? ' md:col-span-2' : ''}`;
  card.dataset.chartId = id;
  const estimated = rows.some(r => r.some(x => /\d\*$/.test(String(x))));  // "$1,409*", not the "**" no-figure mark
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}${estimated ? '; * estimated' : ''}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
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
  const tsv = [head, ...rows].map(r => r.join('\t')).join('\n');
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
  ws.addRow(['Rents in dollars per month; changes in percent. "Estimated" = worked out from a neighbouring report\'s change columns.']);
  ws.addRow([]);
  ws.addRow(['Month', 'Level', 'Geography', 'Property types', 'Unit', 'Measure', 'Value', 'Read from', 'Report']).font = { bold: true };
  for (const [m, geo, level, seg, unit, metric, v, src, rep] of ui.data.obs) {
    if (mOrd(m) > mOrd(sel.month)) continue;
    ws.addRow([mLabel(m), level, geo, segLabel[seg] || seg, UNIT_LABEL[unit] || unit, metricLabel[metric] || metric, v,
      src === 't' ? 'Report table' : 'Estimated', rep ? `${mLabel(reportMonth(rep))} report` : '']);
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
