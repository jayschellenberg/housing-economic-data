/*
 * The overview's arithmetic. The thing most worth pinning is what
 * "on the market" means: the newest cycle in the DATA, not today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCurrent, currentRecords, median, bySpaceType, byBrokerage, byMunicipality, headline,
  guardedMedian, inBand, policy, excludedCount,
} from '../src/lib/summary.js';

const MANIFEST = {
  cycles: { first: '2018-01', last: '2026-09', count: 105 },
  counts: { records: 4, runs: 12, with_coords: 4, duplicate_spaces: 2 },
  on_market_statuses: ['active', 'new', 'conditionally sold', 'conditionally leased'],
  flyers: { present: 3 },
  policy: {
    lease_rate_band: [1, 200],
    sale_price_band: [10000, 500000000],
    size_band_sf: [100, 5000000],
    min_n: 1,
  },
};

const rec = (over) => ({
  listing_id: Math.random().toString(36).slice(2),
  status: 'Active', last_seen: '2026-09', space_type: 'Office', listing_type: 'Lease',
  brokerage: 'CBRE', municipality: 'City of Winnipeg',
  current_price: null, current_price_psf_annual: null, sf_min: null, sf_max: null,
  latitude: 49.9, longitude: -97.1,
  ...over,
});

test('on the market means the newest cycle, not the current date', () => {
  // Same status, seen two cycles ago: gone from the market, still in the data.
  assert.equal(isCurrent(rec({ last_seen: '2026-09' }), MANIFEST), true);
  assert.equal(isCurrent(rec({ last_seen: '2026-07' }), MANIFEST), false);
});

test('a terminal status is never on the market', () => {
  for (const status of ['Leased', 'Sold', 'Delisted']) {
    assert.equal(isCurrent(rec({ status }), MANIFEST), false, status);
  }
  assert.equal(isCurrent(rec({ status: 'Conditionally Leased' }), MANIFEST), true);
});

test('status matching is case-insensitive', () => {
  assert.equal(isCurrent(rec({ status: 'ACTIVE' }), MANIFEST), true);
});

test('a bundle with no cycle yields no current records', () => {
  assert.equal(currentRecords([rec()], { on_market_statuses: ['active'] }).length, 0);
});

test('median handles even, odd and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, undefined, NaN, 5]), 5);
});

test('lease rates and sale prices are never averaged together', () => {
  const records = [
    rec({ space_type: 'Office', listing_type: 'Lease', current_price_psf_annual: 12 }),
    rec({ space_type: 'Office', listing_type: 'Lease', current_price_psf_annual: 18 }),
    rec({ space_type: 'Office', listing_type: 'Sale', current_price: 1000000 }),
    rec({ space_type: 'Industrial', listing_type: 'Lease', current_price_psf_annual: 9 }),
    rec({ space_type: 'Office', listing_type: 'Lease', current_price_psf_annual: 99, last_seen: '2025-01' }),
  ];
  const [office, industrial] = bySpaceType(records, MANIFEST);
  assert.equal(office.space_type, 'Office');
  assert.equal(office.lease, 2, 'the stale listing is not on the market');
  assert.equal(office.sale, 1);
  assert.equal(office.median_rate, 15, 'the $1M sale did not enter the rate');
  assert.equal(office.median_price, 1000000);
  assert.equal(industrial.space_type, 'Industrial');
});

test('space types sort by how much is on the market', () => {
  const records = [
    rec({ space_type: 'Retail' }),
    rec({ space_type: 'Industrial' }), rec({ space_type: 'Industrial' }),
  ];
  assert.deepEqual(bySpaceType(records, MANIFEST).map((r) => r.space_type),
    ['Industrial', 'Retail']);
});

test('brokerages count all records and what is live now', () => {
  const records = [
    rec({ brokerage: 'CBRE' }),
    rec({ brokerage: 'CBRE', status: 'Leased' }),
    rec({ brokerage: 'Colliers' }), rec({ brokerage: 'Colliers' }),
  ];
  const rows = byBrokerage(records, MANIFEST);
  assert.deepEqual(rows.map((r) => [r.brokerage, r.current, r.records]),
    [['Colliers', 2, 2], ['CBRE', 1, 2]]);
});

test('unattributed rows are labelled, not dropped', () => {
  const rows = byBrokerage([rec({ brokerage: null })], MANIFEST);
  assert.equal(rows[0].brokerage, 'Unattributed');
  const munis = byMunicipality([rec({ municipality: null })], MANIFEST);
  assert.equal(munis[0].municipality, 'Unassigned');
});

test('municipalities are capped and ordered by current inventory', () => {
  const records = [
    ...Array.from({ length: 3 }, () => rec({ municipality: 'City of Winnipeg' })),
    rec({ municipality: 'RM of Rosser' }),
  ];
  const rows = byMunicipality(records, MANIFEST, 1);
  assert.deepEqual(rows, [{ municipality: 'City of Winnipeg', current: 3 }]);
});

test('the bands come from the bundle, and absence means no judgement', () => {
  assert.deepEqual(policy(MANIFEST).leaseRate, [1, 200]);
  assert.equal(policy({}).leaseRate, null);
  assert.equal(inBand(12, null), true, 'no band means anything finite passes');
  assert.equal(inBand(12, [1, 200]), true);
  assert.equal(inBand(37800, [1, 200]), false);
  assert.equal(inBand(null, [1, 200]), false);
});

test('an implausible rate is excluded from the median and counted', () => {
  // 12 Headingley St is quoted $37,800/month for the yard but was
  // extracted as psf_annual. One such row moves a thin category's median
  // and annihilates any mean.
  const g = guardedMedian([10, 12, 14, 37800], [1, 200]);
  assert.equal(g.value, 12);
  assert.equal(g.n, 3);
  assert.equal(g.excluded, 1);
});

test('the space-type table drops the outlier but reports it', () => {
  const records = [
    rec({ space_type: 'Land', listing_type: 'Lease', current_price_psf_annual: 37800 }),
    rec({ space_type: 'Land', listing_type: 'Lease', current_price_psf_annual: 8 }),
  ];
  const [land] = bySpaceType(records, MANIFEST);
  assert.equal(land.lease, 2, 'the listing is still on the market');
  assert.equal(land.median_rate, 8, 'the monthly total did not become the rate');
  assert.equal(land.priced_lease, 1);
  assert.equal(land.excluded, 1);
  assert.equal(excludedCount(records, MANIFEST), 1);
});

test('an aggregate below min_n is withheld, not published thin', () => {
  const manifest = { ...MANIFEST, policy: { ...MANIFEST.policy, min_n: 3 } };
  const records = [
    rec({ space_type: 'Mixed', listing_type: 'Lease', current_price_psf_annual: 15 }),
    rec({ space_type: 'Mixed', listing_type: 'Lease', current_price_psf_annual: 17 }),
  ];
  const [mixed] = bySpaceType(records, manifest);
  assert.equal(mixed.lease, 2);
  assert.equal(mixed.median_rate, null, 'two listings do not make a market rate');
});

test('headline reads counts from the manifest and current from the records', () => {
  const h = headline([rec(), rec({ last_seen: '2020-01', status: 'Delisted' })], MANIFEST);
  assert.equal(h.records, 2);
  assert.equal(h.current, 1);
  assert.equal(h.cycleLast, '2026-09');
  assert.equal(h.runs, 12);
  assert.equal(h.flyersPresent, 3);
  assert.equal(h.duplicateSpaces, 2);
});
