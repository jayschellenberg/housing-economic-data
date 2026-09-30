/*
 * Cap Rates tab — Winnipeg capitalization-rate ranges by property type and
 * class, as published quarterly by Colliers, CBRE and Cushman & Wakefield
 * and compiled in the firm's Cap Rate Tables workbook.
 *
 * NO CAP-RATE DATA SHIPS WITH THE SITE. The workbook's quarterly sheets are
 * parsed by Cap-Rates/ingest/parse_cap_rates.py into cap_rates.json and
 * published to RRG Shared\Apps\CapRates; the user nominates that folder
 * here and the browser reads it locally (cap-rates-store.js).
 *
 * Per property type: average cap rate by class, one class by firm, that
 * class's range (band), and the selected quarter's table in the workbook's
 * layout. The quarter picker sets both the table's quarter and the end of
 * the charts, so any past quarter can be reproduced.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { downloadCardPng } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getFirm, onFirmChange } from './firm.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  TYPE_ORDER, FIRM_ORDER, quarterList, typesPresent, rowsUpTo,
  averageByFirm, quarterTable, toCardInput, fmtRate, orderBy, defaultYearFrom,
} from './cap-rates-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearCapRates,
} from './cap-rates-store.js';

const PREF_KEY = 'capRates.v1';
const SOURCE = 'Colliers, CBRE & Cushman & Wakefield Quarterly Cap Rate Market Reports';
// One line per brokerage, in each brokerage's own brand colour: Colliers
// blue, CBRE green, Cushman & Wakefield red.
const FIRM_COLOURS = { Colliers: '#0C2340', CBRE: '#006A4D', 'Cushman & Wakefield': '#E4002B' };

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

export async function initCapRates() {
  const $status = document.getElementById('cr-folder-status');
  const $grid = document.getElementById('cr-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('cr-folder-error'),
    $pick: document.getElementById('cr-pick-folder'),
    $pickFallback: document.getElementById('cr-pick-fallback'),
    $rescan: document.getElementById('cr-rescan'),
    $clear: document.getElementById('cr-clear'),
    $quarter: document.getElementById('cr-quarter'),
    $types: document.getElementById('cr-type-toggles'),
    $jump: document.getElementById('cr-jump-list'),
    $yearFrom: document.getElementById('cr-year-from'),
    $xlsx: document.getElementById('cr-download-xlsx'),
    $empty: document.getElementById('cr-empty'),
    data: null,
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the cap-rate data locally (IndexedDB is unavailable).');
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
      if (!handle) { showError('No folder is saved yet — choose the CapRates folder first.'); return; }
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
    await clearCapRates();
    ui.data = null;
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$quarter.addEventListener('change', () => { ui.prefs = savePrefs({ quarter: ui.$quarter.value }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null }); renderCharts(); });
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[cap-rates excel]', err);
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
  return `${s.quarters} quarters (${s.first} to ${s.last}), ${s.rows} rows, read ${when}. ` +
    (s.no_handle ? 'Held in this browser only; re-pick the folder to load an update.'
                 : 'Held in this browser only; the folder is re-checked each visit.');
}
function noDataText() {
  return 'No cap-rate data is published with this site. Choose the firm\'s CapRates folder ' +
    '(published by Cap-Rates\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.$clear.hidden = !ui.data;
  setStatus(ui.data ? summaryText(await getManifest()) : noDataText());
  renderAll();
  // Cap vs Interest on the Market Indicators tab draws from the same store;
  // tell it the data changed so it re-reads without a page reload.
  window.dispatchEvent(new CustomEvent('hed:cap-rates-updated'));
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
  renderQuarterPicker();
  renderTypeToggles();
  renderCharts();
}

function renderQuarterPicker() {
  const $sel = ui.$quarter;
  $sel.replaceChildren();
  const qs = ui.data ? quarterList(ui.data).reverse() : [];
  for (const q of qs) {
    const opt = document.createElement('option');
    opt.value = q; opt.textContent = q;
    $sel.appendChild(opt);
  }
  if (ui.prefs.quarter && qs.includes(ui.prefs.quarter)) $sel.value = ui.prefs.quarter;
  else if (qs.length) $sel.value = qs[0];
  $sel.disabled = qs.length === 0;
  // The rolling default shows as the placeholder, so a blank box still says what it means.
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  const dflt = ui.data ? defaultYearFrom(quarterList(ui.data)) : null;
  ui.$yearFrom.placeholder = dflt ? String(dflt) : 'year';
}

function enabledTypes() {
  const saved = ui.prefs.types;
  return new Set(Array.isArray(saved) ? saved : TYPE_ORDER);
}

function renderTypeToggles() {
  const types = ui.data ? typesPresent(ui.data.rows) : [];
  const on = enabledTypes();
  ui.$types.replaceChildren();
  ui.$jump.replaceChildren();
  for (const t of types) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(t);
    cb.addEventListener('change', () => {
      const next = enabledTypes();
      if (cb.checked) next.add(t); else next.delete(t);
      ui.prefs = savePrefs({ types: [...TYPE_ORDER, ...types].filter((x, i, a) => a.indexOf(x) === i && next.has(x)) });
      renderCharts();
    });
    const text = document.createElement('span'); text.textContent = t;
    label.append(cb, text);
    ui.$types.appendChild(label);
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#cr-section-${slug(t)}`; a.className = 'underline text-accent-600'; a.textContent = t;
    a.addEventListener('click', (e) => { e.preventDefault(); document.getElementById(`cr-section-${slug(t)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    li.appendChild(a); ui.$jump.appendChild(li);
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// --- Charts ------------------------------------------------------------------

/** The chart start: the user's year if set, else Q1 five years before the latest quarter. */
function yearFrom() {
  if (ui.prefs.yearFrom) return Number(ui.prefs.yearFrom);
  return ui.data ? defaultYearFrom(quarterList(ui.data)) : null;
}

