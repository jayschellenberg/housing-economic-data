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
import { themed, PALETTE, gridMarks, frameMark, plotWidth, plotHeight, fitPlotWidth } from './plot-theme.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';

const PREF_KEY = 'discountRates.v1';
const DATA_URL = './data/economy/market_discount_rates.json';
// Growth-of-$100 series + GIC rates, refreshed weekly by
// r/28_scrape_investment_context.R.
const INVEST_URL = './data/economy/investment_context.json';
const DEFAULT_YEARS_BACK = 5;
const PERF_SOURCE = 'Yahoo Finance (XIC, ZFL adjusted close) & Statistics Canada (CPI)';
// Narrative wording per credit union; anything new falls back to its own
// institution + product names.
const GIC_PHRASE = {
  scu: 'Steinbach Credit Union 5-year GIC rate (for deposits of $250,000 and over)',
  acu: 'Access Credit Union 5-year GIC rate',
};
const DEFAULT_YEARS = 5;
// One line on screen and in the PNG; the country leads the subtitle
// ("Canada — 2022 to 2026").
const TITLE = 'Market Risk-Free Rate, Premium & Required Return to Equity';
// The workbook's series, in its order. Colours are the site palette by
// position (blue, red, green), as on every other chart; the line card picks
// them itself, the stacked bars read them from here.
const SERIES = [
  { key: 'rf',  label: 'Risk Free Rate',             tile: 'Risk-Free Rate',            colour: PALETTE[0] },
  { key: 'mrp', label: 'Market Risk Premium',        tile: 'Market Risk Premium',       colour: PALETTE[1] },
  { key: 'ke',  label: 'Required Return to Equity',  tile: 'Required Return to Equity', colour: PALETTE[2] },
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
    $perfGrid: document.getElementById('dr-perf-grid'),
    $perfWarn: document.getElementById('dr-perf-warning'),
    $narrative: document.getElementById('dr-narrative'),
    $effDate: document.getElementById('dr-eff-date'),
    $yearsBack: document.getElementById('dr-years-back'),
    data: null,
    invest: null,
    cards: new Map(),
    prefs: loadPrefs(),
  };
  const getJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  // The investment context is a second, optional file: without it the
  // survey half of the tab still renders.
  const [survey, invest] = await Promise.allSettled([getJson(DATA_URL), getJson(INVEST_URL)]);
  if (survey.status !== 'fulfilled') {
    ui.$error.textContent = `Could not load the discount-rate data (${survey.reason?.message || survey.reason}).`;
    ui.$error.hidden = false;
    return;
  }
  ui.data = survey.value;
  if (invest.status === 'fulfilled') ui.invest = invest.value;
  else console.error('[discount-rates] investment context', invest.reason);
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
  // Investment performance window. Blank = latest data / five years.
  ui.$effDate.value = ui.prefs.effDate || '';
  ui.$yearsBack.value = ui.prefs.yearsBack || '';
  ui.$effDate.addEventListener('change', () => {
    ui.prefs = savePrefs({ effDate: ui.$effDate.value || null });
    renderPerformance();
  });
  ui.$yearsBack.addEventListener('change', () => {
    const n = Math.round(Number(ui.$yearsBack.value));
    ui.prefs = savePrefs({ yearsBack: n >= 1 && n <= 15 ? n : null });
    ui.$yearsBack.value = ui.prefs.yearsBack || '';
    renderPerformance();
  });
  document.getElementById('dr-perf-reset')?.addEventListener('click', () => {
    ui.prefs = savePrefs({ effDate: null, yearsBack: null });
    ui.$effDate.value = ''; ui.$yearsBack.value = '';
    renderPerformance();
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
      subtitle: ui.data.country, rangeSubtitle: 'year', monthFrom: `${from}-01`, monthTo: `${to}-12`,
      dashedIds: [`${id}:rf`, `${id}:mrp`], dots: true,
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
  }
  // 2. Stacked bars: RF + MRP.
  {
    const id = 'discount_rates_bars';
    const card = buildStackCard(ui.$grid, { id, title: TITLE, source });
    card.render(rows, `${ui.data.country} — ${span}`);
    ui.cards.set(id, { card: card.card });
  }
  // 3. The workbook's table.
  {
    const id = 'discount_rates_table';
    const card = buildTableCard(ui.$grid, {
      id, title: TITLE, subtitle: `${ui.data.country} — ${span}`, source,
      head: ['Country', 'Year', ...SERIES.map(s => s.label)],
      rows: rows.map(r => [ui.data.country, String(r.year), ...SERIES.map(s => fmtPct(r[s.key]))]),
      empty: 'No surveys in the selected years.',
    });
    ui.cards.set(id, { card: card.card });
  }
  // The narrative cites the newest survey, so it follows the survey data too.
  renderPerformance();
}

