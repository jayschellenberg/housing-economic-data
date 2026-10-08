/*
 * Rent Comparison tab — one centre's rents from three sources on one chart
 * per unit type:
 *   Rentals.ca  average ASKING rent of units listed that month
 *   Yardi       average IN-PLACE rent of professionally managed apartments
 *   CMHC        Rental Market Survey average rent, purpose-built apartments
 * Asking rents run above in-place rents (new tenancies re-price to market),
 * and CMHC's survey of the whole purpose-built stock sits lowest — the gap
 * is the point of the chart (Jason, 2026-10-07).
 *
 * Rentals.ca and Yardi come from the shared RentalData folder (rentalsca.json
 * + yardi.json, read through the two tabs' own stores); CMHC from the site's
 * own series shards. No Rentals.ca or Yardi data ships with the site.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { PALETTE } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import {
  CENTRES, UNITS, DEFAULT_UNITS, SOURCES, rentalsCaPoints, yardiPoints, cmhcPoints, since, asOfLabel,
  reportParagraphs, latestBySource,
} from './rent-compare-data.js';
import * as rcStore from './rentalsca-store.js';
import * as ydStore from './yardi-store.js';

const PREF_KEY = 'rentcompare.v1';
const MISSING = '**';
const DEFAULT_FROM_YEAR = 2023;
// One colour per source on every chart: Rentals.ca red, Yardi navy, CMHC green.
const SOURCE_COLOURS = { rc: PALETTE[1], yardi: PALETTE[0], cmhc: PALETTE[2] };
const FREQ = { rc: 'monthly', yardi: 'quarterly', cmhc: 'annual' };

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

/**
 * Re-read both stores each time the tab is shown: the folder may have been
 * loaded (or updated) on the Yardi Rental or Rentals.ca tab since.
 */
export function refreshRentCompare() {
  if (ui) loadFromStores().catch(err => console.error('[rent-compare refresh]', err));
}

export async function initRentCompare({ loadShard }) {
  const $grid = document.getElementById('rx-chart-grid');
  if (!$grid) return;
  ui = {
    $grid, loadShard,
    $status: document.getElementById('rx-folder-status'),
    $error: document.getElementById('rx-folder-error'),
    $pick: document.getElementById('rx-pick-folder'),
    $pickFallback: document.getElementById('rx-pick-fallback'),
    $rescan: document.getElementById('rx-rescan'),
    $centre: document.getElementById('rx-centre'),
    $units: document.getElementById('rx-units'),
    $segment: document.getElementById('rx-segment'),
    $yearFrom: document.getElementById('rx-year-from'),
    $xlsx: document.getElementById('rx-download-xlsx'),
    $report: document.getElementById('rx-download-report'),
    $empty: document.getElementById('rx-empty'),
    $about: document.getElementById('rx-about'),
    rc: null, yd: null, shards: new Map(),
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!rcStore.storeAvailable()) { showError('This browser cannot store the data locally (IndexedDB is unavailable).'); return; }
  wireControls();
  renderSidebar();
  await loadFromStores();
}

function showError(msg) { ui.$error.textContent = msg || ''; ui.$error.hidden = !msg; }

// --- Folder ------------------------------------------------------------------
// One pick loads both files: the RentalData folder holds rentalsca.json and
// yardi.json, and each is kept in its own tab's store (so the Yardi Rental
// and Rentals.ca tabs see it too).

async function importBoth(handle) {
  const out = [];
  for (const [name, store] of [['Rentals.ca', rcStore], ['Yardi', ydStore]]) {
    try { await store.importFromDirectory(handle, { force: true }); }
    catch (err) { out.push(`${name}: ${err?.message || err}`); }
  }
  return out;
}

