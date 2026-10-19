/*
 * Parade of Homes tab — MHBA Parade of Homes magazine listings (2012-present),
 * distilled through the Parade-Of-Homes pipeline into a snapshot shipped
 * under web/public/parade/. Follows the altus-costs pattern: all data on
 * the site, no folder picker. Charts are the shared indicator cards
 * (buildIndicatorCard), so they read like every other tab's: subtitle with
 * range and source, legend beside the plot, hover tip, data table, and
 * legend entries that switch lines off and on.
 *
 * Scope: Winnipeg CMA by default, with an All-Manitoba toggle. Dollars:
 * nominal (as listed) or CPI-adjusted; the snapshot ships both bases from
 * the pipeline. Prices are house-only (land excluded), ex-GST.
 */

import { csvParseRows, autoType } from 'd3';
import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';

const BASE_URL = './parade';
const PREF_KEY = 'parade.v1';

const SCOPES = [
  { key: 'winnipeg', label: 'Winnipeg CMA' },
  { key: 'all',      label: 'All Manitoba' },
];
const BASES = [
  { key: 'nominal', label: 'Nominal' },
  { key: 'real',    label: 'Real (CPI-adjusted)' },
];

const CSV_FILES = [
  'price_trends.csv',
  'size_trends.csv',
  'psf_by_style_year.csv',
  'size_by_style_year.csv',
  'upgrade_by_year.csv',
  'garage_mix.csv',
  'index_comparison.csv',
  'style_mix.csv',
  'lot_trends.csv',
];

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

export async function initParade() {
  const $grid = document.getElementById('po-chart-grid');
  if (!$grid) return;
  ui = {
    $grid,
    $error:    document.getElementById('po-error'),
    $headline: document.getElementById('po-headline'),
    $scope:    document.getElementById('po-scope'),
    $basis:    document.getElementById('po-basis'),
    $realNote: document.getElementById('po-real-note'),
    $from:     document.getElementById('po-year-from'),
    $to:       document.getElementById('po-year-to'),
    manifest:  null,
    datasets:  new Map(),  // "scope_basis" → { priceTrends, sizeTrends, ... }
    prefs:     loadPrefs(),
  };

  try {
    const r = await fetch(`${BASE_URL}/MANIFEST.json`);
    if (!r.ok) throw new Error(`MANIFEST.json HTTP ${r.status}`);
    ui.manifest = await r.json();
  } catch (err) {
    ui.$error.textContent = `Could not load the Parade of Homes snapshot (${err.message}).`;
    ui.$error.hidden = false;
    return;
  }

  wireSidebar();
  render();
}

function scopeKey() {
  const s = ui.prefs.scope && SCOPES.some(x => x.key === ui.prefs.scope) ? ui.prefs.scope : 'winnipeg';
  return s;
}
function basisKey() {
  const b = ui.prefs.basis && BASES.some(x => x.key === ui.prefs.basis) ? ui.prefs.basis : 'nominal';
  return b;
}