// --- Investment performance ----------------------------------------------------

const isoAddYears = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  // 29 Feb → 28 Feb in a non-leap year.
  const dt = new Date(Date.UTC(y + n, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
// "Oct 13, 2021"; a monthly series (CPI) as "Oct 2021".
const shortDate = (iso, monthly = false) => (!iso ? '**' : new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', timeZone: 'UTC', ...(monthly ? {} : { day: 'numeric' }) }));
const fmtAnnual = (v) => (v == null || !Number.isFinite(v) ? '**' : `${(v * 100).toFixed(1)}%`);

/** The latest date every market series has data for. */
function latestMarketDate() {
  const market = ui.invest.series.filter(s => s.frequency === 'daily');
  return market.map(s => s.dates[s.dates.length - 1]).sort()[0];
}

/**
 * The comparison window and each series' growth of $100 over it. A series
 * starts at its first observation on or after the start date (CPI: the start
 * date's month) and ends at its last on or before the effective date.
 * Annualized = (end ÷ start)^(365.25 ÷ days) − 1, as in the Quarto exhibit.
 */
function performance() {
  const latest = latestMarketDate();
  let end = ui.prefs.effDate && ui.prefs.effDate < latest ? ui.prefs.effDate : latest;
  const years = ui.prefs.yearsBack || DEFAULT_YEARS_BACK;
  const start = isoAddYears(end, -years);
  const out = [];
  for (const s of ui.invest.series) {
    const from = s.frequency === 'monthly' ? `${start.slice(0, 7)}-01` : start;
    const idx = s.dates.map((d, i) => i).filter(i => s.dates[i] >= from && s.dates[i] <= end);
    if (idx.length < 2) { out.push({ ...s, points: [], annual: null }); continue; }
    const base = s.values[idx[0]];
    const points = idx.map(i => ({ date: s.dates[i], value: (s.values[i] / base) * 100 }));
    const first = points[0], last = points[points.length - 1];
    const span = daysBetween(first.date, last.date);
    out.push({
      ...s, points, startDate: first.date, endDate: last.date, endValue: last.value,
      // A series that started after the window opened (ZFL before mid-2010)
      // covers less than the full span; it is flagged rather than stretched.
      partial: daysBetween(start, first.date) > 45,
      annual: span >= 330 ? (last.value / 100) ** (365.25 / span) - 1 : null,
    });
  }
  return { start, end, years, series: out };
}

function renderPerformance() {
  const $grid = ui.$perfGrid;
  const open = new Map();
  for (const [id, c] of ui.perfCards || []) open.set(id, readOpenPanels(c.card));
  ui.perfCards = new Map();
  $grid.replaceChildren();
  ui.$perfWarn.hidden = true;
  if (!ui.invest?.series?.length) {
    ui.$perfWarn.textContent = 'The investment performance data could not be loaded.';
    ui.$perfWarn.hidden = false;
    ui.$narrative.hidden = true;
    return;
  }
  const perf = performance();
  ui.$effDate.max = latestMarketDate();
  ui.$effDate.placeholder = latestMarketDate();
  const byId = Object.fromEntries(perf.series.map(s => [s.id, s]));
  const warnings = [];
  for (const s of perf.series) {
    if (s.partial) warnings.push(`${s.label} data starts ${longDate(s.startDate)}, after the window opens; its annualized return covers the shorter period.`);
  }
  const gicStale = (ui.invest.gic || []).filter(g => g.stale);
  if (gicStale.length) warnings.push(`The latest weekly check could not read ${gicStale.map(g => g.institution).join(' and ')}'s rate page; the rate shown is the last one read (${gicStale.map(g => longDate(g.checked)).join(', ')}).`);
  if (ui.prefs.effDate && ui.invest.gic?.length && daysBetween(ui.prefs.effDate, ui.invest.built) > 31) {
    warnings.push('The GIC rates are the credit unions\' current rates, not rates as of the effective date.');
  }
  if (warnings.length) { ui.$perfWarn.textContent = warnings.join(' '); ui.$perfWarn.hidden = false; }

  // 1. Growth of $100.
  {
    const id = 'investment_performance';
    const card = buildIndicatorCard($grid, {
      chartId: id, fileStem: id, title: 'Investment Performance Comparison', sourceLabel: PERF_SOURCE,
      sourceInCaption: true, captionPt: 10, mirrorY: false,
      description: 'Growth of $100 invested at the start of the window. Equities are the iShares Core S&P/TSX Capped Composite ETF (XIC) ' +
        'and long Government of Canada bonds the BMO Long Federal Bond Index ETF (ZFL), both at adjusted closes so distributions are reinvested ' +
        '(total return, after the funds\' small management fees). Inflation is the Canada All-items CPI. The %/yr beside each name is its annualized return over the window.',
    });
    const seriesMeta = perf.series.map(s => ({
      id: `${id}:${s.id}`, chartLabel: s.label, units: 'dollar', provider: 'local', frequency: s.frequency, geo: 'Canada',
    }));
    const records = perf.series.flatMap(s => s.points.map(p => ({ id: `${id}:${s.id}`, date: p.date, value: p.value })));
    card.render(records, seriesMeta, {
      subtitle: 'Growth of $100', rangeSubtitle: 'month', annualized: true,
    });
    card.setOpenPanels(open.get(id) || []);
    ui.perfCards.set(id, { card: card.card });
  }
  // 2. Summary table.
  {
    const id = 'investment_performance_table';
    const card = buildTableCard($grid, {
      id, title: 'Investment Performance Summary', subtitle: `Growth of $100 — ${longDate(perf.start)} to ${longDate(perf.end)}`,
      source: PERF_SOURCE,
      head: ['Benchmark', 'Start', 'End', 'Value of $100', 'Annualized'],
      rows: perf.series.map(s => [s.label, shortDate(s.startDate, s.frequency === 'monthly'), shortDate(s.endDate, s.frequency === 'monthly'),
        s.endValue == null ? '**' : `$${s.endValue.toFixed(2)}`, fmtAnnual(s.annual)]),
      empty: 'No data in the window.',
    });
    ui.perfCards.set(id, { card: card.card });
  }
  renderNarrative(perf, byId);
}

/** Survey row the narrative cites: the newest one published by the effective date. */
function citedSurvey(end) {
  const rows = ui.data.rows.filter(r => r.rf != null && r.mrp != null && r.ke != null);
  const ok = rows.filter(r => (r.study?.published ? r.study.published <= end : r.year < Number(end.slice(0, 4))));
  return ok[ok.length - 1] || null;
}

function narrativeBlocks(perf, byId) {
  const blocks = [];
  const n = perf.years;
  const cpi = byId.cpi?.annual, bond = byId.zfl?.annual, tsx = byId.xic?.annual;
  blocks.push({ type: 'para', text: 'As of the effective date, the data illustrates:' });
  if (cpi != null) {
    blocks.push({ type: 'bullet', label: 'CPI Benchmark:', text: `Average annual inflation has been ${fmtAnnual(cpi)} over the last ${n} year${n === 1 ? '' : 's'}, meaning an investment must yield more than this to maintain purchasing power.` });
  }
  if (bond != null) {
    const vsCpi = cpi == null ? '' : bond < cpi ? ', failing to keep pace with the CPI' : ', keeping ahead of the CPI';
    blocks.push({ type: 'bullet', label: 'Bond Rates:', text: `Government Bonds (10+ Year) are often cited as "risk-free" in terms of default, but they have carried significant interest rate risk. Over this ${n}-year window, their total return was approximately ${fmtAnnual(bond)} annualized${vsCpi}.` });
  }
  if (tsx != null) {
    const others = [bond, cpi].filter(v => v != null);
    const beatAll = others.every(v => tsx > v);
    let verb;
    if (beatAll && others.length === 2) verb = `${tsx - Math.max(...others) >= 0.02 ? 'significantly ' : ''}outpaced both bonds and inflation`;
    else if (cpi != null && tsx > cpi) verb = 'outpaced inflation but trailed bonds';
    else if (cpi != null) verb = 'trailed inflation';
    else verb = 'returned';
    blocks.push({ type: 'bullet', label: 'Equity Performance:', text: `The S&P/TSX Total Return index ${verb}, providing an annualized return of ${fmtAnnual(tsx)}.` });
  }
  const s = citedSurvey(perf.end);
  if (s) {
    const st = s.study || {};
    const who = st.title
      ? `A study entitled "${st.title}" by ${st.authors || 'Pablo Fernandez et al'}${st.published ? ` (published ${longDate(st.published)})` : ''}`
      : `Pablo Fernandez et al's ${s.year} survey of the market risk premium and risk-free rate${st.published ? ` (published ${longDate(st.published)})` : ''}`;
    blocks.push({ type: 'para', text: `${who} reported in Canada an average "risk free rate" of ${fmtPct(s.rf)} and an estimated market risk premium of ${fmtPct(s.mrp)} with a required return to equity (i.e. risk-free rate plus market risk premium) of ${fmtPct(s.ke)}.` });
  }
  const gic = ui.invest.gic || [];
  if (gic.length) {
    blocks.push({ type: 'para', text: 'Other current benchmarks for risk-free rates:' });
    for (const g of gic) {
      const what = GIC_PHRASE[g.id] || `${g.institution} ${g.product} rate`;
      blocks.push({ type: 'bullet', text: `${what} is ${g.rate.toFixed(2)}%${g.updated ? ` (rates updated ${longDate(g.updated)})` : ''}` });
    }
  }
  return blocks;
}

function renderNarrative(perf, byId) {
  const blocks = narrativeBlocks(perf, byId);
  const html = blocksToHtml(blocks);
  ui.$narrative.hidden = false;
  ui.$narrative.innerHTML = `
    <header class="chart-title">Discount Rate Narrative</header>
    <p class="chart-sub">Auto-written from the figures above for an effective date of ${escapeHtml(longDate(perf.end))}; edit freely after pasting.</p>
    <div class="flex flex-wrap gap-2 mt-2">
      <button type="button" data-role="copy" class="text-sm bg-accent-500 hover:bg-accent-600 text-white rounded px-3 py-1.5">Copy narrative</button>
      <button type="button" data-role="docx" class="text-sm bg-accent-500 hover:bg-accent-600 text-white rounded px-3 py-1.5">Download Word (narrative)</button>
    </div>
    <div class="text-sm text-neutral-800 leading-relaxed mt-3" data-role="body">${html}</div>`;
  const $copy = ui.$narrative.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    const text = blocks.map(b => (b.type === 'bullet' ? `•  ${b.label ? `${b.label} ` : ''}${b.text}` : b.text)).join('\n');
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
    } catch { await navigator.clipboard?.writeText(text); }
    $copy.textContent = 'Copied';
    setTimeout(() => { $copy.textContent = 'Copy narrative'; }, 1500);
  });
  ui.$narrative.querySelector('[data-role="docx"]').addEventListener('click', async () => {
    const { exportNarrativeToWord } = await import('./word-export.js');
    // No bullet block type in the Word export: "•"-prefixed paragraphs (as census.js).
    await exportNarrativeToWord(blocks.map(b => (b.type === 'bullet'
      ? { type: 'para', text: `•  ${b.label ? `${b.label} ` : ''}${b.text}` } : b)), {
      filename: `Discount_Rate_Narrative_${perf.end}.docx`,
      description: `Discount rate support — effective ${longDate(perf.end)}`,
    });
  });
}