function wireControls() {
  if (rcStore.fsAccessSupported()) {
    ui.$pick.hidden = false; ui.$pickFallback.hidden = true;
    ui.$pick.addEventListener('click', async () => {
      showError('');
      try {
        const handle = await rcStore.pickDirectory();
        const errs = await importBoth(handle);
        if (errs.length) showError(errs.join(' '));
        await loadFromStores();
      } catch (err) { if (err?.name !== 'AbortError') showError(err?.message || String(err)); }
    });
    ui.$rescan.addEventListener('click', async () => {
      showError('');
      const handle = await rcStore.getSavedDirectory();
      if (!handle) { showError('No folder is saved yet — choose the RentalData folder first.'); return; }
      if ((await rcStore.directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      const errs = await importBoth(handle);
      if (errs.length) showError(errs.join(' '));
      await loadFromStores();
    });
  } else {
    ui.$pick.hidden = true; ui.$pickFallback.hidden = false; ui.$rescan.hidden = true;
    ui.$pickFallback.addEventListener('change', async () => {
      showError('');
      const errs = [];
      for (const [name, store] of [['Rentals.ca', rcStore], ['Yardi', ydStore]]) {
        try { await store.importFromFileList(ui.$pickFallback.files); } catch (err) { errs.push(`${name}: ${err?.message || err}`); }
      }
      if (errs.length) showError(errs.join(' '));
      ui.$pickFallback.value = '';
      await loadFromStores();
    });
  }
  ui.$centre.addEventListener('change', () => { ui.prefs = savePrefs({ centre: ui.$centre.value }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null }); renderCharts(); });
  ui.$segment.addEventListener('change', (e) => {
    if (e.target.name !== 'rx-segment') return;
    ui.prefs = savePrefs({ segment: e.target.value });
    renderCharts();
  });
  ui.$report?.addEventListener('click', () => exportReport().catch(err => {
    console.error('[rent-compare report]', err);
    showError('Word export failed: ' + (err?.message || err));
  }).finally(() => { ui.$report.disabled = false; ui.$report.textContent = 'Download Word (report section)'; }));
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[rent-compare excel]', err);
    showError('Excel export failed: ' + (err?.message || err));
  }));
}

async function loadFromStores() {
  [ui.rc, ui.yd] = await Promise.all([rcStore.getData(), ydStore.getData()]);
  const have = [ui.rc ? 'Rentals.ca' : null, ui.yd ? 'Yardi' : null].filter(Boolean);
  const missing = [ui.rc ? null : 'Rentals.ca', ui.yd ? null : 'Yardi'].filter(Boolean);
  ui.$status.textContent = have.length
    ? `Loaded: ${have.join(' and ')}${missing.length ? `. Missing: ${missing.join(' and ')} (choose the RentalData folder).` : '.'} CMHC comes with the site.`
    : 'No Rentals.ca or Yardi data is loaded. Choose the firm\'s RentalData folder (it holds both files); read locally, never uploaded.';
  await renderCharts();
}

// --- Sidebar -----------------------------------------------------------------

function selectedCentre() {
  return CENTRES.find(c => c.id === ui.prefs.centre) || CENTRES[0];
}
function selectedUnits() {
  const on = new Set(Array.isArray(ui.prefs.units) ? ui.prefs.units : DEFAULT_UNITS);
  return UNITS.filter(u => on.has(u.id));
}
const segment = () => (ui.prefs.segment === 'ac' ? 'ac' : 'all');

function renderSidebar() {
  ui.$centre.replaceChildren();
  for (const c of CENTRES) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.id;
    ui.$centre.appendChild(opt);
  }
  ui.$centre.value = selectedCentre().id;
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
  for (const r of ui.$segment.querySelectorAll('input[name="rx-segment"]')) r.checked = r.value === segment();
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$yearFrom.placeholder = String(DEFAULT_FROM_YEAR);
}

// --- Data --------------------------------------------------------------------

async function cmhcShard(centre) {
  if (!centre.cmhc) return null;
  if (!ui.shards.has(centre.cmhc)) ui.shards.set(centre.cmhc, ui.loadShard('cma', centre.cmhc));
  return ui.shards.get(centre.cmhc);
}

/** { rc, yardi, cmhc } point lists for one centre and unit. */
function sourcePoints(centre, unit, shard) {
  return {
    rc: rentalsCaPoints(ui.rc, centre, unit, segment()),
    yardi: yardiPoints(ui.yd, centre, unit),
    cmhc: cmhcPoints(shard, unit),
  };
}

// --- Charts ------------------------------------------------------------------

