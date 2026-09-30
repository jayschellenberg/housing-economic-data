import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFilters, normalizeFilters, applyFilters, additionalChips, isDefault,
  bedroomBand, normalizePets, rentPerSqft, resolveWindow, shiftIso, muniKey, UNASSIGNED,
} from '../src/lib/filters.js';

const base = {
  id: 0, source: 'kijiji', url: 'u', title: 'Nice place', address: '100 Main St', city: 'Winnipeg',
  postal_code: null, neighborhood: null, geo_neighborhood: 'Osborne Village', geo_mls_area: '1B',
  geo_municipality: 'CITY OF WINNIPEG', lat: 49.8, lng: -97.1, geocode_confidence: 0.9,
  property_type: 'apartment', bedrooms: 2, bathrooms: 1, sqft: 800, pet_policy: null,
  parking_included: null, parking_rate: null, laundry: null, elevator: null,
  util_heat: null, util_water: null, util_electricity: null, util_internet: null, util_cable: null,
  furnished: null, first_seen: '2026-08-01', last_seen: '2026-09-13', rent: 1600,
  rent_observed: '2026-09-13', status: 'active', available_date: null,
  dedup_canonical: true, canonical_listing_id: 0, cited_in_report: false, evidence_path: null,
};
let seq = 1;
const mk = (over = {}) => ({ ...base, id: seq++, ...over });
const ctx = { asOf: '2026-09-13', policy: { active_window_days: 60, bedroom_bands: [
  { key: 'studio', min: 0, max: 1 }, { key: '1br', min: 1, max: 2 }, { key: '2br', min: 2, max: 3 },
  { key: '3br', min: 3, max: 4 }, { key: '4plus', min: 4, max: null }] } };

test('shiftIso and resolveWindow', () => {
  assert.equal(shiftIso('2026-09-13', { days: -60 }), '2026-07-15');
  assert.equal(shiftIso('2026-03-31', { months: -1 }), '2026-03-03');   // JS month overflow, documented behaviour
  assert.deepEqual(resolveWindow({ window: 'active' }, ctx), { from: '2026-07-15', to: null });
  assert.deepEqual(resolveWindow({ window: '12' }, ctx), { from: '2025-09-13', to: null });
  assert.deepEqual(resolveWindow({ window: 'all' }, ctx), { from: null, to: null });
  assert.deepEqual(resolveWindow({ window: 'custom', from: '2026-01-01', to: '' }, ctx), { from: '2026-01-01', to: null });
});

test('bedroomBand, normalizePets, rentPerSqft, muniKey', () => {
  assert.equal(bedroomBand(0), 'studio');
  assert.equal(bedroomBand(1.5), '1br');
  assert.equal(bedroomBand(5), '4plus');
  assert.equal(bedroomBand(null), null);
  assert.equal(bedroomBand(-1), null);
  for (const s of ['0', 'no pets', 'No Pets', 'none', 'Not Available']) assert.equal(normalizePets(s), 'no', s);
  for (const s of ['1', 'all', 'limited', 'cats, dogs', 'Pet Friendly']) assert.equal(normalizePets(s), 'allowed', s);
  assert.equal(normalizePets(''), null);
  assert.equal(rentPerSqft({ rent: 1600, sqft: 800 }), 2);
  assert.equal(rentPerSqft({ rent: 1600, sqft: -1 }), null);
  assert.equal(rentPerSqft({ rent: 1600, sqft: 40 }), null);       // implausible size → no ratio
  assert.equal(rentPerSqft({ rent: 1600, sqft: 12345 }), null);
  assert.equal(rentPerSqft({ rent: null, sqft: 800 }), null);
  assert.equal(muniKey({ geo_municipality: null }), UNASSIGNED);
});

test('default window keeps active listings and drops stale ones', () => {
  const rows = [mk(), mk({ last_seen: '2026-05-01', first_seen: '2026-04-01' })];
  const out = applyFilters(rows, defaultFilters(), ctx);
  assert.deepEqual(out.map((l) => l.id), [rows[0].id]);
  const all = applyFilters(rows, { ...defaultFilters(), window: 'all' }, ctx);
  assert.equal(all.length, 2);
  // custom window: span overlap, not containment
  const custom = applyFilters(rows, { ...defaultFilters(), window: 'custom', from: '2026-04-15', to: '2026-04-20' }, ctx);
  assert.deepEqual(custom.map((l) => l.id), [rows[1].id]);
});

