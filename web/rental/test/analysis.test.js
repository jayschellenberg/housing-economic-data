import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, bandStats, marketTable, periodKey, periodsBetween, trendSeries, histogram, sizePoints, otherStats, bandOf,
} from '../src/lib/analysis.js';

const policy = { display_rent_min: 500, display_rent_max: 5000, min_n_for_median: 2,
  bedroom_bands: [{ key: 'studio', min: 0, max: 1 }, { key: '1br', min: 1, max: 2 }, { key: '2br', min: 2, max: 3 },
    { key: '3br', min: 3, max: 4 }, { key: '4plus', min: 4, max: null }] };

let seq = 1;
const mk = (over = {}) => ({
  id: seq++, source: 'kijiji', address: 'x', title: 't', city: 'Winnipeg', geo_municipality: 'CITY OF WINNIPEG',
  geo_mls_area: '1B', geo_neighborhood: null, bedrooms: 1, sqft: 600, rent: 1200, first_seen: '2026-08-01',
  last_seen: '2026-09-13', parking_included: null, elevator: null, util_heat: null, furnished: null, pet_policy: null, ...over,
});

test('summarize with suppression', () => {
  assert.deepEqual(summarize([3, 1, 2], 2), { n: 3, median: 2, mean: 2, p25: 1.5, p75: 2.5, min: 1, max: 3 });
  const s = summarize([7], 2);
  assert.equal(s.n, 1); assert.equal(s.median, null); assert.equal(s.mean, null); assert.equal(s.min, 7);
  assert.equal(summarize([], 2).n, 0);
});

test('bandStats: display band, per-band medians/means, $/sf', () => {
  const rows = [mk({ rent: 1000, sqft: 500 }), mk({ rent: 1400, sqft: 700 }), mk({ rent: 9000 }), mk({ bedrooms: 2, rent: 2000, sqft: null }), mk({ bedrooms: null, rent: 800 })];
  const s = bandStats(rows, policy);
  assert.equal(s.nRows, 5);
  assert.equal(s.all.n, 4);                       // 9000 outside the band
  assert.equal(s.all.rent.median, 1200);            // 800, 1000, 1400, 2000 (unknown-band row counts in All)
  assert.equal(s.bands['1br'].rent.mean, 1200);
  assert.equal(s.bands['1br'].psf.median, 2);
  assert.equal(s.bands['2br'].rent.median, null);   // n=1 < 2
  assert.equal(s.bands.unknown.n, 1);
  assert.equal(bandOf({ bedrooms: 0 }, policy.bedroom_bands), 'studio');
});

test('marketTable groups, sorts by size, limits', () => {
  const rows = [mk(), mk(), mk({ geo_municipality: 'CITY OF BRANDON', rent: 900 }), mk({ geo_municipality: null }), mk({ geo_mls_area: null })];
  const t = marketTable(rows, 'muni', policy);
  assert.deepEqual(t.map((r) => [r.market, r.n]), [['CITY OF WINNIPEG', 3], ['CITY OF BRANDON', 1], ['(unassigned)', 1]]);
  assert.equal(t[0].all.rent.median, 1200);
  assert.equal(t[1].all.rent.median, null);
  assert.equal(marketTable(rows, 'mls', policy, { limit: 1 }).length, 1);
  assert.equal(marketTable(rows, 'mls', policy).at(-1).market, '(none)');   // catch-all bucket sorts last
});

