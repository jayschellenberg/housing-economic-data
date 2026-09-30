/*
 * bundle.js — the export bundle's shape, and the parsers that turn its
 * three files into typed records.
 *
 * The producer is v3/export_web.py in this repo; its RECORD_COLUMNS and
 * RUN_COLUMNS are the contract. This module is the ONLY place that knows
 * the column names, so a schema bump is a change here and in
 * export_web.py, nowhere else.
 *
 * Pure (no DOM, no IndexedDB) so it runs under node for tests — including
 * a test that parses the live published folder when it is present.
 *
 * RESTRICTED COLUMNS. Some columns are derived from licensed sources.
 * Which ones is not hard-coded here: it comes from the connected bundle's
 * manifest (restricted_columns / restricted_notice), so nothing about
 * them is baked into the deployed page. Use restrictedColumns(manifest)
 * rather than a list of your own.
 */

import { tokenizeRows } from './delimitedRows.js';

/** Major schema version this build understands. Minor additions (new
 *  columns) are tolerated; a different major is refused. */
export const SCHEMA_MAJOR = 1;

export const FILES = Object.freeze({
  manifest: 'manifest.json',
  records: 'records.csv',
  runs: 'history_runs.csv',
  // OPTIONAL: Winnipeg's civic address points, for placing a subject by
  // address. A folder without it still loads — the subject box then
  // resolves only addresses that have a listing.
  addresses: 'address_points.csv',
});

// Columns the parsers REQUIRE. Anything else in the header rides along as
// a string (forward compatibility within a major version).
const NUM_COLS = [
  'latitude', 'longitude',
  'months_on_market', 'days_on_market',
  'sf_min', 'sf_max', 'land_acres', 'land_sf',
  'original_price', 'current_price', 'current_price_psf_annual',
  'net_rent', 'additional_rent', 'asking_price', 'extraction_confidence',
];
const TEXT_COLS = [
  'listing_id', 'address', 'property_name', 'unit', 'city',
  'brokerage', 'space_type', 'listing_type',
  'geo_confidence', 'neighbourhood', 'cluster', 'municipality',
  'status', 'first_seen', 'last_seen', 'listed_date', 'listed_date_source',
  'sold_date', 'sold_type',
  'original_price_date', 'original_price_basis',
  'current_price_date', 'current_price_basis', 'current_price_source',
  'ceiling_height', 'loading_doors', 'zoning', 'grade_or_dock', 'comments',
  'dup_group', 'flyer_path',
];
export const REQUIRED_RECORD_COLUMNS = Object.freeze([...NUM_COLS, ...TEXT_COLS]);
export const REQUIRED_RUN_COLUMNS = Object.freeze([
  'listing_id', 'kind', 'value', 'basis', 'from', 'to', 'cycles',
]);

// Licensed columns are numbers too, but they are not REQUIRED: the parser
// must not fail on a bundle published without them. Named here only so
// they are typed when present.
// `units` is deliberately optional rather than required: a folder that has
// not been republished since it was added must still parse, not refuse.
// `conditional_date`, `relisted_date` and `roll_number` need no entry here:
// they are text, and unnamed text columns already ride along (see
// parseRecords). They are named in this comment rather than a list so nobody
// adds them to REQUIRED_RECORD_COLUMNS, which would refuse every folder
// published before they existed (2026-09-15 and 2026-09-22) instead of
// simply leaving the fields null.
const OPTIONAL_NUM_COLS = [
  'units',
  'moodys_original_price', 'moodys_current_price', 'moodys_email_last_price',
  'moodys_sold_size_max_sf', 'moodys_sold_price', 'n1_sale_price',
  'prior_n1_sale_price',
];

const toNum = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
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
  for (const f of [FILES.records, FILES.runs]) {
    if (!m.files || !m.files[f]) throw new Error(`manifest.json does not describe ${f}`);
  }
  return m;
}

/** The licensed columns this bundle declares, as a Set. Empty when the
 *  bundle declares none — never assume, never hard-code. */
export function restrictedColumns(manifest) {
  const list = manifest?.restricted_columns;
  return new Set(Array.isArray(list) ? list.map(String) : []);
}

/** The cycle every time window is measured from — the newest month in the
 *  DATA, never the wall clock. An unrefreshed folder must not shrink by
 *  the day. */
export function dataCycle(manifest) {
  return manifest?.cycles?.last || null;
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
 * records.csv → array of typed listing records. Numbers are numbers,
 * empty text is null. Columns the contract does not name — including the
 * licensed ones — ride along, numeric where they are known to be numeric
 * and text otherwise.
 */
export function parseRecords(text) {
  const rows = tokenizeRows(text, ',');
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const idx = headerIndex(header, REQUIRED_RECORD_COLUMNS, FILES.records);
  const known = new Set(REQUIRED_RECORD_COLUMNS);
  const optionalNum = new Set(OPTIONAL_NUM_COLS);
  const extras = header.filter((h) => !known.has(h));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (c) => row[idx.get(c)] ?? '';
    const rec = {};
    for (const c of NUM_COLS) rec[c] = toNum(cell(c));
    for (const c of TEXT_COLS) rec[c] = toText(cell(c));
    for (const c of extras) rec[c] = optionalNum.has(c) ? toNum(cell(c)) : toText(cell(c));
    if (rec.listing_id == null) continue;   // a row without an id is not a listing
    out.push(rec);
  }
  return out;
}

/**
 * history_runs.csv → [{listing_id, kind, value, basis, from, to, cycles}].
 *
 * A run is a closed span of cycle months over which one value held:
 * pass2_build records change points only, so the run ends the month
 * before the next change (the last ends at the listing's last_seen).
 * `value` is a number for kind='price' and text for kind='status'.
 */
export function parseRuns(text) {
  const rows = tokenizeRows(text, ',');
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const idx = headerIndex(header, REQUIRED_RUN_COLUMNS, FILES.runs);
  const [iL, iK, iV, iB, iF, iT, iC] = REQUIRED_RUN_COLUMNS.map((c) => idx.get(c));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lid = toText(row[iL]);
    if (lid == null) continue;
    const kind = toText(row[iK]);
    out.push({
      listing_id: lid,
      kind,
      value: kind === 'price' ? toNum(row[iV]) : toText(row[iV]),
      basis: toText(row[iB]),
      from: toText(row[iF]),
      to: toText(row[iT]),
      cycles: toNum(row[iC]) ?? 1,
    });
  }
  return out;
}

/**
 * Parse all three files at once. `texts` is {manifest, records, runs} as
 * raw text. Returns them typed, and checks the CSV row counts against
 * what the manifest promised — a truncated copy (Dropbox mid-sync) shows
 * up here, not as a silently smaller market.
 */
export function parseBundle(texts) {
  const manifest = validateManifest(JSON.parse(texts.manifest));
  const records = parseRecords(texts.records);
  const runs = parseRuns(texts.runs);
  const expected = [
    [FILES.records, records.length, manifest.files[FILES.records].rows],
    [FILES.runs, runs.length, manifest.files[FILES.runs].rows],
  ];
  for (const [name, got, want] of expected) {
    if (want != null && want !== got) {
      throw new Error(`${name} has ${got} rows but the manifest expects ${want} — the folder may still be syncing; try Reload.`);
    }
  }
  return { manifest, records, runs };
}