/** Paragraphs, with runs of bullets gathered into one list. */
function blocksToHtml(blocks) {
  let html = '';
  let inList = false;
  for (const b of blocks) {
    if (b.type === 'bullet') {
      if (!inList) { html += '<ul style="list-style:disc;padding-left:1.5em;margin:0 0 0.75em">'; inList = true; }
      html += `<li>${b.label ? `<strong>${escapeHtml(b.label)}</strong> ` : ''}${escapeHtml(b.text)}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p style="margin:0 0 0.75em">${escapeHtml(b.text)}</p>`;
    }
  }
  return inList ? `${html}</ul>` : html;
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
    const data = both.flatMap(r => BAR_SERIES.map(s => ({ year: String(r.year), part: s.label, value: r[s.key], total: r.ke ?? r.rf + r.mrp })));
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
          title: (d) => `${d.year} · ${d.part}: ${fmtPct(d.value)} (required return ${fmtPct(d.total)})`,
        })),
        // The survey's required return to equity printed above each bar, to
        // match the table and line chart (Jason, 2026-10-13). It can differ
        // from the bar's height (RF + MRP) by a few tenths: 2024 is 8.4% on a
        // 3.5 + 5.2 bar. A year without a Km falls back to the bar's sum.
        Plot.text(both, {
          x: (r) => String(r.year), y: (r) => r.rf + r.mrp, text: (r) => fmtPct(r.ke ?? r.rf + r.mrp),
          dy: -9, fontSize: 12, fontWeight: 600, fill: '#262626',
        }),
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

