/*
 * analysis.js — the Analysis tab: KPI tiles per bedroom band, a by-market
 * table, trend lines (median rent, $/sf, active inventory) from the rent
 * runs, the rent distribution, rent vs size, and other rental statistics.
 *
 * Scope pill: "Selection" is whatever the filters currently match;
 * "All Manitoba" is the default view (active, canonical, in scope) so a
 * selection can be read against the province. Charts are Observable Plot
 * (bundled; nothing fetched), loaded on first use so the listings tab
 * never pays for it.
 */

import { bandStats, marketTable, trendSeries, histogram, sizePoints, otherStats, MARKET_KEYS } from './lib/analysis.js';
import { BAND_ORDER, BAND_COLORS, BAND_LABELS } from './lib/bands.js';
import { tableWordHtml, tableWordText, tableCsv } from './lib/exports.js';
import { copyRich, downloadBlob, stamp } from './exports.js';

const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-CA'));
const fmtMoney = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtPsf = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);
const fmtPct = (n, dp = 0) => (n == null ? '—' : `${(n * 100).toFixed(dp)}%`);
const fmtSignedPct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);

const SERIES = [...BAND_ORDER, 'all'];
const SERIES_COLORS = { ...BAND_COLORS, all: '#1a1a1a' };

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
  const $trendRent = $('an-trend-rent');
  const $trendPsf = $('an-trend-psf');
  const $trendInv = $('an-trend-inv');
  const $hist = $('an-hist');
  const $scatter = $('an-scatter');
  const $other = $('an-other');
  const $sources = $('an-sources');
  const $trendNote = $('an-trend-note');

  let data = { filtered: [], all: [], listings: [], segments: [] };
  let scope = 'selection';
  let gran = 'month';
  let visible = false;
  let dirty = true;
  let Plot = null;
  let plotLoading = null;

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
    for (const k of ['all', ...BAND_ORDER]) {
      const s = k === 'all' ? sel.all : sel.bands[k];
      const r = k === 'all' ? ref.all : ref.bands[k];
      const tile = document.createElement('div');
      tile.className = 'stat kpi';
      tile.style.borderTopColor = SERIES_COLORS[k];
      const label = document.createElement('div'); label.className = 'label';
      label.textContent = `${BAND_LABELS[k]} · n=${fmtInt(s.n)}`;
      const value = document.createElement('div'); value.className = 'value';
      value.textContent = s.rent.median != null ? fmtMoney(s.rent.median) : 'suppressed';
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = s.rent.median != null
        ? `mean ${fmtMoney(s.rent.mean)} · ${fmtPsf(s.psf.median)}/sf (n=${fmtInt(s.psf.n)})`
        : `fewer than ${policy.min_n_for_median ?? 5} in the display band`;
      const cmp = document.createElement('div'); cmp.className = 'sub muted';
      if (s.rent.median != null && r.rent.median != null) {
        const d = ((s.rent.median - r.rent.median) / r.rent.median) * 100;
        cmp.textContent = `${scope === 'all' ? 'selection' : 'Manitoba'} ${fmtMoney(r.rent.median)} (${fmtSignedPct(d)})`;
      }
      tile.append(label, value, sub, cmp);
      $kpis.appendChild(tile);
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
        x.n ? fmtMoney(x.rent.min) : '—', x.n ? fmtMoney(x.rent.max) : '—', fmtInt(x.psf.n), fmtPsf(x.psf.median), fmtPsf(x.psf.mean)];
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
  function chartBase(extra = {}) {
    return {
      width: Math.max(320, Math.min(760, ($trendRent?.clientWidth || 600))),
      height: 260, marginLeft: 56, marginRight: 16, marginBottom: 36,
      style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px', background: 'transparent' },
      color: { domain: SERIES.map((k) => BAND_LABELS[k]), range: SERIES.map((k) => SERIES_COLORS[k]), legend: true },
      ...extra,
    };
  }
  const withLabel = (r) => ({ ...r, Band: BAND_LABELS[r.band] || r.band });

  function renderCharts() {
    if (!Plot) return;
    const policy = getPolicy?.() || {};
    const R = rows();
    const ids = scope === 'all' ? new Set(data.all.map((l) => l.id)) : new Set(R.map((l) => l.id));
    const t = trendSeries(data.listings, data.segments, { ids, policy, gran });
    const rentPts = t.rent.filter((r) => r.median != null).map(withLabel);
    const psfPts = t.psf.filter((r) => r.median != null).map(withLabel);
    const invPts = t.inventory.filter((r) => r.band !== 'all').map(withLabel);
    const last = t.periods[t.periods.length - 1];
    $trendNote.textContent = t.periods.length
      ? `${t.periods.length} ${gran === 'month' ? 'months' : 'weeks'} of scrape history (${t.periods[0]} to ${last}); the latest ${gran} is partial. A listing counts in a period when it was observed in it, at the rent it showed then.`
      : 'No history for this selection.';

    const draw = (el, opts) => { el.textContent = ''; el.appendChild(Plot.plot(opts)); };
    draw($trendRent, chartBase({
      y: { grid: true, label: 'Median rent ($/mo)', tickFormat: (v) => `$${v.toLocaleString('en-CA')}` },
      x: { type: 'utc', label: null },
      marks: [
        Plot.lineY(rentPts, { x: 'date', y: 'median', stroke: 'Band', strokeWidth: 2, curve: 'monotone-x' }),
        Plot.dot(rentPts, { x: 'date', y: 'median', fill: 'Band', r: 3, tip: true, title: (d) => `${d.Band} · ${d.period}\nmedian $${Math.round(d.median).toLocaleString('en-CA')} · mean $${Math.round(d.mean).toLocaleString('en-CA')}\nn = ${d.n}` }),
      ],
    }));
    draw($trendPsf, chartBase({
      y: { grid: true, label: 'Median rent per sq ft ($/sf/mo)', tickFormat: (v) => `$${v.toFixed(2)}` },
      x: { type: 'utc', label: null },
      marks: [
        Plot.lineY(psfPts, { x: 'date', y: 'median', stroke: 'Band', strokeWidth: 2, curve: 'monotone-x' }),
        Plot.dot(psfPts, { x: 'date', y: 'median', fill: 'Band', r: 3, tip: true, title: (d) => `${d.Band} · ${d.period}\nmedian $${d.median.toFixed(2)}/sf · mean $${d.mean.toFixed(2)}/sf\nn = ${d.n}` }),
      ],
    }));
    draw($trendInv, chartBase({
      y: { grid: true, label: 'Listings observed in period' },
      x: { type: 'utc', label: null },
      marks: [
        Plot.areaY(invPts, { x: 'date', y: 'n', fill: 'Band', fillOpacity: 0.75, curve: 'monotone-x', tip: true, title: (d) => `${d.Band} · ${d.period}\n${d.n.toLocaleString('en-CA')} listings` }),
      ],
    }));

    const h = histogram(R, policy, 100).map(withLabel);
    draw($hist, chartBase({
      y: { grid: true, label: 'Listings' },
      x: { label: 'Rent ($/mo, $100 bins)', tickFormat: (v) => `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` },
      marks: [
        Plot.rectY(h, { x1: 'bin', x2: (d) => d.bin + 100, y: 'n', fill: 'Band', tip: true, title: (d) => `${d.Band} · $${d.bin.toLocaleString('en-CA')}–${(d.bin + 99).toLocaleString('en-CA')}\n${d.n} listings` }),
      ],
    }));
    const pts = sizePoints(R, policy).map(withLabel);
    const sample = pts.length > 4000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0) : pts;
    draw($scatter, chartBase({
      y: { grid: true, label: 'Rent ($/mo)', tickFormat: (v) => `$${v.toLocaleString('en-CA')}` },
      x: { label: 'Size (sq ft)', domain: [0, Math.min(3000, Math.max(...pts.map((p) => p.sqft), 800))] },
      marks: [
        Plot.dot(sample, { x: 'sqft', y: 'rent', fill: 'Band', r: 2.2, fillOpacity: 0.55, tip: true, title: (d) => `${d.address}\n${d.Band} · ${d.sqft.toLocaleString('en-CA')} sf · $${d.rent.toLocaleString('en-CA')}` }),
        ...BAND_ORDER.filter((k) => pts.filter((p) => p.band === k).length >= 10)
          .map((k) => Plot.linearRegressionY(pts.filter((p) => p.band === k), { x: 'sqft', y: 'rent', stroke: BAND_COLORS[k], strokeWidth: 2, ci: 0 })),
      ],
    }));
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
      [BAND_LABELS[k], fmtInt(b.n), b.daysMedian == null ? '—' : `${fmtInt(b.daysMedian)} d`, fmtPct(b.changedShare), fmtSignedPct(b.changePctMedian),
        b.parkingKnown ? `${fmtPct(b.parkingShare)} of ${fmtInt(b.parkingKnown)}` : '—',
        b.elevatorKnown ? `${fmtPct(b.elevatorShare)} of ${fmtInt(b.elevatorKnown)}` : '—',
        fmtPct(b.heatShare), b.furnishedShare == null ? '—' : fmtPct(b.furnishedShare),
        b.petsKnown ? `${fmtPct(b.petsShare)} of ${fmtInt(b.petsKnown)}` : '—',
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

  async function ensurePlot() {
    if (Plot) return Plot;
    if (!plotLoading) plotLoading = import('@observablehq/plot').then((m) => { Plot = m; return m; });
    return plotLoading;
  }

  async function render() {
    if (!visible || !dirty) return;
    if (!data.listings.length) { $summary.textContent = 'Connect the export folder to begin.'; return; }
    dirty = false;
    renderKpis();
    renderBandTable();
    renderMarketTable();
    renderOther();
    await ensurePlot();
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
  };
}
