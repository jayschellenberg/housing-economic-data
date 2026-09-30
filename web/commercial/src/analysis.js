/*
 * analysis.js — the Analysis tab. All the arithmetic is in
 * lib/analysis.js; this renders it with Observable Plot, which is loaded
 * on first open (Plot + d3 are ~400 kB and most visits never open this).
 *
 * Every chart is drawn from the CURRENT filtered set, so the tab always
 * answers "for the listings I am looking at", and every number that a
 * band would have suppressed stays suppressed here too.
 */

import {
  marketByCycle, bandSeries, byMarket, distribution, priceChanges,
  timeOnMarket, rateVsSize, coverageNote,
} from './lib/analysis.js';
import { policy } from './lib/summary.js';
import { BAND_COLORS, BAND_ORDER } from './lib/bands.js';
import { rateOf } from './lib/filters.js';

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-CA'));
const fmtRate = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const fmtMoney = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtPct = (n) => (n == null ? '—' : `${(n * 100).toFixed(0)}%`);

let Plot = null;
async function ensurePlot() {
  if (!Plot) Plot = await import('@observablehq/plot');
  return Plot;
}

const bandColorScale = {
  color: {
    domain: [...BAND_ORDER, 'unknown'],
    range: [...BAND_ORDER.map((b) => BAND_COLORS[b]), BAND_COLORS.unknown],
    legend: true,
  },
};

function place(id, node) {
  const host = $(id);
  if (!host) return;
  host.textContent = '';
  if (node) host.appendChild(node);
}

function empty(message) {
  const p = document.createElement('p');
  p.className = 'muted small';
  p.textContent = message;
  return p;
}