async function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  const centre = selectedCentre();
  const units = selectedUnits();
  if (!ui.rc && !ui.yd) { ui.$empty.hidden = false; ui.$about.hidden = true; return; }
  ui.$empty.hidden = true;
  ui.$about.hidden = false;

  const shard = await cmhcShard(centre);
  const from = `${ui.prefs.yearFrom || DEFAULT_FROM_YEAR}-01-01`;
  // Short: the subtitle carries the date range too and must stay on one line.
  const segLabel = segment() === 'ac' ? 'apts & condos' : 'all types';
  const section = document.createElement('section');
  section.className = 'cmhc-mi-section';
  section.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
  section.querySelector('h2').textContent = `${centre.id}: Asking vs In-Place vs CMHC Rents`;
  const $cards = section.querySelector('[data-role="cards"]');
  let drawn = 0;

  for (const u of units) {
    const pts = sourcePoints(centre, u, shard);
    const records = [];
    const seriesMeta = [];
    for (const s of SOURCES) {
      const p = since(pts[s.id], from);
      if (!p.length) continue;
      const id = `rentcompare_${u.id}:${s.label}`;
      for (const x of p) records.push({ id, date: x.date, value: x.value });
      seriesMeta.push({ id, chartLabel: s.label, units: 'dollar', provider: 'local', frequency: FREQ[s.id], geo: centre.id });
    }
    if (!records.length) continue;
    const id = `rentcompare_${u.id}`;
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: `${id}_${centre.id.replace(/[^A-Za-z]+/g, '')}`,
      title: `${centre.id} ${u.id === 'total' ? 'Average Rent' : `${u.label} Rent`}: Asking vs In-Place vs CMHC`,
      sourceLabel: 'Rentals.ca & Urbanation; Yardi; CMHC Rental Market Survey', table: true,
      zeroBased: true, mirrorY: false, sourceInCaption: true, signed: false, captionPt: 10,
    });
    card.render(records, seriesMeta, {
      rangeSubtitle: 'month', subtitle: `Rentals.ca ${segLabel}; CMHC apartments`,
      singleSeriesInSubtitle: true, dashedIds: [],
      seriesColours: Object.fromEntries(seriesMeta.map(m => [m.id, SOURCE_COLOURS[SOURCES.find(s => m.chartLabel === s.label).id]])),
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
    drawn++;
  }
  drawn += latestTable($cards, centre, units, shard, segLabel);
  if (drawn) $grid.appendChild(section);
  else {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = units.length ? `No rents for ${centre.id} from these sources.` : 'No unit types ticked.';
    $grid.appendChild(p);
  }
}

// --- Latest figures table ----------------------------------------------------------

