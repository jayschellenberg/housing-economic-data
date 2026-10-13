/*
 * Market Discount Rates tab — Canada's market risk-free rate (RF), market
 * risk premium (MRP) and required return to equity (Km) from Pablo
 * Fernandez's annual surveys, as kept in the appraiser's "Market Risk
 * Premium Survey Chart" workbook.
 *
 * Unlike the other Local Data tabs the figures ship with the site: the
 * surveys are freely published, so scripts/market_discount_rates.py turns
 * the workbook into web/public/data/economy/market_discount_rates.json.
 *
 * Reproduces the workbook: headline tiles for the last year in range, the
 * Country / Year / RF / MRP / Required Return table, the three-line chart and
 * the RF + MRP stacked bars.
 */

import * as Plot from '@observablehq/plot';
import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { themed, gridMarks, frameMark, plotWidth, plotHeight, fitPlotWidth } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';

const PREF_KEY = 'discountRates.v1';
const DATA_URL = './data/economy/market_discount_rates.json';
const DEFAULT_YEARS = 5;
const TITLE = 'Canada — Market Risk-Free Rate, Market Risk Premium & Required Return to Equity';
// The workbook's series, in its order and colours: RF blue (dotted in Excel),
// MRP orange (dashed), Km green (solid).
const SERIES = [
  { key: 'rf',  label: 'Risk Free Rate',             tile: 'Risk-Free Rate',            colour: '#156082' },
  { key: 'mrp', label: 'Market Risk Premium',        tile: 'Market Risk Premium',       colour: '#E97132' },
  { key: 'ke',  label: 'Required Return to Equity',  tile: 'Required Return to Equity', colour: '#2E7D32' },
];
const BAR_SERIES = SERIES.slice(0, 2);

// Missing figures print as ** (site-wide table convention).
const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '**' : `${v.toFixed(1)}%`);

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

export async function initDiscountRates() {
  const $grid = document.getElementById('dr-chart-grid');
  if (!$grid) return;
  ui = {
    $grid,
    $kpis: document.getElementById('dr-kpis'),
    $error: document.getElementById('dr-error'),
    $from: document.getElementById('dr-year-from'),
    $to: document.getElementById('dr-year-to'),
    data: null,
    cards: new Map(),
    prefs: loadPrefs(),
  };
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ui.data = await res.json();
  } catch (err) {
    ui.$error.textContent = `Could not load the discount-rate data (${err?.message || err}).`;
    ui.$error.hidden = false;
    return;
  }
  wireControls();
  renderYearPickers();
  render();
}

// --- Sidebar -----------------------------------------------------------------

function years() { return (ui.data?.rows || []).map(r => r.year); }

function defaultRange() {
  const ys = years();
  const last = ys[ys.length - 1];
  return { from: Math.max(ys[0], last - DEFAULT_YEARS + 1), to: last };
}

