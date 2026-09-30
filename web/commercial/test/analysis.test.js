/*
 * The analysis measures. The cases that matter are the ones where the
 * history is easy to read wrongly: a run spans months nobody reported
 * in, a stock gets summed like a flow, and a thin market gets a median
 * it has not earned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cyclesIn, bucketOf, indexRuns, runAt, marketByCycle, bandSeries,
  byMarket, distribution, priceChanges, timeOnMarket, rateVsSize, coverageNote,
} from '../src/lib/analysis.js';

const MANIFEST = {
  cycles: { first: '2026-01', last: '2026-06', count: 6 },
  on_market_statuses: ['active', 'new', 'conditionally leased'],
  policy: {
    lease_rate_band: [1, 200], sale_price_band: [10000, 500000000],
    size_band_sf: [100, 5000000], min_n: 1,
  },
};

const rec = (over = {}) => ({
  listing_id: 'A', space_type: 'Office', listing_type: 'Lease',
  municipality: 'City of Winnipeg', neighbourhood: 'ST. JAMES',
  current_price: 15, current_price_psf_annual: 15,
  sf_min: 1000, sf_max: 1000, months_on_market: 6, address: '100 Main St',
  ...over,
});

const run = (over = {}) => ({
  listing_id: 'A', kind: 'price', value: 15, basis: 'psf_annual',
  from: '2026-01', to: '2026-06', cycles: 6, ...over,
});

test('cycles enumerate inclusively and refuse a backwards range', () => {
  assert.deepEqual(cyclesIn('2026-01', '2026-03'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(cyclesIn('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(cyclesIn('2026-03', '2026-01'), []);
  assert.deepEqual(cyclesIn('', '2026-01'), []);
});

test('buckets roll cycles up to quarters and years', () => {
  assert.equal(bucketOf('2026-02', 'month'), '2026-02');
  assert.equal(bucketOf('2026-02', 'quarter'), '2026-Q1');
  assert.equal(bucketOf('2026-12', 'quarter'), '2026-Q4');
  assert.equal(bucketOf('2026-07', 'year'), '2026');
});

test('a run covers every month between its ends, reported or not', () => {
  const runs = [run({ from: '2026-01', to: '2026-02' }), run({ value: 18, from: '2026-03', to: '2026-06' })];
  assert.equal(runAt(runs, '2026-01').value, 15);
  assert.equal(runAt(runs, '2026-02').value, 15, 'February is inside the first run');
  assert.equal(runAt(runs, '2026-04').value, 18);
  assert.equal(runAt(runs, '2025-12'), null);
});

test('indexRuns splits kinds and orders them', () => {
  const idx = indexRuns([
    run({ kind: 'status', value: 'Active', from: '2026-04' }),
    run({ kind: 'status', value: 'New', from: '2026-01' }),
    run({ kind: 'price' }),
  ]);
  assert.equal(idx.get('A').price.length, 1);
  assert.deepEqual(idx.get('A').status.map((r) => r.value), ['New', 'Active']);
});

test('a listing counts in every cycle it was on the market, at the rate it showed then', () => {
  const records = [rec()];
  const runs = [
    run({ kind: 'status', value: 'Active', from: '2026-01', to: '2026-06' }),
    run({ kind: 'price', value: 20, from: '2026-01', to: '2026-03' }),
    run({ kind: 'price', value: 10, from: '2026-04', to: '2026-06' }),
  ];
  const series = marketByCycle(records, runs, MANIFEST);
  assert.equal(series.length, 6);
  assert.deepEqual(series.map((s) => s.bucket), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(series[0].medianRate, 20);
  assert.equal(series[3].medianRate, 10, 'the cut shows in the month it happened');
  assert.ok(series.every((s) => s.onMarket === 1));
});

test('a terminal status ends the listing s presence in the series', () => {
  const runs = [
    run({ kind: 'status', value: 'Active', from: '2026-01', to: '2026-03' }),
    run({ kind: 'status', value: 'Leased', from: '2026-04', to: '2026-06' }),
    run({ kind: 'price' }),
  ];
  const series = marketByCycle([rec()], runs, MANIFEST);
  assert.deepEqual(series.filter((s) => s.onMarket > 0).map((s) => s.bucket),
    ['2026-01', '2026-02', '2026-03']);
});

test('on-market is a stock: a quarter reports the average month, not the sum', () => {
  const runs = [
    run({ kind: 'status', value: 'Active', from: '2026-01', to: '2026-03' }),
    run({ kind: 'price' }),
  ];
  const [q1] = marketByCycle([rec()], runs, MANIFEST, { granularity: 'quarter' });
  assert.equal(q1.bucket, '2026-Q1');
  assert.equal(q1.onMarket, 1, 'one listing for three months is one listing, not three');
});

test('only a psf_annual lease quote feeds the rate series', () => {
  const runs = [
    run({ kind: 'status', value: 'Active' }),
    // A whole-yard monthly total. A real quote, but not a rate, and
    // converting it would need a size the tracker often lacks.
    run({ kind: 'price', value: 3500, basis: 'total_monthly' }),
  ];
  const [first] = marketByCycle([rec()], runs, MANIFEST);
  assert.equal(first.onMarket, 1, 'the listing is still on the market');
  assert.equal(first.medianRate, null, 'but it contributes no rate');
  assert.equal(first.ratedN, 0);
});

test('an out-of-band rate never reaches a trend', () => {
  const runs = [run({ kind: 'status', value: 'Active' }), run({ kind: 'price', value: 37800 })];
  const [first] = marketByCycle([rec()], runs, MANIFEST);
  assert.equal(first.medianRate, null);
});

test('sale prices and lease rates are separate series', () => {
  const records = [rec({ listing_id: 'L' }), rec({ listing_id: 'S', listing_type: 'Sale' })];
  const runs = [
    run({ listing_id: 'L', kind: 'status', value: 'Active' }),
    run({ listing_id: 'L', kind: 'price', value: 12 }),
    run({ listing_id: 'S', kind: 'status', value: 'Active' }),
    run({ listing_id: 'S', kind: 'price', value: 900000, basis: 'sale' }),
  ];
  const [first] = marketByCycle(records, runs, MANIFEST);
  assert.equal(first.onMarket, 2);
  assert.equal(first.medianRate, 12);
  assert.equal(first.medianPrice, 900000);
});

test('band series is long-form and skips bands with no rate', () => {
  const records = [rec({ listing_id: 'O' }), rec({ listing_id: 'I', space_type: 'Industrial' })];
  const runs = [
    run({ listing_id: 'O', kind: 'status', value: 'Active' }),
    run({ listing_id: 'O', kind: 'price', value: 20 }),
    run({ listing_id: 'I', kind: 'status', value: 'Active' }),
  ];
  const rows = bandSeries(marketByCycle(records, runs, MANIFEST), 'medianRate');
  assert.ok(rows.every((r) => r.band === 'Office'), 'Industrial has no rate to plot');
  assert.equal(rows.length, 6);
  const counts = bandSeries(marketByCycle(records, runs, MANIFEST), 'onMarket');
  assert.ok(counts.some((r) => r.band === 'Industrial'), 'but it is still on the market');
});

test('a market too thin for a median still shows its count', () => {
  const manifest = { ...MANIFEST, policy: { ...MANIFEST.policy, min_n: 3 } };
  const rows = byMarket([
    rec({ municipality: 'RM of Grey', current_price_psf_annual: 12 }),
    rec({ municipality: 'RM of Grey', current_price_psf_annual: 14 }),
  ], manifest);
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].medianRate, null);
  assert.equal(rows[0].ratedN, 2);
  assert.equal(rows[0].suppressed, true, 'suppressed, so the UI can say why it is blank');
});

test('unassigned geography is labelled rather than dropped', () => {
  const rows = byMarket([rec({ municipality: null })], MANIFEST);
  assert.equal(rows[0].name, 'Unassigned');
});

test('distribution bins and ignores out-of-band values', () => {
  const bins = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 });
  assert.equal(bins.length, 5);
  assert.equal(bins.reduce((n, b) => n + b.n, 0), 10);
  const guarded = distribution([10, 12, 37800], { bins: 4, band: [1, 200] });
  assert.equal(guarded.reduce((n, b) => n + b.n, 0), 2);
  assert.deepEqual(distribution([], { bins: 4 }), []);
  assert.deepEqual(distribution([5, 5, 5], { bins: 4 }), [{ x0: 5, x1: 5, n: 3 }]);
});

test('a price change is measured first run to last, and signed', () => {
  const runs = [
    run({ listing_id: 'A', kind: 'price', value: 20, from: '2026-01', to: '2026-03' }),
    run({ listing_id: 'A', kind: 'price', value: 15, from: '2026-04', to: '2026-06' }),
    run({ listing_id: 'B', kind: 'price', value: 12, from: '2026-01', to: '2026-06' }),
  ];
  const out = priceChanges([rec({ listing_id: 'A' }), rec({ listing_id: 'B' })], runs, MANIFEST);
  assert.equal(out.withHistory, 2, 'the unchanged listing is the denominator, not missing');
  assert.equal(out.changed, 1);
  assert.equal(out.cuts, 1);
  assert.equal(out.raises, 0);
  assert.equal(out.shareChanged, 0.5);
  assert.equal(out.medianChangePct, -25);
});

test('a listing that returns to its old price did change, and nets to zero', () => {
  const runs = [
    run({ kind: 'price', value: 20, from: '2026-01', to: '2026-02' }),
    run({ kind: 'price', value: 15, from: '2026-03', to: '2026-04' }),
    run({ kind: 'price', value: 20, from: '2026-05', to: '2026-06' }),
  ];
  const out = priceChanges([rec()], runs, MANIFEST);
  assert.equal(out.changed, 0, 'first and last agree, so the net move is nil');
  assert.equal(out.withHistory, 1);
});

test('a rising listing count is flagged when coverage grew underneath it', () => {
  // The tracker went from one brokerage in 2018 to ten in 2026. Without
  // this note the count chart reads as a tripling market.
  const records = [
    rec({ listing_id: 'A', brokerage: 'CBRE' }),
    rec({ listing_id: 'B', brokerage: 'Colliers' }),
  ];
  const runs = [
    run({ listing_id: 'A', kind: 'status', value: 'Active', from: '2026-01', to: '2026-06' }),
    run({ listing_id: 'A', kind: 'price' }),
    run({ listing_id: 'B', kind: 'status', value: 'Active', from: '2026-04', to: '2026-06' }),
    run({ listing_id: 'B', kind: 'price' }),
  ];
  const series = marketByCycle(records, runs, MANIFEST);
  assert.equal(series[0].brokerages, 1);
  assert.equal(series[5].brokerages, 2);
  assert.deepEqual(coverageNote(series),
    { from: '2026-01', to: '2026-06', fromCount: 1, toCount: 2 });
});

test('no note when coverage was flat — then the count can be read as it is', () => {
  const runs = [run({ kind: 'status', value: 'Active' }), run({ kind: 'price' })];
  assert.equal(coverageNote(marketByCycle([rec({ brokerage: 'CBRE' })], runs, MANIFEST)), null);
  assert.equal(coverageNote([]), null);
});

test('months on market', () => {
  const out = timeOnMarket([rec({ months_on_market: 3 }), rec({ months_on_market: 9 }), rec({ months_on_market: null })]);
  assert.equal(out.n, 2);
  assert.equal(out.median, 6);
  assert.ok(out.distribution.length > 0);
});

test('the scatter drops a point whose either axis is implausible', () => {
  const pts = rateVsSize([
    rec({ current_price_psf_annual: 15, sf_max: 2000 }),
    rec({ current_price_psf_annual: 37800, sf_max: 2000 }),
    rec({ current_price_psf_annual: 15, sf_max: 10 }),
    rec({ listing_type: 'Sale', current_price_psf_annual: 15, sf_max: 2000 }),
  ], MANIFEST);
  assert.equal(pts.length, 1);
  assert.deepEqual(pts[0], { size: 2000, rate: 15, band: 'Office', address: '100 Main St' });
});
