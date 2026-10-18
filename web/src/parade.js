/*
 * Parade of Homes tab — MHBA Parade of Homes magazine listings (2012-present),
 * distilled through the Parade-Of-Homes pipeline into a snapshot shipped
 * under web/public/parade/. Follows the altus-costs pattern: all data on
 * the site, no folder picker, each chart its own section with themed
 * Observable Plot.
 *
 * Scope: Winnipeg CMA by default, with an All-Manitoba toggle. Dollars:
 * nominal (as listed) or CPI-adjusted; the snapshot ships both bases from
 * the pipeline. Prices are house-only (land excluded), ex-GST.
 */

import * as Plot from '@observablehq/plot';
import { csvParseRows, autoType } from 'd3';
import { themed, gridMarks, frameMark, PALETTE } from './plot-theme.js';
import { downloadCard } from './chart.js';
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
];

let ui = null;

const fmtUsdK = (v) => (v == null || !Number.isFinite(v) ? '**' : `$${Math.round(v / 1000)}k`);
const fmtUsd  = (v) => (v == null || !Number.isFinite(v) ? '**' : `$${Math.round(v).toLocaleString('en-CA')}`);
const fmtSqft = (v) => (v == null || !Number.isFinite(v) ? '**' : `${Math.round(v).toLocaleString('en-CA')}`);
const fmtPct  = (v) => (v == null || !Number.isFinite(v) ? '**' : `${(v * 100).toFixed(1)}%`);
const fmtIdx  = (v) => (v == null || !Number.isFinite(v) ? '**' : v.toFixed(1));

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
         upgradeByYear, garageMix, indexCmp] = parsers;
  const ds = { priceTrends, sizeTrends, psfByStyle, sizeByStyle,
               upgradeByYear, garageMix, indexCmp };
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
    ui.prefs = savePrefs({ scope: null, basis: null, from: null, to: null });
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
  ui.$grid.replaceChildren();
  ui.$error.hidden = true;

  const years = [...new Set(ds.priceTrends.map(r => r.year))].sort((a, b) => a - b);
  const { from, to } = fillYearPickers(years);

  const latest = ui.manifest.latestIssue || '';
  ui.$headline.innerHTML = `New-home listings pulled from MHBA Parade of Homes magazines, Spring and Fall issues ` +
    `from ${years[0]} through ${latest || years[years.length - 1]}, ${escapeHtml(scopeLabel)}. ` +
    `Figures below are shown in <strong>${escapeHtml(basisLabel.toLowerCase())}</strong> dollars; use the sidebar to switch.`;

  // Apply the year range to each series.
  const inRange = (r) => r.year >= from && r.year <= to;
  const period = (r) => r.period_date || `${r.year}-${r.quarter === 1 ? '03' : '09'}-01`;

  // 1. Median base price over time (one point per issue).
  {
    const rows = ds.priceTrends.filter(inRange).map(r => ({
      date: new Date(period(r)),
      label: r.period_label || `${r.year} Q${r.quarter}`,
      value: r.median_base,
    })).filter(d => d.value != null && Number.isFinite(d.value));
    buildLineCard({
      id: 'po_median_base_price',
      title: 'Median base price',
      subtitle: `${scopeLabel} — ${basisLabel} dollars, ${from} to ${to}`,
      note: 'Median listing-reported "base price" (house only, ex-GST, land excluded). One point per Parade issue.',
      yLabel: `${basisLabel} CA$`,
      yFmt: fmtUsdK,
      tooltipFmt: fmtUsd,
      rows,
      colour: PALETTE[0],
    });
  }

  // 2. Median $/sq ft by style (line per style).
  {
    const rows = ds.psfByStyle.filter(inRange).map(r => ({
      date: new Date(`${r.year}-07-01`),
      label: r.style_group,
      value: r.median_psf,
      n: r.n,
    })).filter(d => d.value != null && Number.isFinite(d.value));
    const styles = [...new Set(rows.map(r => r.label))].sort();
    buildCategoryLineCard({
      id: 'po_psf_by_style',
      title: 'Median $/sq ft by style',
      subtitle: `${scopeLabel} — ${basisLabel} dollars per listed sq ft, ${from} to ${to}`,
      note: 'Annual median $/sq ft within each style group. Styles with few listings in a year can swing year to year.',
      yLabel: `${basisLabel} CA$ / sq ft`,
      yFmt: (v) => `$${Math.round(v)}`,
      tooltipFmt: (v) => `$${v.toFixed(2)}`,
      rows,
      categories: styles,
    });
  }

  // 3. Median sq ft trend (one point per issue).
  {
    const rows = ds.priceTrends.filter(inRange).map(r => ({
      date: new Date(period(r)),
      label: r.period_label || `${r.year} Q${r.quarter}`,
      value: r.median_sqft,
    })).filter(d => d.value != null && Number.isFinite(d.value));
    buildLineCard({
      id: 'po_median_sqft',
      title: 'Median home size',
      subtitle: `${scopeLabel} — ${from} to ${to}`,
      note: 'Median above-grade square footage listed per Parade issue (basements excluded).',
      yLabel: 'Square feet',
      yFmt: fmtSqft,
      tooltipFmt: fmtSqft,
      rows,
      colour: PALETTE[2],
    });
  }

  // 4. Median upgrade spend (annual).
  {
    const rows = ds.upgradeByYear.filter(inRange).map(r => ({
      date: new Date(`${r.year}-07-01`),
      label: String(r.year),
      value: r.median_upgrade_dollars,
      pct: r.median_upgrade_pct_when_upgraded,
      noneShare: r.share_no_upgrades,
    })).filter(d => d.value != null && Number.isFinite(d.value));
    buildLineCard({
      id: 'po_upgrade_spend',
      title: 'Median upgrade spend',
      subtitle: `${scopeLabel} — ${basisLabel} dollars, ${from} to ${to}`,
      note: 'Annual median of upgrade dollars listed on top of the base price (across all listings — zero for listings with no upgrades reported).',
      yLabel: `${basisLabel} CA$`,
      yFmt: fmtUsdK,
      tooltipFmt: (v, d) => `${fmtUsd(v)} · ${fmtPct(d.pct)} when upgraded · ${fmtPct(d.noneShare)} with no upgrades`,
      rows,
      colour: PALETTE[3],
    });
  }

  // 5. Construction cost vs CPI index (two-series line).
  {
    const rows = ds.indexCmp.filter(inRange).map(r => ({
      date: new Date(`${r.year}-07-01`),
      label: r.series,
      value: r.index_rebased,
      base: r.base_year,
    })).filter(d => d.value != null && Number.isFinite(d.value));
    const seriesOrder = [...new Set(rows.map(r => r.label))];
    const base = rows[0]?.base || '';
    buildCategoryLineCard({
      id: 'po_index_vs_cpi',
      title: 'Parade price index vs CPI',
      subtitle: `${scopeLabel} — rebased to ${base} = 100, ${from} to ${to}`,
      note: 'Parade median selling price and $/sq ft (house only, ex-GST) against Canada all-items CPI, each rebased so the base year reads 100. Reads how fast new-home listing prices moved compared to broad inflation.',
      yLabel: `Index (${base} = 100)`,
      yFmt: fmtIdx,
      tooltipFmt: fmtIdx,
      rows,
      categories: seriesOrder,
    });
  }
}