test('periodKey / periodsBetween: month and ISO-week (Monday)', () => {
  assert.equal(periodKey('2026-09-14', 'month'), '2026-09');
  assert.equal(periodKey('2026-09-14', 'week'), '2026-09-14');   // a Monday
  assert.equal(periodKey('2026-09-13', 'week'), '2026-09-07');   // Sunday → previous Monday
  assert.equal(periodKey('junk'), null);
  assert.deepEqual(periodsBetween('2026-11-15', '2027-01-03', 'month'), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(periodsBetween('2026-09-02', '2026-09-16', 'week'), ['2026-08-31', '2026-09-07', '2026-09-14']);
  assert.deepEqual(periodsBetween('2026-09-02', '2026-08-01', 'month'), ['2026-09']);
});

test('trendSeries: overlap semantics, latest run wins, scope, suppression', () => {
  const L = [mk({ id: 1, sqft: 500 }), mk({ id: 2, sqft: 1000 }), mk({ id: 3, bedrooms: 2 })];
  const S = [
    { listing_id: 1, rent: 1000, from: '2026-07-20', to: '2026-08-10', n_obs: 4 },
    { listing_id: 1, rent: 1100, from: '2026-08-17', to: '2026-09-07', n_obs: 3 },   // August: 1100 (latest run overlapping)
    { listing_id: 2, rent: 2000, from: '2026-08-01', to: '2026-09-13', n_obs: 7 },
    { listing_id: 3, rent: 1500, from: '2026-09-01', to: '2026-09-13', n_obs: 2 },
    { listing_id: 99, rent: 5, from: '2026-08-01', to: '2026-08-01', n_obs: 1 },     // not a listing we know
  ];
  const t = trendSeries(L, S, { policy, gran: 'month' });
  assert.deepEqual(t.periods, ['2026-07', '2026-08', '2026-09']);
  const aug1br = t.rent.find((r) => r.period === '2026-08' && r.band === '1br');
  assert.equal(aug1br.n, 2);
  assert.equal(aug1br.median, 1550);                         // (1100 + 2000) / 2
  const augPsf = t.psf.find((r) => r.period === '2026-08' && r.band === '1br');
  assert.equal(augPsf.median, 2.1);                          // (2.2 + 2.0) / 2
  const jul = t.rent.find((r) => r.period === '2026-07' && r.band === '1br');
  assert.equal(jul.n, 1); assert.equal(jul.median, null);    // suppressed
  const inv = t.inventory.filter((r) => r.period === '2026-09');
  assert.equal(inv.find((r) => r.band === 'all').n, 3);
  assert.equal(inv.find((r) => r.band === '2br').n, 1);
  const scoped = trendSeries(L, S, { policy, ids: new Set([2]) });
  assert.deepEqual(scoped.periods, ['2026-08', '2026-09']);
  assert.equal(scoped.inventory.find((r) => r.period === '2026-08' && r.band === 'all').n, 1);
  const weekly = trendSeries(L, S, { policy, gran: 'week' });
  assert.ok(weekly.periods.includes('2026-08-31'));
});

test('histogram and sizePoints', () => {
  const rows = [mk({ rent: 1050 }), mk({ rent: 1099 }), mk({ rent: 1150, bedrooms: 2 }), mk({ rent: 99999 }), mk({ rent: 1000, sqft: -1 })];
  assert.deepEqual(histogram(rows, policy, 100), [{ bin: 1000, band: '1br', n: 3 }, { bin: 1100, band: '2br', n: 1 }]);
  const pts = sizePoints(rows, policy);
  assert.equal(pts.length, 3);                               // sqft -1 and out-of-band rent dropped
  assert.equal(pts[0].band, '1br');
});

test('otherStats: days listed, price changes, amenity shares, source mix', () => {
  const rows = [
    mk({ id: 1, first_seen: '2026-08-01', last_seen: '2026-08-31', parking_included: true, elevator: false, util_heat: true, pet_policy: 'no pets' }),
    mk({ id: 2, first_seen: '2026-09-01', last_seen: '2026-09-11', parking_included: false, pet_policy: 'all', source: 'rentfaster' }),
    mk({ id: 3, bedrooms: 2, first_seen: '2026-09-13', last_seen: '2026-09-13' }),
  ];
  const segs = [
    { listing_id: 1, rent: 1000, from: '2026-08-01', to: '2026-08-15' }, { listing_id: 1, rent: 1100, from: '2026-08-22', to: '2026-08-31' },
    { listing_id: 2, rent: 1200, from: '2026-09-01', to: '2026-09-11' },
    { listing_id: 3, rent: null, from: '2026-09-13', to: '2026-09-13' },
  ];
  const o = otherStats(rows, segs, policy);
  const all = o.bands.all;
  assert.equal(all.n, 3);
  assert.equal(all.daysMedian, 10);
  assert.equal(all.changedShare, 1 / 3);
  assert.equal(all.changePctMedian, null);                  // one change < minN 2
  assert.equal(all.parkingShare, 0.5); assert.equal(all.parkingKnown, 2);
  assert.equal(all.elevatorShare, 0);
  assert.equal(all.heatShare, 1 / 3);
  assert.equal(all.petsShare, 0.5);
  assert.deepEqual(o.sources.map((s) => [s.source, s.n]), [['kijiji', 2], ['rentfaster', 1]]);
  assert.equal(o.bands['1br'].n, 2);
});
