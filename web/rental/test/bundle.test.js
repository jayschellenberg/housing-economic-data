import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILES, REQUIRED_SEGMENT_COLUMNS,
  parseListings, parseSegments, parseBundle, validateManifest,
} from '../src/lib/bundle.js';

// A listings.csv exactly as scripts/export_web.py writes it (its
// LISTING_COLUMNS order), with one extra trailing column to prove
// forward compatibility.
const HEADER = [
  'id', 'source', 'url', 'title', 'address', 'city', 'postal_code', 'neighborhood',
  'geo_neighborhood', 'geo_mls_area', 'geo_municipality', 'lat', 'lng', 'geocode_confidence',
  'property_type', 'bedrooms', 'bathrooms', 'sqft', 'pet_policy', 'parking_included', 'parking_rate',
  'laundry', 'elevator', 'util_heat', 'util_water', 'util_electricity', 'util_internet', 'util_cable',
  'furnished', 'first_seen', 'last_seen', 'rent', 'rent_observed', 'status', 'available_date',
  'dedup_canonical', 'canonical_listing_id', 'cited_in_report', 'evidence_path', 'future_col'];

const ROW1 = ['1', 'kijiji', 'https://k/1', 'Bright 2BR, near river', '100 Main St', 'Winnipeg', '', '',
  'Osborne Village', '', 'CITY OF WINNIPEG', '49.87', '-97.14', '0.9',
  'apartment', '2', '1.5', '850', '', '1', '',
  'in-unit', '0', '1', '0', '', '', '',
  '', '2026-08-15', '2026-09-13', '1000', '2026-09-13', 'active', '',
  '1', '1', '0', 'evidence/2026-09-08/kijiji/1.html', 'x'];
const ROW2 = ['2', 'rentals_ca', 'https://r/2', '', '', 'Brandon', '', '',
  '', '', 'CITY OF BRANDON', '', '', '',
  'townhouse', '3', '', '', '', '', '',
  '', '', '', '', '', '', '',
  '', '2026-05-01', '2026-05-01', '', '2026-05-01', 'new', '',
  '0', '1', '0', '', ''];

const csv = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';

const LISTINGS = csv([HEADER, ROW1, ROW2]);
const SEGMENTS = csv([
  [...REQUIRED_SEGMENT_COLUMNS],
  ['1', '1000', '2026-08-15', '2026-08-29', '3'],
  ['1', '950', '2026-09-05', '2026-09-13', '2'],
  ['2', '', '2026-05-01', '2026-05-01', '1'],
]);
const MANIFEST = {
  schema_version: 1,
  generated_at: '2026-09-14T13:56:51+00:00',
  counts: { listings: 2, segments: 3 },
  files: { [FILES.listings]: { rows: 2 }, [FILES.segments]: { rows: 3 } },
};

test('parseListings types every column and tolerates extras', () => {
  const recs = parseListings(LISTINGS);
  assert.equal(recs.length, 2);
  const a = recs[0];
  assert.equal(a.id, 1);
  assert.equal(a.title, 'Bright 2BR, near river');
  assert.equal(a.lat, 49.87);
  assert.equal(a.bedrooms, 2);
  assert.equal(a.bathrooms, 1.5);
  assert.equal(a.sqft, 850);
  assert.equal(a.parking_included, true);
  assert.equal(a.elevator, false);
  assert.equal(a.util_heat, true);
  assert.equal(a.util_water, false);
  assert.equal(a.util_electricity, null);
  assert.equal(a.furnished, null);
  assert.equal(a.rent, 1000);
  assert.equal(a.dedup_canonical, true);
  assert.equal(a.cited_in_report, false);
  assert.equal(a.evidence_path, 'evidence/2026-09-08/kijiji/1.html');
  assert.equal(a.future_col, 'x');
  const b = recs[1];
  assert.equal(b.rent, null);
  assert.equal(b.lat, null);
  assert.equal(b.title, null);
  assert.equal(b.dedup_canonical, false);
  assert.equal(b.future_col, null);
});

test('parseListings refuses a header missing a required column', () => {
  const bad = LISTINGS.replace('geo_municipality', 'muni');
  assert.throws(() => parseListings(bad), /missing column geo_municipality/);
});

test('parseSegments types rows', () => {
  assert.deepEqual(parseSegments(SEGMENTS), [
    { listing_id: 1, rent: 1000, from: '2026-08-15', to: '2026-08-29', n_obs: 3 },
    { listing_id: 1, rent: 950, from: '2026-09-05', to: '2026-09-13', n_obs: 2 },
    { listing_id: 2, rent: null, from: '2026-05-01', to: '2026-05-01', n_obs: 1 },
  ]);
});

test('validateManifest checks schema major and file entries', () => {
  assert.equal(validateManifest(MANIFEST), MANIFEST);
  assert.throws(() => validateManifest({ ...MANIFEST, schema_version: 2 }), /schema 2/);
  assert.throws(() => validateManifest({ ...MANIFEST, files: {} }), /does not describe/);
  assert.throws(() => validateManifest(null), /not an object/);
});

test('parseBundle cross-checks row counts against the manifest', () => {
  const ok = parseBundle({ manifest: JSON.stringify(MANIFEST), listings: LISTINGS, segments: SEGMENTS });
  assert.equal(ok.listings.length, 2);
  assert.equal(ok.segments.length, 3);
  const short = { ...MANIFEST, files: { ...MANIFEST.files, [FILES.listings]: { rows: 5 } } };
  assert.throws(
    () => parseBundle({ manifest: JSON.stringify(short), listings: LISTINGS, segments: SEGMENTS }),
    /still be syncing/,
  );
});
