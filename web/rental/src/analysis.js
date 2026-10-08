/*
 * analysis.js — the Analysis tab: KPI tiles per bedroom band, a by-market
 * table, trend lines (median rent, $/sf, active inventory) from the rent
 * runs, the rent distribution, rent vs size, and other rental statistics.
 *
 * Scope pill: "Selection" is whatever the filters currently match;
 * "All Manitoba" is the default view (active, canonical, in scope) so a
 * selection can be read against the province. Charts are the site's chart
 * cards (../../src/subapp-chart-card.js — Observable Plot, the site theme,
 * Company caption, 1950 × 1050 PNG), loaded on first use so the listings
 * tab never pays for them.
 */

import { bandStats, marketTable, trendSeries, histogram, sizePoints, otherStats, MARKET_KEYS } from './lib/analysis.js';
import { BAND_ORDER, BAND_COLORS, BAND_LABELS } from './lib/bands.js';
import { tableWordHtml, tableWordText, tableCsv } from './lib/exports.js';
import { copyRich, downloadBlob, stamp } from './exports.js';
import { kpiTile } from './kpiTile.js';

const MISSING = '**';   // the site's table convention for no value
const fmtInt = (n) => (n == null ? MISSING : Math.round(n).toLocaleString('en-CA'));
const fmtMoney = (n) => (n == null ? MISSING : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtPsf = (n) => (n == null ? MISSING : `$${n.toFixed(2)}`);
const fmtPct = (n, dp = 0) => (n == null ? MISSING : `${(n * 100).toFixed(dp)}%`);
const fmtSignedPct = (n) => (n == null ? MISSING : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);

const SERIES = [...BAND_ORDER, 'all'];
const SERIES_COLORS = { ...BAND_COLORS, all: '#18181b' };

export function initAnalysis({ getPolicy, getContext, setStatus } = {}) {
  const $ = (id) => document.getElementById(id);
  const $scope = $('an-scope');
  const $gran = $('an-gran');
  const $summary = $('an-summary');
  const $kpis = $('an-kpis');
  const $marketBy = $('an-market-by');
  const $marketTable = $('an-market-table');
  const $marketCopy = $('an-market-copy');
  const $bandTable = $('an-band-table');
  const $bandCopy = $('an-band-copy');
  const $other = $('an-other');
  const $sources = $('an-sources');
  const $trendNote = $('an-trend-note');

  let data = { filtered: [], all: [], listings: [], segments: [] };
  let scope = 'selection';
  let gran = 'month';
  let visible = false;
  let dirty = true;
  let kit = null;          // src/subapp-chart-card.js: { Plot, buildPlotCard, … }
  let kitLoading = null;
  let rendering = Promise.resolve();

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  for (const [el, setter] of [[$scope, (v) => { scope = v; }], [$gran, (v) => { gran = v; }]]) {
    el?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      setter(b.dataset.mode);
      for (const x of el.querySelectorAll('[data-mode]')) {
        const on = x === b;
        x.setAttribute('aria-pressed', String(on));
        x.classList.toggle('active', on);
      }
      dirty = true;
      render();
    });
  }
  for (const [k, v] of Object.entries(MARKET_KEYS)) {
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; $marketBy.appendChild(o);
  }
  $marketBy.addEventListener('change', () => { dirty = true; render(); });

  const rows = () => (scope === 'all' ? data.all : data.filtered);
  const scopeLabel = () => (scope === 'all' ? 'All Manitoba (active, one row per unit)' : 'Current selection');

  function td(text, cls) { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }
  function th(text, cls) { const c = document.createElement('th'); c.textContent = text; if (cls) c.className = cls; return c; }

  // ---- KPI tiles ------------------------------------------------------------
  function renderKpis() {
    const policy = getPolicy?.() || {};
    const sel = bandStats(rows(), policy);
    const ref = bandStats(scope === 'all' ? data.filtered : data.all, policy);
    $kpis.textContent = '';
    // Current Snapshot's KPI card: the band's median, its detail beneath, and
    // the other scope as a neutral chip (a higher rent is neither good nor bad).
    const other = scope === 'all' ? 'Selection' : 'Manitoba';
    for (const k of ['all', ...BAND_ORDER]) {
      const s = k === 'all' ? sel.all : sel.bands[k];
      const r = k === 'all' ? ref.all : ref.bands[k];
      const shown = s.rent.median != null;
      const chips = shown && r.rent.median != null
        ? [{ window: `vs ${other}`, text: `${fmtMoney(r.rent.median)} (${fmtSignedPct(((s.rent.median - r.rent.median) / r.rent.median) * 100)})` }]
        : [];
      $kpis.appendChild(kpiTile({
        label: BAND_LABELS[k],
        color: SERIES_COLORS[k],
        value: shown ? fmtMoney(s.rent.median) : MISSING,
        meta: shown
          ? [`median rent · n=${fmtInt(s.n)}`, `mean ${fmtMoney(s.rent.mean)} · ${fmtPsf(s.psf.median)}/sf (n=${fmtInt(s.psf.n)})`]
          : [`n=${fmtInt(s.n)} · fewer than ${policy.min_n_for_median ?? 5} in the display band`],
        chips,
      }));
    }
    $summary.textContent = `${scopeLabel()} — ${fmtInt(sel.nRows)} listings, ${fmtInt(sel.all.n)} with rent in the display band`;
  }

  // ---- band table (median / mean / quartiles per band) ----------------------
  let lastBandTable = null;
  function renderBandTable() {
    const policy = getPolicy?.() || {};
    const s = bandStats(rows(), policy);
    const cols = ['Bedrooms', 'n', 'Median', 'Mean', 'P25', 'P75', 'Min', 'Max', 'n (sf)', 'Median $/sf', 'Mean $/sf'];
    const body = ['all', ...BAND_ORDER].map((k) => {
      const x = k === 'all' ? s.all : s.bands[k];
      return [BAND_LABELS[k], fmtInt(x.n), fmtMoney(x.rent.median), fmtMoney(x.rent.mean), fmtMoney(x.rent.p25), fmtMoney(x.rent.p75),
        x.n ? fmtMoney(x.rent.min) : MISSING, x.n ? fmtMoney(x.rent.max) : MISSING, fmtInt(x.psf.n), fmtPsf(x.psf.median), fmtPsf(x.psf.mean)];
    });
    lastBandTable = { cols, body, title: `Rent by bedroom count — ${scopeLabel()}` };
    $bandTable.textContent = '';
    const thead = document.createElement('thead'); const tr = document.createElement('tr');
    cols.forEach((c, i) => tr.appendChild(th(c, i ? 'num' : '')));
    thead.appendChild(tr); $bandTable.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of body) { const row = document.createElement('tr'); r.forEach((c, i) => row.appendChild(td(c, i ? 'num' : ''))); tbody.appendChild(row); }
    $bandTable.appendChild(tbody);
  }

  // ---- market table -----------------------------------------------------------
  let lastMarketTable = null;
  function renderMarketTable() {
    const policy = getPolicy?.() || {};
    const by = $marketBy.value || 'muni';
    const t = marketTable(rows(), by, policy);
    const cols = [MARKET_KEYS[by].label, 'n', 'Median', 'Mean', 'Med $/sf', ...BAND_ORDER.flatMap((k) => [`${BAND_LABELS[k]} n`, `${BAND_LABELS[k]} med`, `${BAND_LABELS[k]} mean`])];
    const body = t.map((r) => [r.market, fmtInt(r.n), fmtMoney(r.all.rent.median), fmtMoney(r.all.rent.mean), fmtPsf(r.all.psf.median),
      ...BAND_ORDER.flatMap((k) => [fmtInt(r.bands[k].n), fmtMoney(r.bands[k].rent.median), fmtMoney(r.bands[k].rent.mean)])]);
    lastMarketTable = { cols, body, title: `Rent by ${MARKET_KEYS[by].label.toLowerCase()} — ${scopeLabel()}` };
    $marketTable.textContent = '';
    const thead = document.createElement('thead'); const tr = document.createElement('tr');
    cols.forEach((c, i) => tr.appendChild(th(c, i ? 'num' : '')));
    thead.appendChild(tr); $marketTable.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of body) { const row = document.createElement('tr'); r.forEach((c, i) => row.appendChild(td(c, i ? 'num' : ''))); tbody.appendChild(row); }
    $marketTable.appendChild(tbody);
  }

  async function copyTable(spec) {
    if (!spec) return;
    const ctx = getContext?.() || {};
    const criteria = scope === 'all' ? ['All Manitoba: active listings as of the latest scrape, one row per unit'] : (ctx.criteria || []);
    const note = `Medians and means over rents in the display band; suppressed below n=${getPolicy?.()?.min_n_for_median ?? 5}.` + (ctx.published ? ` Data published ${ctx.published}.` : '');
    const how = await copyRich(tableWordHtml(spec.cols, spec.body, { title: spec.title, criteria, note }), tableWordText(spec.cols, spec.body, { title: spec.title, criteria, note }));
    say(how === 'rich' ? 'Table copied for Word — paste into the report.' : how === 'text' ? 'Table copied as plain text.' : 'Copy failed — clipboard access refused.');
  }
  $marketCopy?.addEventListener('click', () => copyTable(lastMarketTable));
  $bandCopy?.addEventListener('click', () => copyTable(lastBandTable));
  function downloadTable(spec, name) {
    if (!spec) return;
    downloadBlob(new Blob([tableCsv(spec.cols, spec.body)], { type: 'text/csv;charset=utf-8' }), `${name}-${stamp()}.csv`);
    say(`${name.replace(/-/g, ' ')} CSV downloaded.`);
  }
  $('an-market-csv')?.addEventListener('click', () => downloadTable(lastMarketTable, 'rent-by-market'));
  $('an-band-csv')?.addEventListener('click', () => downloadTable(lastBandTable, 'rent-by-bedroom'));

  // ---- charts -------------------------------------------------------------------
  // The site's chart cards (src/subapp-chart-card.js): maroon title, subtitle,
  // legend under the plot, Company caption, Download PNG at 1950 × 1050. Built
  // once, on the first render, into the two headed groups of #an-charts
  // (Rent trends, Listings & distribution); redrawn in place after that.
  let cards = null;
  function ensureCards() {
    if (cards) return cards;
    // `id` is what the sidebar jump list scrolls to.
    const make = (host, key, title, fileStem, explainer) => kit.buildPlotCard($(host), { id: `an-card-${key}`, title, fileStem, explainer });
    cards = {
      rent: make('an-charts-trend', 'rent', 'Median rent by bedroom count', 'rental_median_rent',
        'The middle asking rent of the listings seen in each period, one line per bedroom count. Half the listings asked more and half less, so a few luxury units do not pull it up the way they would an average. These are asking rents on advertised vacancies, which usually run ahead of what sitting tenants pay (CMHC’s survey rents). The latest period is still filling in, so read its last point as provisional.'),
      psf: make('an-charts-trend', 'psf', 'Median rent per square foot', 'rental_median_rent_psf',
        'Monthly asking rent divided by the stated size, the middle value per bedroom count. It puts small and large units on one scale; smaller units usually rent for more per square foot. Only listings that state a size count, roughly half of them, so the lines are thinner and jumpier than the rent chart.'),
      inv: make('an-charts-supply', 'inv', 'Listings observed', 'rental_listings_observed',
        'How many distinct listings the weekly scrape saw in each period, stacked by bedroom count. A rising count can mean more vacancies coming to market, slower lease-up, or more sites being scraped; it is a rough supply signal, not a vacancy rate.'),
      hist: make('an-charts-supply', 'hist', 'Rent distribution', 'rental_rent_distribution',
        'How the current selection’s asking rents spread out, in $100 steps, coloured by bedroom count. A tall, narrow peak means rents cluster tightly; a long right tail means a premium segment. Rents outside the display band are left out.'),
      scatter: make('an-charts-supply', 'scatter', 'Rent by size', 'rental_rent_by_size',
        'Each dot is one listing that states both a rent and a size. The straight lines show the typical rent for a given size within each bedroom count; a steeper line means each extra square foot adds more to the rent. Use it to check whether a subject’s rent is in line for its size.'),
    };
    return cards;
  }
  const withLabel = (r) => ({ ...r, Band: BAND_LABELS[r.band] || r.band });
  const legendFor = (keys) => keys.map((k) => ({ label: BAND_LABELS[k], color: SERIES_COLORS[k] }));
  const colorFor = (keys) => ({ domain: keys.map((k) => BAND_LABELS[k]), range: keys.map((k) => SERIES_COLORS[k]) });
  const present = (pts, keys) => keys.filter((k) => pts.some((p) => p.band === k));
  // Latest-value readout: each series' value in its last period.
  const latestFor = (pts, keys, field, fmt) => keys.map((k) => {
    const mine = pts.filter((p) => p.band === k);
    const lastPt = mine.reduce((a, p) => (!a || p.date > a.date ? p : a), null);
    return lastPt && { label: BAND_LABELS[k], color: SERIES_COLORS[k], value: fmt(lastPt[field]), asof: lastPt.period };
  }).filter(Boolean);

  function renderCharts() {
    if (!kit) return;
    const { Plot } = kit;
    const c = ensureCards();
    const policy = getPolicy?.() || {};
    const ctx = getContext?.() || {};
    const source = `Rental listings, weekly scrape${ctx.published ? ` (published ${ctx.published})` : ''}`;
    const R = rows();
    const ids = scope === 'all' ? new Set(data.all.map((l) => l.id)) : new Set(R.map((l) => l.id));
    const t = trendSeries(data.listings, data.segments, { ids, policy, gran });
    const rentPts = t.rent.filter((r) => r.median != null).map(withLabel);
    const psfPts = t.psf.filter((r) => r.median != null).map(withLabel);
    const invPts = t.inventory.filter((r) => r.band !== 'all').map(withLabel);
    const last = t.periods[t.periods.length - 1];
    const span = t.periods.length ? `${t.periods[0]} to ${last}` : '';
    const per = gran === 'month' ? 'Monthly' : 'Weekly';
    $trendNote.textContent = t.periods.length
      ? `${t.periods.length} ${gran === 'month' ? 'months' : 'weeks'} of scrape history (${span}); the latest ${gran} is partial. A listing counts in a period when it was observed in it, at the rent it showed then.`
      : 'No history for this selection.';
    // The site theme formats x ticks as plain integers (years); these axes
    // are dates, so let Plot pick.
    const timeX = { type: 'utc', label: null, tickFormat: undefined };
    const money = (v) => `$${v.toLocaleString('en-CA')}`;

    const rentKeys = present(rentPts, SERIES);
    c.rent.render({
      subtitle: `${scopeLabel()} • ${per}, ${span}`, source, legend: legendFor(rentKeys),
      latest: latestFor(rentPts, rentKeys, 'median', (v) => `$${Math.round(v).toLocaleString('en-CA')}`),
      empty: rentPts.length ? '' : 'No rents to trend for this selection.',
      spec: () => ({
        x: timeX, y: { label: 'Median rent ($/mo)', tickFormat: money }, color: colorFor(rentKeys),
        marks: [
          Plot.lineY(rentPts, { x: 'date', y: 'median', stroke: 'Band', strokeWidth: 2.4, curve: 'monotone-x' }),
          Plot.dot(rentPts, { x: 'date', y: 'median', fill: 'Band', r: 3, tip: true, title: (d) => `${d.Band} · ${d.period}\nmedian $${Math.round(d.median).toLocaleString('en-CA')} · mean $${Math.round(d.mean).toLocaleString('en-CA')}\nn = ${d.n}` }),
        ],
      }),
    });
    const psfKeys = present(psfPts, SERIES);
    c.psf.render({
      subtitle: `${scopeLabel()} • ${per}, ${span}`, source, legend: legendFor(psfKeys),
      latest: latestFor(psfPts, psfKeys, 'median', (v) => `$${v.toFixed(2)}/sf`),
      empty: psfPts.length ? '' : 'No stated sizes to trend for this selection.',
      spec: () => ({
        x: timeX, y: { label: 'Median rent ($/sf/mo)', tickFormat: (v) => `$${v.toFixed(2)}` }, color: colorFor(psfKeys),
        marks: [
          Plot.lineY(psfPts, { x: 'date', y: 'median', stroke: 'Band', strokeWidth: 2.4, curve: 'monotone-x' }),
          Plot.dot(psfPts, { x: 'date', y: 'median', fill: 'Band', r: 3, tip: true, title: (d) => `${d.Band} · ${d.period}\nmedian $${d.median.toFixed(2)}/sf · mean $${d.mean.toFixed(2)}/sf\nn = ${d.n}` }),
        ],
      }),
    });
    const invKeys = present(invPts, BAND_ORDER);
    c.inv.render({
      subtitle: `${scopeLabel()} • listings observed per ${gran}, ${span}`, source, legend: legendFor(invKeys),
      latest: latestFor(invPts, invKeys, 'n', (v) => v.toLocaleString('en-CA')),
      empty: invPts.length ? '' : 'No history for this selection.',
      spec: () => ({
        x: timeX, y: { label: 'Listings', tickFormat: (v) => v.toLocaleString('en-CA') }, color: colorFor(invKeys),
        marks: [
          Plot.areaY(invPts, { x: 'date', y: 'n', fill: 'Band', fillOpacity: 0.8, curve: 'monotone-x', tip: true, title: (d) => `${d.Band} · ${d.period}\n${d.n.toLocaleString('en-CA')} listings` }),
          Plot.ruleY([0]),
        ],
      }),
    });

    const h = histogram(R, policy, 100).map(withLabel);
    const histKeys = present(h, SERIES);
    c.hist.render({
      subtitle: `${scopeLabel()} • asking rent in $100 bins`, source, legend: legendFor(histKeys),
      empty: h.length ? '' : 'No rents in the display band for this selection.',
      spec: () => ({
        marginBottom: 46,
        x: { label: 'Rent ($/mo)', tickFormat: (v) => `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` },
        y: { label: 'Listings', tickFormat: (v) => v.toLocaleString('en-CA') }, color: colorFor(histKeys),
        marks: [
          Plot.rectY(h, { x1: 'bin', x2: (d) => d.bin + 100, y: 'n', fill: 'Band', tip: true, title: (d) => `${d.Band} · $${d.bin.toLocaleString('en-CA')}–${(d.bin + 99).toLocaleString('en-CA')}\n${d.n} listings` }),
          Plot.ruleY([0]),
        ],
      }),
    });
    const pts = sizePoints(R, policy).map(withLabel);
    const sample = pts.length > 4000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0) : pts;
    const ptKeys = present(pts, SERIES);
    const fitKeys = BAND_ORDER.filter((k) => pts.filter((p) => p.band === k).length >= 10);
    c.scatter.render({
      subtitle: `${scopeLabel()} • asking rent against stated size`, source, legend: legendFor(ptKeys),
      note: 'Lines are least-squares fits per bedroom count where at least 10 listings state a size. Sizes are only stated for about half of listings.',
      empty: pts.length ? '' : 'No listings with both a rent and a size in this selection.',
      spec: () => ({
        marginBottom: 46, clip: true,
        x: { label: 'Size (sq ft)', tickFormat: (v) => v.toLocaleString('en-CA'), domain: [0, Math.min(3000, Math.max(...pts.map((p) => p.sqft), 800))] },
        y: { label: 'Rent ($/mo)', tickFormat: money }, color: colorFor(ptKeys),
        marks: [
          Plot.dot(sample, { x: 'sqft', y: 'rent', fill: 'Band', r: 2.2, fillOpacity: 0.55, tip: true, title: (d) => `${d.address}\n${d.Band} · ${d.sqft.toLocaleString('en-CA')} sf · $${d.rent.toLocaleString('en-CA')}` }),
          ...fitKeys.map((k) => Plot.linearRegressionY(pts.filter((p) => p.band === k), { x: 'sqft', y: 'rent', stroke: BAND_COLORS[k], strokeWidth: 2, ci: 0 })),
        ],
      }),
    });
  }

  // ---- other stats ----------------------------------------------------------------
  function renderOther() {
    const policy = getPolicy?.() || {};
    const o = otherStats(rows(), data.segments, policy);
    $other.textContent = '';
    const cols = ['Bedrooms', 'n', 'Median days observed', 'Rent changed', 'Median change', 'Parking incl.', 'Elevator', 'Heat incl.', 'Furnished', 'Pets allowed'];
    const thead = document.createElement('thead'); const tr = document.createElement('tr');
    cols.forEach((c, i) => tr.appendChild(th(c, i ? 'num' : ''))); thead.appendChild(tr); $other.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const k of ['all', ...BAND_ORDER]) {
      const b = o.bands[k];
      const row = document.createElement('tr');
      [BAND_LABELS[k], fmtInt(b.n), b.daysMedian == null ? MISSING : `${fmtInt(b.daysMedian)} d`, fmtPct(b.changedShare), fmtSignedPct(b.changePctMedian),
        b.parkingKnown ? `${fmtPct(b.parkingShare)} of ${fmtInt(b.parkingKnown)}` : MISSING,
        b.elevatorKnown ? `${fmtPct(b.elevatorShare)} of ${fmtInt(b.elevatorKnown)}` : MISSING,
        fmtPct(b.heatShare), b.furnishedShare == null ? MISSING : fmtPct(b.furnishedShare),
        b.petsKnown ? `${fmtPct(b.petsShare)} of ${fmtInt(b.petsKnown)}` : MISSING,
      ].forEach((c, i) => row.appendChild(td(c, i ? 'num' : '')));
      tbody.appendChild(row);
    }
    $other.appendChild(tbody);
    $sources.textContent = '';
    const sh = document.createElement('thead'); const sr = document.createElement('tr');
    ['Source', 'Listings', 'Share'].forEach((c, i) => sr.appendChild(th(c, i ? 'num' : ''))); sh.appendChild(sr); $sources.appendChild(sh);
    const sb = document.createElement('tbody');
    for (const s of o.sources) { const row = document.createElement('tr'); [s.source, fmtInt(s.n), fmtPct(s.share, 1)].forEach((c, i) => row.appendChild(td(c, i ? 'num' : ''))); sb.appendChild(row); }
    $sources.appendChild(sb);
  }

  async function ensureKit() {
    if (kit) return kit;
    if (!kitLoading) kitLoading = import('../../src/subapp-chart-card.js').then((m) => { kit = m; return m; });
    return kitLoading;
  }

  function render() {
    rendering = renderNow();
    return rendering;
  }

  async function renderNow() {
    if (!visible || !dirty) return;
    if (!data.listings.length) { $summary.textContent = 'Connect the export folder to begin.'; return; }
    dirty = false;
    renderKpis();
    renderBandTable();
    renderMarketTable();
    renderOther();
    await ensureKit();
    renderCharts();
  }

  return {
    /** New data (any of the four arrays). Re-renders when the tab is visible. */
    update(next) {
      data = { ...data, ...next };
      dirty = true;
      render();
    },
    setVisible(v) { visible = v; if (v) render(); },
    /** Resolves once the render in flight (if any) has drawn its charts. */
    ready: () => rendering,
  };
}