/** A table card: `head` labels, `rows` arrays of display strings. */
function buildTableCard(container, { id, title, subtitle, source, head, rows, empty }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  // Only the first column may wrap; dates and figures stay on one line.
  const body = rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' style="white-space:nowrap"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${head.length}">${escapeHtml(empty || 'No data.')}</td></tr>`}</tbody></table>
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
  const tsv = [head, ...rows].map(r => r.join('\t')).join('\n');
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
  ws.addRow([`${ui.data.country} — ${TITLE}`]).font = { bold: true };
  ws.addRow([`Source: ${ui.data.source}`]);
  ws.addRow([]);
  ws.addRow(['Country', 'Year', ...SERIES.map(s => s.label)]).font = { bold: true };
  // Fractions with a percent format, so Excel shows 3.8% and formulas see 0.038.
  for (const r of selectedRows()) {
    const row = ws.addRow([ui.data.country, r.year, ...SERIES.map(s => (r[s.key] == null ? null : Math.round(r[s.key] * 100) / 1e4))]);
    row.eachCell((c, i) => { if (i >= 3) c.numFmt = '0.0%'; });
  }
  [10, 8, 16, 20, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  if (ui.invest?.series?.length) {
    const perf = performance();
    const ps = wb.addWorksheet('Investment Performance');
    ps.addRow([`Investment Performance — growth of $100, ${perf.start} to ${perf.end}`]).font = { bold: true };
    ps.addRow([`Source: ${PERF_SOURCE}`]);
    ps.addRow([]);
    ps.addRow(['Benchmark', 'Start', 'End', 'Value of $100', 'Annualized return']).font = { bold: true };
    for (const s of perf.series) {
      const row = ps.addRow([s.label, s.startDate || null, s.endDate || null,
        s.endValue == null ? null : Math.round(s.endValue * 100) / 100,
        s.annual == null ? null : Math.round(s.annual * 1e4) / 1e4]);
      row.getCell(4).numFmt = '$0.00';
      row.getCell(5).numFmt = '0.0%';
    }
    if (ui.invest.gic?.length) {
      ps.addRow([]);
      ps.addRow(['GIC rate', 'Rate', 'Updated', 'Checked']).font = { bold: true };
      for (const g of ui.invest.gic) {
        ps.addRow([GIC_PHRASE[g.id] || `${g.institution} ${g.product}`, g.rate / 100, g.updated, g.checked]).getCell(2).numFmt = '0.00%';
      }
    }
    [44, 12, 12, 14, 18].forEach((w, i) => { ps.getColumn(i + 1).width = w; });
  }
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MarketDiscountRates_${from}-${to}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