test('canonical, type, bedroom band and geography filters', () => {
  const rows = [
    mk(),
    mk({ dedup_canonical: false }),
    mk({ property_type: 'townhouse' }),
    mk({ bedrooms: 0 }),
    mk({ bedrooms: null }),
    mk({ geo_municipality: null, geo_neighborhood: null, geo_mls_area: null }),
    mk({ source: 'rentfaster' }),
  ];
  const f = defaultFilters();
  assert.equal(applyFilters(rows, f, ctx).length, 6);                       // non-canonical dropped
  assert.equal(applyFilters(rows, { ...f, canonicalOnly: false }, ctx).length, 7);
  assert.equal(applyFilters(rows, { ...f, types: ['townhouse'] }, ctx).length, 1);
  assert.equal(applyFilters(rows, { ...f, beds: ['studio'] }, ctx).length, 1);   // null bedrooms excluded once narrowed
  assert.equal(applyFilters(rows, { ...f, munis: [UNASSIGNED] }, ctx).length, 1);
  assert.equal(applyFilters(rows, { ...f, munis: ['CITY OF WINNIPEG'] }, ctx).length, 5);
  assert.equal(applyFilters(rows, { ...f, nbhds: ['Osborne Village'] }, ctx).length, 5);
  assert.equal(applyFilters(rows, { ...f, mls: ['9A'] }, ctx).length, 0);
  assert.equal(applyFilters(rows, { ...f, sources: ['rentfaster'] }, ctx).length, 1);
});

test('numeric, amenity and text filters', () => {
  const rows = [
    mk({ rent: 1000, sqft: 500, bathrooms: 1, parking_included: true, elevator: true, furnished: false,
      pet_policy: 'no pets', laundry: 'in-unit', util_heat: true, address: '5 River Ave', title: 'Sunny loft' }),
    mk({ rent: 2000, sqft: 1000, bathrooms: 2, parking_included: false, parking_rate: 75, elevator: false,
      furnished: true, pet_policy: 'all', laundry: 'in-building', util_heat: null, lat: null, lng: null }),
    mk({ rent: null, sqft: null }),
  ];
  const f = defaultFilters();
  const ids = (g) => applyFilters(rows, { ...f, ...g }, ctx).map((l) => l.id);
  const [a, b, c] = rows.map((l) => l.id);
  assert.deepEqual(ids({ rentLo: '1500' }), [b]);
  assert.deepEqual(ids({ rentHi: '1500' }), [a]);
  assert.deepEqual(ids({ sqftLo: '600', sqftHi: '1200' }), [b]);
  assert.deepEqual(ids({ psfLo: '1.9', psfHi: '2.1' }), [a, b]);   // both are $2.00/sf; c has no sqft
  assert.deepEqual(ids({ bathsMin: '2' }), [b]);
  assert.deepEqual(ids({ parking: 'included' }), [a]);
  assert.deepEqual(ids({ parking: 'paid' }), [b]);
  assert.deepEqual(ids({ elevator: 'yes' }), [a]);
  assert.deepEqual(ids({ elevator: 'no' }), [b]);
  assert.deepEqual(ids({ furnished: 'yes' }), [b]);
  assert.deepEqual(ids({ pets: 'no' }), [a]);
  assert.deepEqual(ids({ pets: 'allowed' }), [b]);
  assert.deepEqual(ids({ laundry: 'in-unit' }), [a]);
  assert.deepEqual(ids({ heat: true }), [a]);
  assert.deepEqual(ids({ address: 'river' }), [a]);
  assert.deepEqual(ids({ title: 'LOFT' }), [a]);
  assert.deepEqual(ids({ coordsOnly: true }), [a, c]);
});

test('normalizeFilters merges over defaults and drops junk', () => {
  const f = normalizeFilters({ window: '12', munis: ['X'], canonicalOnly: 0, rentLo: 900, bogus: 1 });
  assert.equal(f.window, '12');
  assert.deepEqual(f.munis, ['X']);
  assert.equal(f.canonicalOnly, false);
  assert.equal(f.rentLo, '900');
  assert.equal('bogus' in f, false);
  assert.equal(isDefault(defaultFilters()), true);
  assert.equal(isDefault(f), false);
});

