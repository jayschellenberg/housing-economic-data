import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, sortRows, pageSlice, stats, toCsv, areaOf, addressOf, EXPORT_FIELDS } from '../src/lib/results.js';

const mk = (id, over = {}) => ({
  id, source: 'kijiji', url: `https://k/${id}`, title: `T${id}`, address: `${id} Main St`, city: 'Winnipeg',
  geo_neighborhood: null, geo_mls_area: '1B', geo_municipality: 'CITY OF WINNIPEG', lat: 1, lng: 2,
  property_type: 'apartment', bedrooms: 1, bathrooms: 1, sqft: 700, rent: 1200, first_seen: '2026-08-01',
  last_seen: '2026-09-13', status: 'active', dedup_canonical: true, cited_in_report: false, evidence_path: null,
  pet_policy: null, parking_included: null, parking_rate: null, laundry: null, elevator: null,
  util_heat: null, util_water: null, util_electricity: null, util_internet: null, util_cable: null,
  furnished: null, rent_observed: '2026-09-13', available_date: null, postal_code: null, ...over,
});

test('areaOf / addressOf fall back sensibly', () => {
  assert.equal(areaOf(mk(1)), '1B');
  assert.equal(areaOf(mk(1, { geo_neighborhood: 'Osborne' })), 'Osborne');
  assert.equal(addressOf(mk(1, { address: null })), 'T1');
});

test('sortRows: numeric, text, nulls last, stable', () => {
  const rows = [mk(1, { rent: 1500 }), mk(2, { rent: null }), mk(3, { rent: 900 }), mk(4, { rent: 900 })];
  assert.deepEqual(sortRows(rows, 'rent', 'asc').map((l) => l.id), [3, 4, 1, 2]);
  assert.deepEqual(sortRows(rows, 'rent', 'desc').map((l) => l.id), [1, 3, 4, 2]);
  const txt = [mk(1, { address: '10 Main St' }), mk(2, { address: '9 Main St' }), mk(3, { address: 'b' })];
  assert.deepEqual(sortRows(txt, 'address', 'asc').map((l) => l.id), [2, 1, 3]);   // numeric-aware
  assert.deepEqual(sortRows(rows, 'nope', 'asc').map((l) => l.id), [1, 2, 3, 4]);
});

test('pageSlice clamps', () => {
  const rows = Array.from({ length: 250 }, (_, i) => mk(i + 1));
  assert.deepEqual(pageSlice(rows, 1, 100).rows.map((l) => l.id).slice(0, 2), [1, 2]);
  const last = pageSlice(rows, 99, 100);
  assert.equal(last.page, 3);
  assert.equal(last.pages, 3);
  assert.equal(last.rows.length, 50);
  assert.equal(pageSlice([], 1, 100).pages, 1);
});

test('stats: display band, min-n suppression, per-band medians', () => {
  const policy = { display_rent_min: 500, display_rent_max: 5000, min_n_for_median: 3,
    bedroom_bands: [{ key: 'studio', min: 0, max: 1 }, { key: '1br', min: 1, max: 2 }, { key: '2br', min: 2, max: 3 },
      { key: '3br', min: 3, max: 4 }, { key: '4plus', min: 4, max: null }] };
  const rows = [
    mk(1, { rent: 1000, sqft: 500 }), mk(2, { rent: 1200, sqft: 600 }), mk(3, { rent: 1400, sqft: 700 }),
    mk(4, { rent: 9000 }),                       // outside display band: ignored for medians
    mk(5, { rent: 2000, bedrooms: 2, dedup_canonical: false }),
    mk(6, { rent: null }),
  ];
  const s = stats(rows, policy);
  assert.equal(s.n, 6);
  assert.equal(s.canonical, 5);
  assert.equal(s.inBand, 4);
  assert.equal(s.medianRent, 1300);
  assert.equal(s.medianPsf, 2);
  assert.deepEqual(s.byBand.find((b) => b.key === '1br'), { key: '1br', n: 3, median: 1200 });
  assert.deepEqual(s.byBand.find((b) => b.key === '2br'), { key: '2br', n: 1, median: null });   // suppressed
  assert.equal(stats([], policy).medianRent, null);
});

test('toCsv quotes, booleans, derived $/sf, BOM', () => {
  const csv = toCsv([
    mk(1, { title: 'Say "hi", now' }),
    mk(2, { dedup_canonical: true, furnished: false }),
  ]);
  assert.ok(csv.startsWith('﻿' + EXPORT_FIELDS.join(',')));
  const [, quoted, line] = csv.split('\r\n');
  assert.ok(quoted.includes('"Say ""hi"", now"'));
  assert.ok(line.includes(',1.714,'));      // 1200/700
  const cells = line.split(',');            // row 2 has no quoted commas
  assert.equal(cells[EXPORT_FIELDS.indexOf('dedup_canonical')], '1');
  assert.equal(cells[EXPORT_FIELDS.indexOf('furnished')], '0');
  assert.equal(cells[EXPORT_FIELDS.indexOf('evidence_path')], '');
});

test('COLUMNS render text for every key', () => {
  const l = mk(1, { bedrooms: 0, sqft: -1, rent: 1234 });
  const by = Object.fromEntries(COLUMNS.map((c) => [c.key, c.text(l)]));
  assert.equal(by.beds, 'Studio');
  assert.equal(by.sqft, '');
  assert.equal(by.rent, '$1,234');
  assert.equal(by.psf, '');
});

test('distance column and CSV field follow _dist', () => {
  const l = mk(1); l._dist = 3.456;
  const col = COLUMNS.find((c) => c.key === 'dist');
  assert.equal(col.text(l), '3.5');
  assert.equal(col.text(mk(2)), '');
  const csv = toCsv([l]);
  const cells = csv.split('\r\n')[1].split(',');
  assert.equal(cells[EXPORT_FIELDS.indexOf('distance_km')], '3.46');
});