// Load the four CSVs for one scope_basis combination the first time it is
// needed, then cache. Returns parsed arrays by role.
async function loadDataset(scope, basis) {
  const key = `${scope}_${basis}`;
  if (ui.datasets.has(key)) return ui.datasets.get(key);
  const parsers = await Promise.all(CSV_FILES.map(async (name) => {
    const r = await fetch(`${BASE_URL}/${key}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return parseCsv(await r.text());
  }));
  const [priceTrends, sizeTrends, psfByStyle, sizeByStyle,
         upgradeByYear, garageMix, indexCmp, styleMix, lotTrends] = parsers;
  const ds = { priceTrends, sizeTrends, psfByStyle, sizeByStyle,
               upgradeByYear, garageMix, indexCmp, styleMix, lotTrends };
  ui.datasets.set(key, ds);
  return ds;
}

// d3's csvParse builds row objects with `new Function`, which the site's CSP
// (script-src 'self', no unsafe-eval) blocks in production.
function parseCsv(text) {
  const [head, ...rows] = csvParseRows(text);
  return rows.map(r => autoType(Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))));
}

function wireSidebar() {
  const scope = scopeKey();
  const basis = basisKey();
  for (const el of ui.$scope.querySelectorAll('input[name="poScope"]')) {
    el.checked = el.value === scope;
  }
  for (const el of ui.$basis.querySelectorAll('input[name="poBasis"]')) {
    el.checked = el.value === basis;
  }
  ui.$scope.addEventListener('change', (e) => {
    if (e.target.name !== 'poScope') return;
    ui.prefs = savePrefs({ scope: e.target.value });
    render();
  });
  ui.$basis.addEventListener('change', (e) => {
    if (e.target.name !== 'poBasis') return;
    ui.prefs = savePrefs({ basis: e.target.value });
    render();
  });
  const onYear = () => {
    let f = Number(ui.$from.value), t = Number(ui.$to.value);
    if (f > t) [f, t] = [t, f];
    ui.$from.value = String(f); ui.$to.value = String(t);
    ui.prefs = savePrefs({ from: f, to: t });
    render();
  };
  ui.$from.addEventListener('change', onYear);
  ui.$to.addEventListener('change', onYear);
  document.getElementById('po-reset')?.addEventListener('click', () => {
    ui.prefs = savePrefs({ scope: null, basis: null, from: null, to: null, hidden: null });
    wireSidebar();
    render();
  });
}

function fillYearPickers(years) {
  const prefs = ui.prefs;
  const from = years.includes(prefs.from) ? prefs.from : years[0];
  const to = years.includes(prefs.to) ? prefs.to : years[years.length - 1];
  for (const [$sel, val] of [[ui.$from, from], [ui.$to, to]]) {
    $sel.replaceChildren(...years.map(y => {
      const o = document.createElement('option');
      o.value = String(y); o.textContent = String(y);
      return o;
    }));
    $sel.value = String(val);
  }
  return { from, to };
}

async function render() {
  const scope = scopeKey();
  const basis = basisKey();
  const scopeLabel = SCOPES.find(s => s.key === scope).label;
  const basisLabel = BASES.find(b => b.key === basis).label;
  ui.$realNote.hidden = basis !== 'real';
  // A newer render may start while this one awaits its CSVs; only the latest draws.
  const token = ui.renderToken = (ui.renderToken || 0) + 1;

  let ds;
  try {
    ds = await loadDataset(scope, basis);
  } catch (err) {
    if (token !== ui.renderToken) return;
    ui.$grid.replaceChildren();
    ui.$error.textContent = `Could not load the ${scope}/${basis} snapshot (${err.message}).`;
    ui.$error.hidden = false;
    return;
  }
  if (token !== ui.renderToken) return;
  ui.$error.hidden = true;

  const years = [...new Set(ds.priceTrends.map(r => r.year))].sort((a, b) => a - b);
  const { from, to } = fillYearPickers(years);

  const latest = ui.manifest.latestIssue || '';
  ui.$headline.innerHTML = `New-home listings pulled from MHBA Parade of Homes magazines, Spring and Fall issues ` +
    `from ${years[0]} through ${latest || years[years.length - 1]}, ${escapeHtml(scopeLabel)}. ` +
    `Figures below are shown in <strong>${escapeHtml(basisLabel.toLowerCase())}</strong> dollars; use the sidebar to switch.`;

  // Carry each card's open panels (data table, explainer) across the rebuild.
  const openPanels = new Map([...ui.$grid.querySelectorAll('.chart-card')]
    .map(el => [el.dataset.chartId, readOpenPanels(el)]));
  ui.$grid.replaceChildren();

  const inRange = (r) => r.year >= from && r.year <= to;
  const issueDate = (r) => r.period_date || `${r.year}-${r.quarter === 1 ? '03' : '09'}-01`;
  const finite = (v) => v != null && Number.isFinite(v);
  const subtitle = `${scopeLabel} — ${basisLabel} dollars`;

  // 1. Median base and selling price, one point per issue.
  {
    const rows = ds.priceTrends.filter(inRange);
    addCard({
      chartId: 'parade_median_price',
      title: 'Median new-home price',
      subtitle,
      description: 'Median listing-reported price per Parade issue, house only (land excluded), ex-GST. ' +
        'Base price is the house as advertised before upgrades; selling price adds the upgrades the listing names.',
      series: [
        { id: 'base',    label: 'Median base price',    units: 'dollar', frequency: 'season',
          points: rows.map(r => [issueDate(r), r.median_base]) },
        { id: 'selling', label: 'Median selling price', units: 'dollar', frequency: 'season',
          points: rows.map(r => [issueDate(r), r.median_selling]) },
      ],
    });
  }

  // Selling-price spread, one point per issue.
  {
    const rows = ds.priceTrends.filter(inRange);
    addCard({
      chartId: 'parade_price_range',
      title: 'Selling price range',
      subtitle,
      description: 'Spread of listing-reported selling prices (house only, ex-GST) per Parade issue: the middle half ' +
        'of listings sits between the 25th and 75th percentile lines. A mean well above the median means a few ' +
        'high-priced show homes are pulling the average up.',
      series: [
        { id: 'p75', label: '75th percentile', key: 'p75_selling' },
        { id: 'median', label: 'Median', key: 'median_selling' },
        { id: 'p25', label: '25th percentile', key: 'p25_selling' },
        { id: 'mean', label: 'Mean', key: 'mean_selling' },
      ].map(({ id, label, key }) => ({
        id, label, units: 'dollar', frequency: 'season',
        points: rows.map(r => [issueDate(r), r[key]]),
      })),
      dashedIds: ['mean'],
    });
  }

  // 2. Median $/sq ft by style, annual.
  {
    const rows = ds.psfByStyle.filter(inRange);
    const styles = [...new Set(rows.map(r => r.style_group))].sort();
    addCard({
      chartId: 'parade_psf_by_style',
      title: 'Median $/sq ft by style',
      subtitle,
      description: 'Annual median price per listed above-grade square foot within each style group. ' +
        'Styles with few listings in a year can swing year to year.',
      series: styles.map(st => ({
        id: st, label: st, units: 'dollar_psf', frequency: 'annual',
        points: rows.filter(r => r.style_group === st).map(r => [`${r.year}-01-01`, r.median_psf]),
      })),
    });
  }

  // 3. Median home size, one point per issue.
  {
    const rows = ds.priceTrends.filter(inRange);
    addCard({
      chartId: 'parade_median_sqft',
      title: 'Median home size (sq ft)',
      subtitle: '',
      description: 'Median above-grade square footage listed per Parade issue (basements excluded).',
      series: [{ id: 'sqft', label: scopeLabel, units: 'units', frequency: 'season',
                 points: rows.map(r => [issueDate(r), r.median_sqft]) }],
      singleSeriesInSubtitle: true,
    });
  }

  // Median home size by style group, annual.
  {
    const rows = ds.sizeByStyle.filter(inRange);
    const styles = [...new Set(rows.map(r => r.style_group))].sort();
    addCard({
      chartId: 'parade_sqft_by_style',
      title: 'Median home size by style (sq ft)',
      subtitle: scopeLabel,
      description: 'Annual median above-grade square footage within each style group (detached single-family homes).',
      series: styles.map(st => ({
        id: st, label: st, units: 'units', frequency: 'annual',
        points: rows.filter(r => r.style_group === st).map(r => [`${r.year}-01-01`, r.median_sqft]),
      })),
    });
  }

  // Style mix: share of each year's listings by style.
  {
    const rows = ds.styleMix.filter(inRange);
    const order = ['2-Storey', 'Bungalow', 'Bi-Level', 'Split-Level', 'Cab-Over', 'Townhouse', 'Other'];
    const styles = [...new Set(rows.map(r => r.style_broad))]
      .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    addCard({
      chartId: 'parade_style_mix',
      title: 'Style mix of listings',
      subtitle: scopeLabel,
      description: 'Share of each year’s Parade listings by house style. A shift in the mix (for example fewer ' +
        'bungalows) moves the overall median price and size even when each style’s own figures hold steady.',
      series: styles.map(st => ({
        id: st, label: st, units: 'percent', frequency: 'annual',
        points: rows.filter(r => r.style_broad === st).map(r => [`${r.year}-01-01`, r.pct * 100]),
      })),
      annualized: false,
    });
  }

  // Lot size and frontage, annual (from matched assessment parcels).
  for (const [chartId, title, key, units, desc] of [
    ['parade_lot_size', 'Median lot size (sq ft)', 'median_lot_sf', 'sf',
      'Annual median lot area of Parade listings matched to City of Winnipeg assessment parcels.'],
    ['parade_lot_frontage', 'Median lot frontage (ft)', 'median_frontage_ft', 'feet',
      'Annual median lot frontage of Parade listings matched to City of Winnipeg assessment parcels.'],
  ]) {
    const rows = ds.lotTrends.filter(inRange);
    addCard({
      chartId, title, subtitle: '', description: desc,
      sources: [
        { citation: 'MHBA Parade of Homes magazine listings (automated extraction with QA review)' },
        { citation: 'City of Winnipeg assessment parcels (lot area and frontage)' },
      ],
      sourceLabel: 'MHBA Parade of Homes; City of Winnipeg assessment',
      series: [{ id: key, label: scopeLabel, units, frequency: 'annual',
                 points: rows.map(r => [`${r.year}-01-01`, r[key]]) }],
      singleSeriesInSubtitle: true,
    });
  }

  // 4. Median upgrade spend, annual.
  {
    const rows = ds.upgradeByYear.filter(inRange);
    addCard({
      chartId: 'parade_upgrade_spend',
      title: 'Median upgrade spend',
      subtitle: `${basisLabel} dollars`,
      description: 'Annual median of upgrade dollars listed on top of the base price, across all listings ' +
        '(zero for listings with no upgrades reported).',
      series: [{ id: 'upgrade', label: scopeLabel, units: 'dollar', frequency: 'annual',
                 points: rows.map(r => [`${r.year}-01-01`, r.median_upgrade_dollars]) }],
      singleSeriesInSubtitle: true,
    });
  }

  // Upgrade shares, annual: the figures the old upgrade tooltip carried.
  {
    const rows = ds.upgradeByYear.filter(inRange);
    addCard({
      chartId: 'parade_upgrade_shares',
      title: 'Upgrades: how often and how much',
      subtitle: scopeLabel,
      description: 'Share of listings that report no upgrades over the base price, and, among listings that do, ' +
        'the median upgrade amount as a percent of the base price.',
      series: [
        { id: 'none', label: 'Listings with no upgrades', key: 'share_no_upgrades' },
        { id: 'pct', label: 'Median upgrade, % of base (when upgraded)', key: 'median_upgrade_pct_when_upgraded' },
      ].map(({ id, label, key }) => ({
        id, label, units: 'percent', frequency: 'annual',
        points: rows.map(r => [`${r.year}-01-01`, finite(r[key]) ? r[key] * 100 : null]),
      })),
      annualized: false,
    });
  }

  // 5. Parade price index vs CPI, NHPI and BCPI, annual.
  {
    const rows = ds.indexCmp.filter(inRange);
    const order = [...new Set(rows.map(r => r.series))];
    const base = rows.find(r => r.base_year)?.base_year || '';
    addCard({
      chartId: 'parade_index_vs_cpi',
      title: 'Parade price index vs CPI',
      subtitle: `${scopeLabel} — rebased to ${base} = 100`,
      description: 'Parade median selling price and $/sq ft (house only, ex-GST) against Canada all-items CPI, ' +
        'the Winnipeg new housing price index and the Winnipeg building construction price index, each rebased so ' +
        'the base year reads 100. Reads how fast new-home listing prices moved compared to inflation and to ' +
        'Statistics Canada\'s own new-home and construction-cost measures.',
      sources: [
        { citation: 'MHBA Parade of Homes magazine listings (automated extraction with QA review)' },
        { citation: 'Statistics Canada, Table 18-10-0005-01 (CPI, annual average)' },
        { citation: 'Statistics Canada, Table 18-10-0205-01 (New housing price index)' },
        { citation: 'Statistics Canada, Table 18-10-0289-01 (Building construction price indexes)' },
      ],
      sourceLabel: 'MHBA Parade of Homes; Statistics Canada',
      series: order.map((name, i) => ({
        id: `idx${i}`, label: name, units: 'index', frequency: 'annual',
        points: rows.filter(r => r.series === name).map(r => [`${r.year}-01-01`, r.index_rebased]),
      })),
    });
  }

  // Listings per issue: the sample behind every figure above.
  {
    const rows = ds.priceTrends.filter(inRange);
    addCard({
      chartId: 'parade_listings_count',
      title: 'Listings per issue',
      subtitle: '',
      description: 'Number of Parade listings in each Spring and Fall issue. Fewer listings mean each median above ' +
        'rests on a smaller sample and can move more from one issue to the next.',
      series: [{ id: 'n', label: scopeLabel, units: 'units', frequency: 'season',
                 points: rows.map(r => [issueDate(r), r.n]) }],
      singleSeriesInSubtitle: true,
      annualized: false,
    });
  }

  function addCard({ chartId, title, subtitle, description, series, sources, sourceLabel,
                     singleSeriesInSubtitle = false, annualized = true, dashedIds = [] }) {
    const hiddenPref = (ui.prefs.hidden || {})[chartId] || [];
    const card = buildIndicatorCard(ui.$grid, {
      chartId,
      fileStem: chartId,
      title,
      sourceLabel: sourceLabel || 'MHBA Parade of Homes magazine listings',
      description,
      sources: sources || [{ citation: 'MHBA Parade of Homes magazine listings, Spring and Fall issues (automated extraction with QA review)' }],
      table: true,
      zeroBased: true,
      xLabel: 'Year',
      toggleLegend: true,
      hiddenSeries: hiddenPref,
      onLegendToggle: (ids) => {
        ui.prefs = savePrefs({ hidden: { ...(ui.prefs.hidden || {}), [chartId]: ids } });
      },
    });
    const records = [];
    const seriesMeta = [];
    for (const s of series) {
      const pts = s.points.filter(([, v]) => finite(v));
      if (!pts.length) continue;
      for (const [date, value] of pts) records.push({ id: s.id, date, value });
      seriesMeta.push({ id: s.id, chartLabel: s.label, units: s.units, frequency: s.frequency });
    }
    card.render(records, seriesMeta, {
      subtitle,
      singleSeriesInSubtitle,
      annualized,
      dashedIds,
      dots: true,
    });
    card.setOpenPanels(openPanels.get(chartId) || []);
  }
}