test('additionalChips names every hidden control that is set', () => {
  assert.deepEqual(additionalChips(defaultFilters()), []);
  const chips = additionalChips({ ...defaultFilters(), sqftLo: '600', sqftHi: '1200', parking: 'included',
    pets: 'no', heat: true, water: true, address: ' Main ', coordsOnly: true, psfHi: '2.5' });
  assert.deepEqual(chips.map((c) => c.key), ['sqft', 'psf', 'parking', 'pets', 'utilities', 'address', 'coordsOnly']);
  assert.equal(chips[0].label, '600–1,200 sf');
  assert.equal(chips[1].label, '≤ $2.50 /sf');
  assert.equal(chips[4].label, 'heat + water incl.');
  assert.equal(chips[5].label, 'Address "Main"');
});

test('haversineKm, subjectOf, annotateDistance, radius filter', async () => {
  const { haversineKm, subjectOf, annotateDistance } = await import('../src/lib/filters.js');
  const d = haversineKm(49.8951, -97.1384, 49.8437, -99.9531);   // Portage & Main → Brandon
  assert.ok(d > 195 && d < 205, `got ${d}`);
  assert.equal(subjectOf({ subjectLat: '', subjectLng: '' }), null);
  assert.equal(subjectOf({ subjectLat: '95', subjectLng: '0' }), null);
  assert.deepEqual(subjectOf({ subjectLat: '49.9', subjectLng: '-97.1' }), { lat: 49.9, lng: -97.1 });
  const rows = [mk({ lat: 49.9, lng: -97.1 }), mk({ lat: 49.85, lng: -99.95 }), mk({ lat: null, lng: null })];
  annotateDistance(rows, { lat: 49.9, lng: -97.1 });
  assert.equal(rows[0]._dist, 0);
  assert.ok(rows[1]._dist > 190);
  assert.equal(rows[2]._dist, null);
  const f = { ...defaultFilters(), subjectLat: '49.9', subjectLng: '-97.1', radiusKm: '5' };
  assert.deepEqual(applyFilters(rows, f, ctx).map((l) => l.id), [rows[0].id]);   // unmapped rows drop under a radius
  assert.equal(applyFilters(rows, { ...f, radiusKm: '' }, ctx).length, 3);        // subject alone narrows nothing
  assert.equal(additionalChips(f).at(-1).label, '≤ 5 km of subject');
  annotateDistance(rows, null);
  assert.equal(rows[0]._dist, null);
});

test('shapes and adjacency in applyFilters, normalizeFilters and chips', async () => {
  const { buildMuniIndex } = await import('../src/lib/munis.js');
  const index = buildMuniIndex([
    { muni_no: 100, name: 'CITY OF WINNIPEG', region: 'Winnipeg', adjacent: ['198'] },
    { muni_no: 198, name: 'RM OF SPRINGFIELD', region: 'Southeast', adjacent: ['100'] },
  ]);
  const rows = [
    mk({ lat: 49.9, lng: -97.1 }),                                              // Winnipeg, inside the square below
    mk({ lat: 49.5, lng: -96.5, geo_municipality: 'RM OF SPRINGFIELD' }),
    mk({ lat: null, lng: null }),
  ];
  const f = defaultFilters();
  const c = { ...ctx, muniIndex: index };
  assert.equal(applyFilters(rows, { ...f, munis: ['CITY OF WINNIPEG'] }, c).length, 2);
  assert.equal(applyFilters(rows, { ...f, munis: ['CITY OF WINNIPEG'], adjacent: true }, c).length, 3);
  assert.equal(applyFilters(rows, { ...f, munis: ['CITY OF WINNIPEG'], adjacent: true, muniExcluded: ['RM OF SPRINGFIELD'] }, c).length, 2);
  const square = { id: 1, kind: 'polygon', mode: 'include', ring: [[-97.2, 49.8], [-97.0, 49.8], [-97.0, 50.0], [-97.2, 50.0]] };
  assert.deepEqual(applyFilters(rows, { ...f, shapes: [square] }, c).map((l) => l.id), [rows[0].id]);   // unmapped drops too
  assert.equal(applyFilters(rows, { ...f, shapes: [{ ...square, mode: 'exclude' }] }, c).length, 1);    // only the Springfield row survives
  const n = normalizeFilters({ shapes: [square, 'junk'], adjacent: 1, muniExcluded: ['X'] });
  assert.equal(n.shapes.length, 1);
  assert.equal(n.adjacent, true);
  assert.deepEqual(n.muniExcluded, ['X']);
  const chips = additionalChips({ ...f, shapes: [square, { ...square, id: 2, mode: 'exclude' }] });
  assert.equal(chips.at(-1).label, '1 drawn area, 1 excluded area');
});
