/*
 * bundle.js — the export bundle's shape, and the parsers that turn its
 * three files into typed records.
 *
 * The producer is scripts/export_web.py in this repo; its LISTING_COLUMNS
 * and SEGMENT_COLUMNS are the contract. This module is the ONLY place
 * that knows the column names, so a schema bump is a change here and in
 * export_web.py, nowhere else.
 *
 * Pure (no DOM, no IndexedDB) so it runs under node for tests — including
 * a test that parses the live export folder when it is present.
 */

import { tokenizeRows } from './delimitedRows.js';

/** Major schema version this build understands. Minor additions (new
 *  columns) are tolerated; a different major is refused. */
export const SCHEMA_MAJOR = 1;

export const FILES = Object.freeze({
  manifest: 'manifest.json',
  listings: 'listings.csv',
  segments: 'rent_segments.csv',
});

// Columns the parsers REQUIRE. Anything else in the header is carried
// through untouched as a string (forward compatibility within a major).
const INT_COLS = ['id', 'sqft', 'parking_rate', 'rent', 'canonical_listing_id'];
const NUM_COLS = ['lat', 'lng', 'geocode_confidence', 'bedrooms', 'bathrooms'];
const BOOL_COLS = [
  'parking_included', 'elevator', 'furnished',
  'util_heat', 'util_water', 'util_electricity', 'util_internet', 'util_cable',
  'dedup_canonical', 'cited_in_report',
];
const TEXT_COLS = [
  'source', 'url', 'title', 'address', 'city', 'postal_code', 'neighborhood',
  'geo_neighborhood', 'geo_mls_area', 'geo_municipality',
  'property_type', 'pet_policy', 'laundry',
  'first_seen', 'last_seen', 'rent_observed', 'status', 'available_date',
  'evidence_path',
];
export const REQUIRED_LISTING_COLUMNS = Object.freeze([...INT_COLS, ...NUM_COLS, ...BOOL_COLS, ...TEXT_COLS]);
export const REQUIRED_SEGMENT_COLUMNS = Object.freeze(['listing_id', 'rent', 'from', 'to', 'n_obs']);

const toInt = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toNum = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** '1' → true, '0' → false, '' → null (unknown). */
const toBool = (s) => (s === '1' ? true : s === '0' ? false : null);
const toText = (s) => (s === '' || s == null ? null : String(s));

/**
 * Check a parsed manifest.json. Throws with a message meant for the
 * status line when the bundle is unusable; returns the manifest otherwise.
 */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object');
  const v = Number(m.schema_version);
  if (!Number.isFinite(v)) throw new Error('manifest.json has no schema_version');
  if (Math.floor(v) !== SCHEMA_MAJOR) {
    throw new Error(`This bundle is schema ${v}; this site understands ${SCHEMA_MAJOR}. Update the site or re-publish.`);
  }
  for (const f of [FILES.listings, FILES.segments]) {
    if (!m.files || !m.files[f]) throw new Error(`manifest.json does not describe ${f}`);
  }
  return m;
}

function headerIndex(header, required, fileName) {
  const idx = new Map(header.map((h, i) => [String(h).trim(), i]));
  const missing = required.filter((c) => !idx.has(c));
  if (missing.length) {
    throw new Error(`${fileName} is missing column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} — re-publish or update the site.`);
  }
  return idx;
}

/**
 * listings.csv → array of typed listing records. Numbers are numbers,
 * booleans are true/false/null (null = unknown, distinct from false),
 * empty text is null. Extra columns ride along as strings.
 */
export function parseListings(text) {
  const rows = tokenizeRows(text, ',');
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const idx = headerIndex(header, REQUIRED_LISTING_COLUMNS, FILES.listings);
  const known = new Set(REQUIRED_LISTING_COLUMNS);
  const extras = header.filter((h) => !known.has(h));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (c) => row[idx.get(c)] ?? '';
    const rec = {};
    for (const c of INT_COLS) rec[c] = toInt(cell(c));
    for (const c of NUM_COLS) rec[c] = toNum(cell(c));
    for (const c of BOOL_COLS) rec[c] = toBool(cell(c));
    for (const c of TEXT_COLS) rec[c] = toText(cell(c));
    for (const c of extras) rec[c] = toText(cell(c));
    if (rec.id == null) continue;   // a row without an id is not a listing
    out.push(rec);
  }
  return out;
}

/** rent_segments.csv → [{listing_id, rent, from, to, n_obs}]. */
export function parseSegments(text) {
  const rows = tokenizeRows(text, ',');
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const idx = headerIndex(header, REQUIRED_SEGMENT_COLUMNS, FILES.segments);
  const iL = idx.get('listing_id'), iR = idx.get('rent'), iF = idx.get('from'), iT = idx.get('to'), iN = idx.get('n_obs');
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lid = toInt(row[iL]);
    if (lid == null) continue;
    out.push({
      listing_id: lid,
      rent: toInt(row[iR]),
      from: toText(row[iF]),
      to: toText(row[iT]),
      n_obs: toInt(row[iN]) ?? 1,
    });
  }
  return out;
}

/**
 * Parse all three files at once. `texts` is {manifest, listings, segments}
 * as raw text. Returns {manifest, listings, segments} typed, and checks
 * that the CSV row counts agree with what the manifest promised — a
 * truncated copy (Dropbox mid-sync) shows up here, not as a silently
 * smaller market.
 */
export function parseBundle(texts) {
  const manifest = validateManifest(JSON.parse(texts.manifest));
  const listings = parseListings(texts.listings);
  const segments = parseSegments(texts.segments);
  const want = {
    listings: manifest.files[FILES.listings].rows,
    segments: manifest.files[FILES.segments].rows,
  };
  if (want.listings != null && want.listings !== listings.length) {
    throw new Error(`listings.csv has ${listings.length} rows but the manifest expects ${want.listings} — the folder may still be syncing; try Reload.`);
  }
  if (want.segments != null && want.segments !== segments.length) {
    throw new Error(`rent_segments.csv has ${segments.length} rows but the manifest expects ${want.segments} — the folder may still be syncing; try Reload.`);
  }
  return { manifest, listings, segments };
}