export function initAnalysis({ getContext } = {}) {
  let open = false;
  let dirty = true;

  const $granularity = $('an-granularity');
  const $geo = $('an-geo');

  async function render() {
    const ctx = getContext?.();
    if (!ctx || !ctx.bundle) return;
    const { bundle, rows } = ctx;
    const { manifest, runs } = bundle;
    const bands = policy(manifest);
    const P = await ensurePlot();

    const granularity = $granularity?.value || 'quarter';
    const geoField = $geo?.value || 'municipality';

    // --- headline ------------------------------------------------------
    const changes = priceChanges(rows, runs, manifest);
    const tom = timeOnMarket(rows);
    const tiles = $('an-tiles');
    if (tiles) {
      tiles.textContent = '';
      for (const [value, label, note] of [
        [fmtInt(rows.length), 'listings in view', ctx.marketLabel],
        [fmtInt(tom.median), 'median months on market', `n=${fmtInt(tom.n)}`],
        [fmtPct(changes.shareChanged), 'changed their asking price', `${fmtInt(changes.changed)} of ${fmtInt(changes.withHistory)} priced`],
        [changes.medianChangePct == null ? '—' : `${changes.medianChangePct > 0 ? '+' : ''}${changes.medianChangePct.toFixed(1)}%`,
          'median change', `${fmtInt(changes.cuts)} down · ${fmtInt(changes.raises)} up`],
      ]) {
        const li = document.createElement('li');
        const v = document.createElement('span'); v.className = 'tile-value'; v.textContent = value;
        const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
        const n = document.createElement('span'); n.className = 'tile-note'; n.textContent = note || '';
        li.append(v, l, n);
        tiles.appendChild(li);
      }
    }

    // --- trends --------------------------------------------------------
    // The trend reads the HISTORY, so it is not restricted to what is on
    // the market today: it is every cycle these listings were on it.
    const series = marketByCycle(rows, runs, manifest, { granularity });
    const rateRows = bandSeries(series, 'medianRate');
    place('an-trend-rate', rateRows.length
      ? P.plot({
        marginLeft: 52, marginBottom: 40, height: 260, width: 640,
        x: { label: null, tickRotate: -40 },
        y: { label: 'median asking $/sf/yr', grid: true, zero: false },
        ...bandColorScale,
        marks: [
          P.line(rateRows, { x: 'bucket', y: 'value', stroke: 'band', strokeWidth: 1.8 }),
          P.dot(rateRows, { x: 'bucket', y: 'value', fill: 'band', r: 2.2, title: (d) => `${d.band} ${d.bucket}: $${d.value.toFixed(2)} (n=${d.n})` }),
        ],
      })
      : empty('No asking rates in this selection to trend.'));

    const countRows = bandSeries(series, 'onMarket');
    place('an-trend-count', countRows.length
      ? P.plot({
        marginLeft: 52, marginBottom: 40, height: 260, width: 640,
        x: { label: null, tickRotate: -40 },
        y: { label: 'listings on the market', grid: true },
        ...bandColorScale,
        marks: [
          P.areaY(countRows, { x: 'bucket', y: 'value', fill: 'band', fillOpacity: 0.75, order: BAND_ORDER }),
          P.ruleY([0]),
        ],
      })
      : empty('No history for this selection.'));

    // The count chart's slope is the one number here a reader can most
    // easily mistake for a market fact.
    const coverage = coverageNote(series);
    const $coverage = $('an-coverage');
    if ($coverage) {
      $coverage.textContent = coverage
        ? `Coverage grew from ${coverage.fromCount} brokerage${coverage.fromCount === 1 ? '' : 's'} `
          + `in ${coverage.from} to ${coverage.toCount} in ${coverage.to}. Part of the rise in `
          + `listings is more sources being tracked, not more space coming to market.`
        : '';
      $coverage.hidden = !coverage;
    }

    // --- distribution + scatter ----------------------------------------
    const rates = rows.map(rateOf);
    const bins = distribution(rates, { bins: 24, band: bands.leaseRate });
    place('an-distribution', bins.length
      ? P.plot({
        marginLeft: 52, marginBottom: 40, height: 240, width: 480,
        x: { label: 'asking $/sf/yr' },
        y: { label: 'listings', grid: true },
        marks: [
          P.rectY(bins, { x1: 'x0', x2: 'x1', y: 'n', fill: BAND_COLORS.Office, fillOpacity: 0.85 }),
          P.ruleY([0]),
        ],
      })
      : empty('No lease rates in this selection.'));

    const scatter = rateVsSize(rows, manifest);
    place('an-scatter', scatter.length
      ? P.plot({
        marginLeft: 52, marginBottom: 40, height: 240, width: 480,
        // Size spans four orders of magnitude; on a linear axis every
        // small unit piles into the left edge.
        x: { label: 'size (sf)', type: 'log', grid: true },
        y: { label: 'asking $/sf/yr', grid: true, zero: false },
        ...bandColorScale,
        marks: [P.dot(scatter, {
          x: 'size', y: 'rate', fill: 'band', r: 2.6, fillOpacity: 0.7,
          title: (d) => `${d.address}\n${Math.round(d.size).toLocaleString('en-CA')} sf · $${d.rate.toFixed(2)}`,
        })],
      })
      : empty('Nothing with both a size and a rate in this selection.'));

    // --- by market -----------------------------------------------------
    const markets = byMarket(rows, manifest, geoField);
    const tbody = $('an-market-table')?.querySelector('tbody');
    if (tbody) {
      tbody.textContent = '';
      for (const m of markets.slice(0, 25)) {
        const tr = document.createElement('tr');
        for (const [text, cls, title] of [
          [m.name, ''],
          [fmtInt(m.total), 'num'],
          [fmtInt(m.lease), 'num'],
          [fmtInt(m.sale), 'num'],
          [m.medianRate == null && m.suppressed ? `n=${m.ratedN}` : fmtRate(m.medianRate), 'num',
            m.suppressed ? `Fewer than ${bands.minN} priced listings — too thin to publish a median.` : ''],
          [fmtMoney(m.medianPrice), 'num'],
          [m.medianSize == null ? '—' : `${fmtInt(m.medianSize)} sf`, 'num'],
        ]) {
          const td = document.createElement('td');
          td.textContent = text;
          if (cls) td.className = cls;
          if (title) { td.title = title; td.classList.add('suppressed'); }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    const note = $('an-note');
    if (note) {
      note.textContent = `Trends read the price and status history, so they cover every cycle these `
        + `listings were on the market — not only ${manifest.cycles?.last}. `
        + `Medians need at least ${bands.minN} priced listings; rates outside `
        + `$${bands.leaseRate?.[0]}–$${bands.leaseRate?.[1]}/sf/yr and sizes outside `
        + `${fmtInt(bands.size?.[0])}–${fmtInt(bands.size?.[1])} sf are left out of every measure here.`;
    }
    dirty = false;
  }

  function invalidate() {
    dirty = true;
    if (open) render();
  }

  $granularity?.addEventListener('change', render);
  $geo?.addEventListener('change', render);

  // The Analysis TAB decides visibility now (tabs.js); this module only
  // needs to know whether it is on screen, so charts build on first view
  // rather than on every filter change nobody is looking at.
  function setOpen(next) {
    open = Boolean(next);
    if (open && dirty) render();
  }

  return { invalidate, render, setOpen, isOpen: () => open };
}