function selection() {
  const quarter = ui.$quarter.value || null;
  const rows = rowsUpTo(ui.data?.rows || [], quarter);
  const yf = yearFrom();
  const monthFrom = yf ? `${yf}-01` : null;
  return { quarter, rows, monthFrom };
}

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  if (!ui.data) { ui.$empty.hidden = false; return; }
  ui.$empty.hidden = true;

  const { quarter, rows, monthFrom } = selection();
  const on = enabledTypes();
  const subtitle = 'Colliers, CBRE, Cushman & Wakefield';
  const drawnSections = [];

  for (const type of typesPresent(rows)) {
    if (!on.has(type)) continue;

    const section = document.createElement('section');
    section.className = 'cmhc-mi-section';
    section.id = `cr-section-${slug(type)}`;
    section.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    section.querySelector('h2').textContent = type;
    const $cards = section.querySelector('[data-role="cards"]');

    // 1. Overall average by firm: the Excel chart, one line per brokerage,
    //    each the mean of its published class mid-points that quarter.
    {
      const id = `caprate_${slug(type)}_firms`;
      const input = toCardInput(id, averageByFirm(rows, type), { lineOrder: FIRM_ORDER });
      const card = buildIndicatorCard($cards, {
        chartId: id, fileStem: id, title: `Winnipeg ${type} Cap Rates`, sourceLabel: SOURCE, table: true,
        description: `Each brokerage's overall ${type.toLowerCase()} cap rate: the mean of the mid-points of every class it publishes for the type that quarter. ` + note(),
      });
      card.render(input.records, input.seriesMeta, {
        subtitle, rangePrefix: true, monthFrom,
        seriesColours: Object.fromEntries(input.seriesMeta.map(m => [m.id, FIRM_COLOURS[m.chartLabel]]).filter(([, c]) => c)),
      });
      card.setOpenPanels(open.get(id) || []);
      ui.cards.set(id, { card: card.card });
    }
    // 2. The quarter's table
    {
      const id = `caprate_${slug(type)}_table`;
      const card = buildTableCard($cards, { id, title: `${type} Cap Rates — ${quarter}`, table: quarterTable(rows, type, quarter) });
      ui.cards.set(id, { card: card.card });
    }
    $grid.appendChild(section);
    drawnSections.push({ id: section.id, label: type });
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'No property types selected.';
    $grid.appendChild(p);
  }
}

