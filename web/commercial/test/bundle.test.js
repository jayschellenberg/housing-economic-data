/*
 * The schema contract: what the site requires of a bundle, what it
 * tolerates, and what it must refuse rather than mis-read. The producer
 * half is v3/export_web.py.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILES, SCHEMA_MAJOR,
  REQUIRED_RECORD_COLUMNS, REQUIRED_RUN_COLUMNS,
  parseRecords, parseRuns, parseBundle, validateManifest,
  restrictedColumns, dataCycle,
} from '../src/lib/bundle.js';

const RECORD_HEADER = [...REQUIRED_RECORD_COLUMNS];
const cell = (col, values) => values[col] ?? '';

function recordsCsv(rows, extraCols = []) {
  const header = [...RECORD_HEADER, ...extraCols];
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((c) => cell(c, r)).join(','));
  return lines.join('\n') + '\n';
}

function runsCsv(rows) {
  const lines = [REQUIRED_RUN_COLUMNS.join(',')];
  for (const r of rows) lines.push(REQUIRED_RUN_COLUMNS.map((c) => cell(c, r)).join(','));
  return lines.join('\n') + '\n';
}

const manifest = (over = {}) => ({
  schema_version: SCHEMA_MAJOR,
  cycles: { first: '2018-01', last: '2026-09', count: 105 },
  counts: { records: 1, runs: 1 },
  restricted_columns: ['moodys_id', 'n1_sale_price'],
  restricted_notice: 'Do not redistribute.',
  files: {
    [FILES.records]: { rows: 1 },
    [FILES.runs]: { rows: 1 },
  },
  ...over,
});

const ROW = {
  listing_id: '100 MAIN ST||UNIT 1|CBRE|LEASE',
  address: '100 Main St', city: 'Winnipeg', brokerage: 'CBRE',
  space_type: 'Office', listing_type: 'Lease', status: 'Active',
  first_seen: '2026-01', last_seen: '2026-09',
  latitude: '49.89', longitude: '-97.14', sf_min: '1829',
  current_price: '12.5', current_price_psf_annual: '12.50',
  current_price_basis: 'psf_annual',
};

test('records parse with numbers typed and blanks as null', () => {
  const [rec] = parseRecords(recordsCsv([ROW]));
  assert.equal(rec.listing_id, '100 MAIN ST||UNIT 1|CBRE|LEASE');
  assert.equal(rec.latitude, 49.89);
  assert.equal(rec.sf_min, 1829);
  assert.equal(rec.current_price_psf_annual, 12.5);
  assert.equal(rec.land_acres, null, 'an empty numeric cell is null, not 0');
  assert.equal(rec.zoning, null);
});

test('a comma inside a quoted comment does not shift the columns', () => {
  const csv = recordsCsv([{ ...ROW, comments: '"Corner unit, rear dock"' }]);
  const [rec] = parseRecords(csv);
  assert.equal(rec.comments, 'Corner unit, rear dock');
  assert.equal(rec.status, 'Active');
});

test('unknown columns ride along; the licensed ones are typed', () => {
  const csv = recordsCsv([{ ...ROW, moodys_id: 'M-1', n1_sale_price: '1750000' }],
    ['moodys_id', 'n1_sale_price']);
  const [rec] = parseRecords(csv);
  assert.equal(rec.moodys_id, 'M-1');
  assert.equal(rec.n1_sale_price, 1750000, 'a known-numeric extra is a number');
});

test('units parses as a number, and an older bundle without it still loads', () => {
  // `units` is a dwelling count, added after the first bundles shipped. A
  // folder nobody has republished must keep working, so it is optional.
  const withUnits = parseRecords(recordsCsv([{ ...ROW, units: '52' }], ['units']));
  assert.equal(withUnits[0].units, 52, 'a count, not the string "52"');
  const without = parseRecords(recordsCsv([ROW]));
  assert.equal(without.length, 1, 'a pre-units bundle still parses');
  assert.equal(without[0].units, undefined);
});

test('a missing required column names itself', () => {
  const header = RECORD_HEADER.filter((c) => c !== 'space_type').join(',');
  assert.throws(() => parseRecords(`${header}\n`), /space_type/);
});

test('runs type value by kind', () => {
  const runs = parseRuns(runsCsv([
    { listing_id: 'A', kind: 'price', value: '12.5', basis: 'psf_annual', from: '2026-01', to: '2026-03', cycles: '3' },
    { listing_id: 'A', kind: 'status', value: 'Active', basis: '', from: '2026-01', to: '2026-09', cycles: '9' },
  ]));
  assert.equal(runs[0].value, 12.5);
  assert.equal(runs[0].basis, 'psf_annual');
  assert.equal(runs[1].value, 'Active', 'a status is text, not NaN');
  assert.equal(runs[1].basis, null);
  assert.equal(runs[1].cycles, 9);
});

test('a bundle of a different major version is refused, not guessed at', () => {
  assert.throws(() => validateManifest(manifest({ schema_version: SCHEMA_MAJOR + 1 })),
    /understands/);
  assert.throws(() => validateManifest({}), /schema_version/);
});

test('row counts must agree with the manifest', () => {
  // A folder caught mid-sync yields a short CSV; better to say so than to
  // show a market that is quietly missing half its listings.
  const texts = {
    manifest: JSON.stringify(manifest({ files: { [FILES.records]: { rows: 9 }, [FILES.runs]: { rows: 1 } } })),
    records: recordsCsv([ROW]),
    runs: runsCsv([{ listing_id: 'A', kind: 'price', value: '1', basis: '', from: '2026-01', to: '2026-01', cycles: '1' }]),
  };
  assert.throws(() => parseBundle(texts), /syncing/);
});

test('parseBundle returns the three parsed parts', () => {
  const texts = {
    manifest: JSON.stringify(manifest()),
    records: recordsCsv([ROW]),
    runs: runsCsv([{ listing_id: 'A', kind: 'price', value: '1', basis: '', from: '2026-01', to: '2026-01', cycles: '1' }]),
  };
  const b = parseBundle(texts);
  assert.equal(b.records.length, 1);
  assert.equal(b.runs.length, 1);
  assert.equal(dataCycle(b.manifest), '2026-09');
});

test('restricted columns come from the bundle, never from this build', () => {
  assert.deepEqual([...restrictedColumns(manifest())], ['moodys_id', 'n1_sale_price']);
  // A bundle that declares none must not cause the site to invent some.
  assert.equal(restrictedColumns(manifest({ restricted_columns: undefined })).size, 0);
  assert.equal(restrictedColumns(null).size, 0);
});
