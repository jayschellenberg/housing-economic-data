/*
 * analysis.js — the Analysis tab. All the arithmetic is in
 * lib/analysis.js; this renders it as the site's chart cards
 * (../../src/subapp-chart-card.js — Observable Plot, the site theme, the
 * Company caption, a 1950 × 1050 PNG), loaded on first open (Plot + d3 are
 * ~400 kB and most visits never open this).
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
import { kpiTile } from './kpiTile.js';

const $ = (id) => document.getElementById(id);
const MISSING = '**';   // the site's table convention for no value
const fmtInt = (n) => (n == null ? MISSING : Math.round(n).toLocaleString('en-CA'));
const fmtRate = (n) => (n == null ? MISSING : `$${Number(n).toFixed(2)}`);
const fmtMoney = (n) => (n == null ? MISSING : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtPct = (n) => (n == null ? MISSING : `${(n * 100).toFixed(0)}%`);

let kit = null;   // src/subapp-chart-card.js: { Plot, buildPlotCard, … }
async function ensureKit() {
  if (!kit) kit = await import('../../src/subapp-chart-card.js');
  return kit;
}

const ALL_BANDS = [...BAND_ORDER, 'unknown'];
const bandColor = (b) => BAND_COLORS[b] || BAND_COLORS.unknown;
const presentBands = (rows) => ALL_BANDS.filter((b) => rows.some((r) => r.band === b));
const legendFor = (bands) => bands.map((b) => ({ label: b, color: bandColor(b) }));
const colorFor = (bands) => ({ domain: bands, range: bands.map(bandColor) });
// Latest-value readout: each type's value in its last period.
const latestFor = (rows, bands, fmt) => bands.map((b) => {
  const lastRow = rows.filter((r) => r.band === b).reduce((a, r) => (!a || r.bucket > a.bucket ? r : a), null);
  return lastRow && { label: b, color: bandColor(b), value: fmt(lastRow.value), asof: lastRow.bucket };
}).filter(Boolean);

export function initAnalysis({ getContext } = {}) {
  let open = false;
  let dirty = true;
  let cards = null;
  let rendering = Promise.resolve();

  // Built once, on the first render, into the two headed groups of
  // #an-charts (Market trend, Asking rates & sizes).
  function ensureCards() {
    if (cards) return cards;
    // `id` is what the sidebar jump list scrolls to.
    const make = (host, key, title, fileStem, explainer) => kit.buildPlotCard($(host), { id: `an-card-${key}`, title, fileStem, explainer });
    cards = {
      rate: make('an-charts-trend', 'rate', 'Median asking rate', 'commercial_median_rate',
        'The middle asking lease rate ($ per square foot per year) of the listings on the market in each period, one line per property type. Half asked more and half less, so one trophy building does not drag it around. Asking rates are a landlord’s opening position; signed deals usually come in lower and carry incentives these listings do not show.'),
      count: make('an-charts-trend', 'count', 'Listings on the market', 'commercial_listings_on_market',
        'How many of these listings were on the market in each period, stacked by property type. More listings can mean rising availability, but the tracked brokerages have grown over time, so part of any rise is wider coverage rather than more space for lease or sale.'),
      dist: make('an-charts-rates', 'dist', 'Distribution of asking rates', 'commercial_rate_distribution',
        'How the selection’s lease rates spread out. A tight peak means most space asks a similar rate; a wide or two-humped shape usually means the selection mixes building classes or property types worth looking at separately.'),
      scatter: make('an-charts-rates', 'scatter', 'Rate against size', 'commercial_rate_vs_size',
        'Each dot is one lease listing with both a size and a rate. Size is on a log scale so small bays and large blocks both fit. Smaller spaces usually ask more per square foot; a subject well off the cloud for its size and type deserves a second look.'),
    };
    return cards;
  }

  const $granularity = $('an-granularity');
  const $geo = $('an-geo');

  function render() {
    rendering = renderNow();
    return rendering;
  }

  async function renderNow() {
    const ctx = getContext?.();
    if (!ctx || !ctx.bundle) return;
    const { bundle, rows } = ctx;
    const { manifest, runs } = bundle;
    const bands = policy(manifest);
    const { Plot: P } = await ensureKit();

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
        [changes.medianChangePct == null ? MISSING : `${changes.medianChangePct > 0 ? '+' : ''}${changes.medianChangePct.toFixed(1)}%`,
          'median change', `${fmtInt(changes.cuts)} down · ${fmtInt(changes.raises)} up`],
      ]) {
        tiles.appendChild(kpiTile({ tag: 'li', label, value, meta: [note] }));
      }
    }

    // --- charts ------------------------------------------------------
    const c = ensureCards();
    const published = manifest.generated_at ? String(manifest.generated_at).slice(0, 10) : '';
    const source = `Commercial availability listings${published ? ` (published ${published})` : ''}`;
    const per = { month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' }[granularity] || '';
    const scope = ctx.marketLabel ? `Listings ${ctx.marketLabel}` : 'Current selection';
    // Period buckets are labels ("2026-Q3"), not numbers: let Plot format them.
    // Label at most ~12 of them, or thirty-odd quarters print on top of each other.
    const bucketX = (rows) => {
      const all = [...new Set(rows.map((d) => d.bucket))].sort();
      const step = Math.max(1, Math.ceil(all.length / 12));
      return { label: null, tickRotate: -40, tickFormat: undefined, ticks: all.filter((_, i) => i % step === 0) };
    };

    // The trend reads the HISTORY, so it is not restricted to what is on
    // the market today: it is every cycle these listings were on it.
    const series = marketByCycle(rows, runs, manifest, { granularity });
    const rateRows = bandSeries(series, 'medianRate');
    const rateBands = presentBands(rateRows);
    c.rate.render({
      subtitle: `${scope} • ${per} median asking rate by type`, source, legend: legendFor(rateBands),
      latest: latestFor(rateRows, rateBands, (v) => `$${v.toFixed(2)}/sf/yr`),
      empty: rateRows.length ? '' : 'No asking rates in this selection to trend.',
      spec: () => ({
        marginBottom: 56,
        x: bucketX(rateRows),
        y: { label: 'Asking rate ($/sf/yr)', zero: false, tickFormat: (v) => `$${v.toFixed(0)}` },
        color: colorFor(rateBands),
        marks: [
          P.line(rateRows, { x: 'bucket', y: 'value', stroke: 'band', strokeWidth: 2.4 }),
          P.dot(rateRows, { x: 'bucket', y: 'value', fill: 'band', r: 2.6, tip: true, title: (d) => `${d.band} ${d.bucket}: $${d.value.toFixed(2)} (n=${d.n})` }),
        ],
      }),
    });

    const countRows = bandSeries(series, 'onMarket');
    const countBands = presentBands(countRows);
    // The count chart's slope is the one number here a reader can most
    // easily mistake for a market fact.
    const coverage = coverageNote(series);
    c.count.render({
      subtitle: `${scope} • ${per} count by type`, source, legend: legendFor(countBands),
      latest: latestFor(countRows, countBands, (v) => v.toLocaleString('en-CA')),
      note: coverage
        ? `Coverage grew from ${coverage.fromCount} brokerage${coverage.fromCount === 1 ? '' : 's'} `
          + `in ${coverage.from} to ${coverage.toCount} in ${coverage.to}. Part of the rise in `
          + `listings is more sources being tracked, not more space coming to market.`
        : '',
      empty: countRows.length ? '' : 'No history for this selection.',
      spec: () => ({
        marginBottom: 56,
        x: bucketX(countRows),
        y: { label: 'Listings', tickFormat: (v) => v.toLocaleString('en-CA') },
        color: colorFor(countBands),
        marks: [
          P.areaY(countRows, { x: 'bucket', y: 'value', fill: 'band', fillOpacity: 0.8, order: ALL_BANDS, tip: true, title: (d) => `${d.band} ${d.bucket}: ${d.value}` }),
          P.ruleY([0]),
        ],
      }),
    });

    const rates = rows.map(rateOf);
    const bins = distribution(rates, { bins: 24, band: bands.leaseRate });
    c.dist.render({
      subtitle: `${scope} • lease listings by asking rate`, source,
      empty: bins.length ? '' : 'No lease rates in this selection.',
      spec: () => ({
        marginBottom: 46,
        x: { label: 'Asking rate ($/sf/yr)', tickFormat: (v) => `$${v}` },
        y: { label: 'Listings', tickFormat: (v) => v.toLocaleString('en-CA') },
        marks: [
          P.rectY(bins, { x1: 'x0', x2: 'x1', y: 'n', fill: BAND_COLORS.Office, fillOpacity: 0.85, tip: true, title: (d) => `$${d.x0}–$${d.x1}: ${d.n}` }),
          P.ruleY([0]),
        ],
      }),
    });

    const scatter = rateVsSize(rows, manifest);
    const scatterBands = presentBands(scatter);
    c.scatter.render({
      subtitle: `${scope} • asking rate against size (log scale)`, source, legend: legendFor(scatterBands),
      empty: scatter.length ? '' : 'Nothing with both a size and a rate in this selection.',
      spec: () => ({
        marginBottom: 46,
        // Size spans four orders of magnitude; on a linear axis every
        // small unit piles into the left edge.
        x: { label: 'Size (sf)', type: 'log', tickFormat: (v) => v.toLocaleString('en-CA') },
        y: { label: 'Asking rate ($/sf/yr)', zero: false, tickFormat: (v) => `$${v.toFixed(0)}` },
        color: colorFor(scatterBands),
        marks: [P.dot(scatter, {
          x: 'size', y: 'rate', fill: 'band', r: 2.6, fillOpacity: 0.7, tip: true,
          title: (d) => `${d.address}\n${Math.round(d.size).toLocaleString('en-CA')} sf · $${d.rate.toFixed(2)}`,
        })],
      }),
    });

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
          [m.medianSize == null ? MISSING : `${fmtInt(m.medianSize)} sf`, 'num'],
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

  return { invalidate, render, setOpen, isOpen: () => open, ready: () => rendering };
}