// --- Chart cards -------------------------------------------------------------

/**
 * One-series line + dot card, titled above a themed plot with a short
 * descriptive note and a PNG download.
 */
function buildLineCard({ id, title, subtitle, note, yLabel, yFmt, tooltipFmt, rows, colour }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <p class="text-xs text-neutral-500 mt-2 max-w-prose">${escapeHtml(note)}</p>
    <div class="chart-caption">
      <span class="chart-caption-left"></span>
      <span class="chart-source">Source: MHBA Parade of Homes magazine listings (automated extraction).</span>
    </div>
    <div class="chart-actions flex gap-3">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  ui.$grid.appendChild(card);
  const $plot = card.querySelector('[data-role="plot"]');
  if (!rows.length) {
    $plot.innerHTML = '<p class="text-sm text-neutral-500 px-2">No data in the selected years.</p>';
  } else {
    const maxV = Math.max(...rows.map(r => r.value));
    const minV = Math.min(...rows.map(r => r.value));
    const pad = Math.max((maxV - minV) * 0.08, maxV * 0.03);
    $plot.appendChild(Plot.plot(themed({
      height: 300, marginBottom: 36, marginLeft: 72, marginRight: 16,
      x: { label: null, tickFormat: '%Y' },
      y: { label: yLabel, grid: true, tickFormat: yFmt,
           domain: [Math.max(0, minV - pad), maxV + pad] },
      marks: [
        ...gridMarks(),
        Plot.lineY(rows, { x: 'date', y: 'value', stroke: colour, strokeWidth: 2,
                           sort: { channel: 'x' } }),
        Plot.dot(rows, { x: 'date', y: 'value', fill: colour, r: 3,
                         title: (d) => `${d.label}: ${tooltipFmt(d.value, d)}` }),
        frameMark(),
      ],
    })));
  }
  card.querySelector('[data-role="dl-png"]').onclick = () =>
    downloadCard(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`);
  return card;
}

/**
 * Multi-series line card, one coloured line per category (style group, index
 * series, etc.). Categories are coloured in order from PALETTE and shown in a
 * legend via Plot's default colour legend.
 */
function buildCategoryLineCard({ id, title, subtitle, note, yLabel, yFmt, tooltipFmt, rows, categories }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <p class="text-xs text-neutral-500 mt-2 max-w-prose">${escapeHtml(note)}</p>
    <div class="chart-caption">
      <span class="chart-caption-left"></span>
      <span class="chart-source">Source: MHBA Parade of Homes magazine listings (automated extraction).</span>
    </div>
    <div class="chart-actions flex gap-3">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  ui.$grid.appendChild(card);
  const $plot = card.querySelector('[data-role="plot"]');
  if (!rows.length) {
    $plot.innerHTML = '<p class="text-sm text-neutral-500 px-2">No data in the selected years.</p>';
  } else {
    const range = categories.map((_, i) => PALETTE[i % PALETTE.length]);
    const maxV = Math.max(...rows.map(r => r.value));
    const minV = Math.min(...rows.map(r => r.value));
    const pad = Math.max((maxV - minV) * 0.08, maxV * 0.03);
    $plot.appendChild(Plot.plot(themed({
      height: 320, marginBottom: 36, marginLeft: 72, marginRight: 16,
      x: { label: null, tickFormat: '%Y' },
      y: { label: yLabel, grid: true, tickFormat: yFmt,
           domain: [Math.max(0, minV - pad), maxV + pad] },
      color: { domain: categories, range, legend: true },
      marks: [
        ...gridMarks(),
        Plot.lineY(rows, { x: 'date', y: 'value', stroke: 'label', strokeWidth: 1.8,
                           sort: { channel: 'x' } }),
        Plot.dot(rows, { x: 'date', y: 'value', fill: 'label', r: 2.6,
                         title: (d) => `${d.label} · ${d.date.getUTCFullYear()}: ${tooltipFmt(d.value, d)}${d.n ? ` (n = ${d.n})` : ''}` }),
        frameMark(),
      ],
    })));
  }
  card.querySelector('[data-role="dl-png"]').onclick = () =>
    downloadCard(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`);
  return card;
}