function note() {
  return 'Rates are the brokerages’ published survey ranges, read from a file on your computer and not published with this site. ' +
    'Quarters before the workbook’s first quarterly sheet come from its Summary sheet, whose retail and multi-family classes are grouped differently, so those class names change at the join.';
}

// --- Quarter table card ------------------------------------------------------

function buildTableCard(container, { id, title, table }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  const { subtypes, firms, cells, average } = table;
  const head1 = subtypes.map(s => `<th colspan="2">${escapeHtml(s)}</th>`).join('');
  const head2 = subtypes.map(() => '<th>Low</th><th>High</th>').join('');
  const body = firms.map(f => `<tr><td>${escapeHtml(f)}</td>${subtypes.map(s => {
    const c = cells[f]?.[s];
    return `<td>${fmtRate(c?.low)}</td><td>${fmtRate(c?.high)}</td>`;
  }).join('')}</tr>`).join('');
  const avg = `<tr class="font-semibold"><td>Average</td>${subtypes.map(s => `<td>${fmtRate(average[s]?.low)}</td><td>${fmtRate(average[s]?.high)}</td>`).join('')}</tr>`;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">Published Low–High range by brokerage • Source: ${escapeHtml(SOURCE)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot">
      <table class="cmhc-table cmhc-table-compact"><thead><tr><th rowspan="2">Source</th>${head1}</tr><tr>${head2}</tr></thead>
      <tbody>${body || '<tr><td colspan="99">No figures for this quarter.</td></tr>'}${body ? avg : ''}</tbody></table>
    </div>
    <div class="chart-caption"><span class="chart-caption-left"></span><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  const $caption = card.querySelector('.chart-caption');
  const applyFirm = (name = getFirm()) => { $source.textContent = name; $caption.hidden = !name; };
  applyFirm(); onFirmChange(applyFirm);
  const tsv = [
    ['Source', ...subtypes.flatMap(s => [`${s} Low`, `${s} High`])].join('\t'),
    ...firms.map(f => [f, ...subtypes.flatMap(s => [fmtRate(cells[f]?.[s]?.low), fmtRate(cells[f]?.[s]?.high)])].join('\t')),
    ['Average', ...subtypes.flatMap(s => [fmtRate(average[s]?.low), fmtRate(average[s]?.high)])].join('\t'),
  ].join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[cap-rates png]', err));
  return { card };
}

// --- Excel (data) ------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const { quarter, rows } = selection();
  const on = enabledTypes();

  for (const type of typesPresent(rows)) {
    if (!on.has(type)) continue;
    const t = quarterTable(rows, type, quarter);
    const ws = wb.addWorksheet(`${type} ${quarter}`.slice(0, 31));
    ws.addRow([`${type} Cap Rates — ${quarter}`]).font = { bold: true };
    ws.addRow([`Source: ${SOURCE}`]);
    ws.addRow([]);
    ws.addRow(['Source', ...t.subtypes.flatMap(s => [s, ''])]).font = { bold: true };
    ws.addRow(['', ...t.subtypes.flatMap(() => ['Low', 'High'])]).font = { bold: true };
    for (const f of t.firms) ws.addRow([f, ...t.subtypes.flatMap(s => [t.cells[f]?.[s]?.low ?? null, t.cells[f]?.[s]?.high ?? null])]);
    ws.addRow(['Average', ...t.subtypes.flatMap(s => [t.average[s]?.low ?? null, t.average[s]?.high ?? null])]).font = { bold: true };
    ws.getColumn(1).width = 22;
    ws.addRow([]);
    ws.addRow(['Values in percent.']);
  }
  const all = wb.addWorksheet('All rows');
  all.addRow(['Quarter', 'Date', 'Market', 'Firm', 'Type', 'Class', 'Low %', 'High %', 'Mid %']).font = { bold: true };
  for (const r of orderBy(rows.map(r => r), []).sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type))) {
    all.addRow([r.quarter, r.date, r.market, r.firm, r.type, r.subtype,
      r.low == null ? null : r.low * 100, r.high == null ? null : r.high * 100, r.mid == null ? null : r.mid * 100]);
  }
  [12, 12, 12, 22, 14, 24, 8, 8, 8].forEach((w, i) => { all.getColumn(i + 1).width = w; });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `CapRates_${quarter.replace(' ', '')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