/** The saved range, clamped to the data; a blank end means "latest". */
function range() {
  const ys = years();
  const d = defaultRange();
  let from = ys.includes(ui.prefs.from) ? ui.prefs.from : d.from;
  let to = ys.includes(ui.prefs.to) ? ui.prefs.to : d.to;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function renderYearPickers() {
  const ys = years();
  const { from, to } = range();
  for (const [$sel, val] of [[ui.$from, from], [ui.$to, to]]) {
    $sel.replaceChildren(...ys.map(y => {
      const o = document.createElement('option');
      o.value = String(y); o.textContent = String(y);
      return o;
    }));
    $sel.value = String(val);
  }
}

function wireControls() {
  const onChange = () => {
    const ys = years();
    const to = Number(ui.$to.value);
    // Ending on the newest survey is saved as "latest", so next year's
    // survey joins the range on its own.
    ui.prefs = savePrefs({ from: Number(ui.$from.value), to: to === ys[ys.length - 1] ? null : to });
    renderYearPickers();
    render();
  };
  ui.$from.addEventListener('change', onChange);
  ui.$to.addEventListener('change', onChange);
  document.getElementById('dr-reset')?.addEventListener('click', () => {
    ui.prefs = savePrefs({ from: null, to: null });
    renderYearPickers();
    render();
  });
  document.getElementById('dr-download-xlsx')?.addEventListener('click', () => exportData().catch(err => {
    console.error('[discount-rates excel]', err);
    ui.$error.textContent = 'Excel export failed: ' + (err?.message || err);
    ui.$error.hidden = false;
  }));
}

// --- Render ------------------------------------------------------------------

function selectedRows() {
  const { from, to } = range();
  return ui.data.rows.filter(r => r.year >= from && r.year <= to);
}

function render() {
  const rows = selectedRows();
  renderKpis(rows);
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  ui.$grid.replaceChildren();
  ui.cards.clear();
  const { from, to } = range();
  const span = from === to ? String(from) : `${from} to ${to}`;
  const source = ui.data.source;

  // 1. Line chart: the three series, one point per survey year.
  {
    const id = 'discount_rates_lines';
    const card = buildIndicatorCard(ui.$grid, {
      chartId: id, fileStem: id, title: TITLE, sourceLabel: source, table: true, zeroBased: true,
      // Source alone, bottom-right, 10 pt in print — the tab reproduces a
      // published survey, like the Cap Rates and Johnson Report figures.
      sourceInCaption: true, signed: false, captionPt: 10, mirrorY: false, xLabel: 'Year',
      description: 'The average figures reported for Canada in Pablo Fernandez\'s annual survey of the market risk premium (MRP) and risk-free rate (RF) ' +
        'that analysts, companies and academics use. Required return to equity (Km) is the survey\'s own average of each respondent\'s RF + MRP, ' +
        'so it can differ from the sum of the two averages by a tenth of a point. Years before 2017 report the MRP only, apart from 2013 and 2015.',
    });
    const seriesMeta = SERIES.map(s => ({
      id: `${id}:${s.key}`, chartLabel: s.label, units: 'percent', provider: 'local', frequency: 'annual', geo: 'Canada',
    }));
    const records = SERIES.flatMap(s => ui.data.rows.map(r => ({ id: `${id}:${s.key}`, date: `${r.year}-01-01`, value: r[s.key] })));
    card.render(records, seriesMeta, {
      rangeSubtitle: 'year', monthFrom: `${from}-01`, monthTo: `${to}-12`,
      dashedIds: [`${id}:rf`, `${id}:mrp`], dots: true,
      seriesColours: Object.fromEntries(SERIES.map(s => [`${id}:${s.key}`, s.colour])),
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
  }
  // 2. Stacked bars: RF + MRP.
  {
    const id = 'discount_rates_bars';
    const card = buildStackCard(ui.$grid, { id, title: TITLE, source });
    card.render(rows, span);
    ui.cards.set(id, { card: card.card });
  }
  // 3. The workbook's table.
  {
    const id = 'discount_rates_table';
    const card = buildTableCard(ui.$grid, { id, title: TITLE, subtitle: span, source, rows });
    ui.cards.set(id, { card: card.card });
  }
}

/** Latest figure in range per series. A year missing a series (pre-2017)
 *  falls back to the newest year in range that has it, named in the tile. */
function renderKpis(rows) {
  ui.$kpis.replaceChildren();
  for (const s of SERIES) {
    const hit = [...rows].reverse().find(r => r[s.key] != null);
    const tile = document.createElement('div');
    tile.className = 'cmhc-kpi';
    tile.innerHTML = `
      <div class="cmhc-kpi-label">${escapeHtml(s.tile)}</div>
      <div class="cmhc-kpi-value"></div>
      <div class="cmhc-kpi-meta"></div>
      <div class="cmhc-kpi-source"></div>`;
    tile.querySelector('.cmhc-kpi-value').textContent = hit ? fmtPct(hit[s.key]) : '**';
    tile.querySelector('.cmhc-kpi-meta').textContent = hit ? `Canada • ${hit.year} survey` : 'Not reported in the selected years';
    tile.querySelector('.cmhc-kpi-source').textContent = `Source: ${ui.data.source}`;
    ui.$kpis.appendChild(tile);
  }
}

// --- Stacked bar card --------------------------------------------------------

function buildStackCard(container, { id, title, source }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot" style="min-height:240px"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No year in the range reports both the risk-free rate and the market risk premium.</div>
    <div class="chart-caption chart-caption-sourced">
      <span class="chart-source" data-role="source"></span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $sub = card.querySelector('[data-role="sub"]');
  const $plot = card.querySelector('[data-role="plot"]');
  const $empty = card.querySelector('[data-role="empty"]');
  const $png = card.querySelector('[data-role="dl-png"]');
  const $source = card.querySelector('[data-role="source"]');
  const $caption = card.querySelector('.chart-caption');
  $source.textContent = `Source: ${source}`;
  // 10 pt caption in the 1950 × 1050 @ 300 DPI PNG (see johnson.js).
  const fitCaptionForExport = (h) => {
    if (h == null) { $caption.style.removeProperty('font-size'); return; }
    for (let i = 0; i < 2; i++) {
      const scale = Math.min(EXPORT_W / card.offsetWidth, EXPORT_H / card.offsetHeight);
      $caption.style.setProperty('font-size', `${((10 / 72) * EXPORT_DPI / scale).toFixed(2)}px`, 'important');
    }
  };

  let last = null;
  let exportH = null;
  function draw(rows, span) {
    $plot.replaceChildren();
    $sub.textContent = span;
    // Only years with both parts: an MRP-only year would stand on zero and
    // read as a far lower return.
    const both = rows.filter(r => r.rf != null && r.mrp != null);
    if (!both.length) { $empty.hidden = false; $png.disabled = true; return; }
    $empty.hidden = true; $png.disabled = false;
    const yearsShown = both.map(r => String(r.year));
    const data = both.flatMap(r => BAR_SERIES.map(s => ({ year: String(r.year), part: s.label, value: r[s.key], total: r.rf + r.mrp })));
    const maxV = Math.max(...both.map(r => r.rf + r.mrp));
    const width = plotWidth($plot);
    const svg = Plot.plot(themed({
      width,
      height: exportH ?? plotHeight(width, 320),
      marginTop: 20, marginBottom: 52, marginLeft: 54,
      x: { label: 'Year', labelOffset: 42, domain: yearsShown, padding: 0.35 },
      y: { label: 'Percentage', domain: [0, Math.ceil(maxV * 1.1)], tickFormat: (v) => `${v.toFixed(1)}%`, grid: true },
      color: { domain: BAR_SERIES.map(s => s.label), range: BAR_SERIES.map(s => s.colour), legend: false },
      marks: [
        ...gridMarks(),
        Plot.barY(data, Plot.stackY({
          x: 'year', y: 'value', fill: 'part', order: BAR_SERIES.map(s => s.label),
          title: (d) => `${d.year} · ${d.part}: ${fmtPct(d.value)} (total ${fmtPct(d.total)})`,
        })),
        frameMark(),
      ],
    }));
    const legend = document.createElement('div');
    legend.className = 'cmhc-plot-legend';
    for (const s of BAR_SERIES) {
      const item = document.createElement('div');
      item.className = 'cmhc-plot-legend-item';
      item.innerHTML = `<span class="cmhc-plot-legend-swatch" style="background:${s.colour}"></span><span class="cmhc-plot-legend-text"></span>`;
      item.querySelector('.cmhc-plot-legend-text').textContent = s.label;
      legend.appendChild(item);
    }
    const wrap = document.createElement('div');
    wrap.className = 'cmhc-plot-wrap';
    wrap.append(svg, legend);
    $plot.appendChild(wrap);
  }
  $png.onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[discount-rates png]', err));
  function render(rows, span) { last = [rows, span]; draw(rows, span); }
  fitPlotWidth($plot, () => { if (last) draw(...last); });
  setExportRedraw(card, (h) => { exportH = h; if (last) draw(...last); fitCaptionForExport(h); });
  return { card, render };
}

// --- Table card --------------------------------------------------------------

function buildTableCard(container, { id, title, subtitle, source, rows }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  const head = ['Country', 'Year', ...SERIES.map(s => s.label)];
  const body = rows.map(r => `<tr><td>${escapeHtml(ui.data.country)}</td><td>${r.year}</td>${SERIES.map(s => `<td>${fmtPct(r[s.key])}</td>`).join('')}</tr>`).join('');
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${body || '<tr><td colspan="5">No surveys in the selected years.</td></tr>'}</tbody></table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = `Source: ${source}`;
  // Same print rules as the Cap Rates tables: 10 pt caption, 12 pt table text
  // in tight rows at natural height, the PNG cropped to the table.
  const CAPTION_IMAGE_PX = (10 / 72) * EXPORT_DPI;
  const TABLE_IMAGE_PX = (12 / 72) * EXPORT_DPI;
  const $scroll = card.querySelector('[data-role="plot"]');
  const $table = $scroll.querySelector('table');
  const $cells = [...$table.querySelectorAll('th, td')];
  const fit = () => {
    const scale = Math.min(EXPORT_W / card.offsetWidth, EXPORT_H / card.offsetHeight);
    $source.style.setProperty('font-size', `${(CAPTION_IMAGE_PX / scale).toFixed(2)}px`, 'important');
    const px = TABLE_IMAGE_PX / scale;
    $table.style.setProperty('font-size', `${px.toFixed(2)}px`);
    for (const c of $cells) {
      c.style.setProperty('padding', `${(px * 0.2).toFixed(2)}px ${(px * 0.5).toFixed(2)}px`);
      c.style.setProperty('line-height', '1.15');
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
    fit(); fit(); fit();
  });
  const tsv = [head.join('\t'), ...rows.map(r => [ui.data.country, r.year, ...SERIES.map(s => fmtPct(r[s.key]))].join('\t'))].join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[discount-rates png]', err));
  return { card };
}

// --- Excel (data) ------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Market Discount Rates');
  const { from, to } = range();
  ws.addRow([TITLE]).font = { bold: true };
  ws.addRow([`Source: ${ui.data.source}`]);
  ws.addRow([]);
  ws.addRow(['Country', 'Year', ...SERIES.map(s => s.label)]).font = { bold: true };
  // Fractions with a percent format, so Excel shows 3.8% and formulas see 0.038.
  for (const r of selectedRows()) {
    const row = ws.addRow([ui.data.country, r.year, ...SERIES.map(s => (r[s.key] == null ? null : Math.round(r[s.key] * 100) / 1e4))]);
    row.eachCell((c, i) => { if (i >= 3) c.numFmt = '0.0%'; });
  }
  [10, 8, 16, 20, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MarketDiscountRates_${from}-${to}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