/** The newest figure from each source: a row per source, a column per unit. */
function latestTable($cards, centre, units, shard, segLabel) {
  const latest = (pts) => (pts.length ? pts[pts.length - 1] : null);
  const rows = SOURCES.map(s => {
    const cells = units.map(u => latest(sourcePoints(centre, u, shard)[s.id]));
    const dates = cells.filter(Boolean).map(p => p.date).sort();
    const asOf = dates.length ? asOfLabel(s.id, dates[dates.length - 1]) : MISSING;
    return [s.label, asOf, ...cells.map(p => (p ? `$${Math.round(p.value).toLocaleString('en-CA')}${p.src !== 't' ? '*' : ''}` : MISSING))];
  }).filter(r => r.slice(2).some(x => x !== MISSING));
  if (!rows.length) return 0;
  const head = ['Source', 'As of', ...units.map(u => u.label.replace('-Bedroom', '-BR'))];
  const id = 'rentcompare_table';
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card md:col-span-2';
  card.dataset.chartId = id;
  const estimated = rows.some(r => r.some(x => /\d\*$/.test(String(x))));
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(`${centre.id} Latest Rents by Source`)}</header>
    <p class="chart-sub">${escapeHtml(`Rentals.ca ${segLabel}; CMHC purpose-built apartments${estimated ? '; * approximate' : ''}`)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none;min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(x => `<td>${escapeHtml(String(x))}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  $cards.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = 'Source: Rentals.ca & Urbanation; Yardi; CMHC Rental Market Survey';
  // 12 pt table / 10 pt caption in the 1950 px PNG, cropped (as on the other rental tabs).
  const $scroll = card.querySelector('[data-role="plot"]');
  const $table = $scroll.querySelector('table');
  const $cells = [...$table.querySelectorAll('th, td')];
  setExportCropHeight(card);
  setExportRedraw(card, (h) => {
    if (h == null) {
      $source.style.removeProperty('font-size');
      $table.style.removeProperty('font-size');
      for (const c of $cells) { c.style.removeProperty('padding'); c.style.removeProperty('line-height'); }
      return;
    }
    const sW = EXPORT_W / card.offsetWidth;
    $source.style.setProperty('font-size', `${((10 / 72) * EXPORT_DPI / sW).toFixed(2)}px`, 'important');
    let px = (12 / 72) * EXPORT_DPI / sW;
    const set = (v) => {
      $table.style.setProperty('font-size', `${v.toFixed(2)}px`);
      for (const c of $cells) { c.style.setProperty('padding', `${(v * 0.2).toFixed(2)}px ${(v * 0.5).toFixed(2)}px`); c.style.setProperty('line-height', '1.15'); }
    };
    set(px);
    const over = (card.offsetHeight * (EXPORT_W / card.offsetWidth)) / EXPORT_H;
    if (over > 1) set(px / over * 0.98);
  });
  const tsv = [head, ...rows].map(r => r.join('\t')).join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[rent-compare png]', err));
  ui.cards.set(id, { card });
  return 1;
}

// --- Excel (data) ----------------------------------------------------------------

async function exportData() {
  const centre = selectedCentre();
  const shard = await cmhcShard(centre);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${centre.id} rents`.slice(0, 31));
  ws.addRow([`${centre.id}: asking vs in-place vs CMHC rents`]).font = { bold: true };
  ws.addRow([`Rentals.ca (${segment() === 'ac' ? 'apartments & condos' : 'all property types'}) asking rent; Yardi in-place rent; CMHC average rent, purpose-built apartments (October).`]);
  ws.addRow([]);
  ws.addRow(['Source', 'Unit type', 'Period', 'Rent', 'Note']).font = { bold: true };
  for (const u of selectedUnits()) {
    const pts = sourcePoints(centre, u, shard);
    for (const s of SOURCES) {
      for (const p of pts[s.id]) {
        ws.addRow([s.label, u.label, asOfLabel(s.id, p.date), p.value,
          p.src === 't' ? '' : s.id === 'yardi' ? 'Read off the report chart (approximate)' : 'Estimated']);
      }
    }
  }
  [28, 12, 18, 10, 36].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `RentComparison_${centre.id.replace(/[^A-Za-z]+/g, '')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// --- Word (report section) ------------------------------------------------------
// A ready-to-paste rental-market section for an appraisal report: a paragraph
// per unit type comparing the three sources, the latest-figures table, and
// the unit charts as images (Jason, 2026-10-07).

async function exportReport() {
  const centre = selectedCentre();
  const units = selectedUnits();
  const shard = await cmhcShard(centre);
  ui.$report.disabled = true; ui.$report.textContent = 'Preparing…';
  const byUnit = Object.fromEntries(units.map(u => [u.id, sourcePoints(centre, u, shard)]));
  const latest = latestBySource(byUnit);
  const segLabel = segment() === 'ac' ? 'apartments and condos' : 'all property types';
  const paras = reportParagraphs({ centre, units, latest, segLabel });
  if (!paras.length) { showError(`No rents for ${centre.id} to report.`); return; }

  const blocks = [
    { type: 'title', text: `${centre.id} Rental Market: Asking, In-Place and Survey Rents` },
    { type: 'meta', text: `Prepared ${new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}. Sources: Rentals.ca & Urbanation National Rent Report; Yardi Canadian National Multifamily Report; CMHC Rental Market Survey.` },
  ];
  for (const p of paras) blocks.push({ type: 'para', text: p.text });
  blocks.push({ type: 'para', text: 'Asking rents are what landlords ask for units listed that month, the price a new tenant faces. In-place rents are what sitting tenants pay in professionally managed apartments. CMHC’s October survey covers the whole purpose-built apartment stock, including long-held tenancies, so it is usually the lowest of the three.' });

  // The latest-figures table as a real Word table (the comparison-table style).
  const rows = SOURCES.map(s => {
    const cells = units.map(u => latest[u.id]?.[s.id] || null);
    const dates = cells.filter(Boolean).map(p => p.date).sort();
    return { area: s.label, values: [dates.length ? asOfLabel(s.id, dates[dates.length - 1]) : null,
      ...cells.map(p => (p ? `$${Math.round(p.value).toLocaleString('en-CA')}${p.src !== 't' ? '*' : ''}` : null))] };
  }).filter(r => r.values.slice(1).some(v => v != null));
  blocks.push({ type: 'heading', text: `${centre.id} Latest Rents by Source` });
  blocks.push({ type: 'table', table: { columns: ['As of', ...units.map(u => u.label.replace('-Bedroom', '-BR'))], rows } });
  if (rows.some(r => r.values.some(v => typeof v === 'string' && /\*$/.test(v)))) {
    blocks.push({ type: 'meta', text: '* Approximate: read off the Yardi report chart, or a Rentals.ca month estimated from a neighbouring report.' });
  }

  // The unit charts on screen, captured as images.
  const nodes = units.map(u => ui.$grid.querySelector(`.chart-card[data-chart-id="rentcompare_${u.id}"]`)).filter(Boolean);
  if (nodes.length) {
    const { captureNodes } = await import('./doc-image-export.js');
    for (const cap of await captureNodes(nodes)) blocks.push({ type: 'image', capture: cap });
  }
  const { exportNarrativeToWord } = await import('./word-export.js');
  await exportNarrativeToWord(blocks, {
    filename: `RentComparison_${centre.id.replace(/[^A-Za-z]+/g, '')}_${new Date().toISOString().slice(0, 10)}.docx`,
    description: `${centre.id} rental market: asking, in-place and survey rents`,
  });
}
