/*
 * The three tiers of geography the explorer now shows: municipality,
 * Winnipeg community cluster, neighbourhood.
 *
 * Cluster was in the bundle from the start and rendered nowhere. The
 * grid's Area column reads `neighbourhood || cluster` and the fallback
 * never fires — pass4 stamps both from one polygon or neither — so the
 * cluster of a listing was invisible in every view, which is why the two
 * levels looked like one. 194 neighbourhoods roll up into 23 clusters and
 * the two values are never equal on any record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultFilters, applyFilters, describeFilters, DEFAULT_FILTERS } from '../src/lib/filters.js';
import { COLUMNS, COLUMN_KEYS } from '../src/lib/results.js';
import { REQUIRED_RECORD_COLUMNS } from '../src/lib/bundle.js';

const MANIFEST = {
  cycles: { first: '2018-01', last: '2026-09', count: 105 },
  on_market_statuses: ['active'],
  policy: {
    lease_rate_band: [1, 200], sale_price_band: [10000, 500000000],
    size_band_sf: [100, 5000000], min_n: 1,
  },
};

let seq = 0;
const rec = (over = {}) => ({
  listing_id: `L${++seq}`,
  address: '100 Main St', city: 'Winnipeg', status: 'Active',
  first_seen: '2026-01', last_seen: '2026-09',
  listing_type: 'Lease', space_type: 'Office',
  municipality: 'City of Winnipeg',
  cluster: 'Downtown East', neighbourhood: 'Exchange District',
  latitude: 49.9, longitude: -97.1,
  sf_min: null, sf_max: null, current_price: null, dup_group: null,
  ...over,
});

const run = (records, filters) => applyFilters(records, { ...defaultFilters(), ...filters }, MANIFEST);

// ---------- the filter ----------

test('a cluster selects every neighbourhood inside it', () => {
  const rows = [
    rec({ cluster: 'Downtown East', neighbourhood: 'Exchange District' }),
    rec({ cluster: 'Downtown East', neighbourhood: 'South Portage' }),
    rec({ cluster: 'Transcona', neighbourhood: 'Regent' }),
  ];
  const got = run(rows, { clusters: ['Downtown East'] });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((r) => r.neighbourhood).sort(), ['Exchange District', 'South Portage']);
});

test('no cluster selected means no cluster restriction', () => {
  assert.equal(run([rec(), rec({ cluster: 'Transcona' })], {}).length, 2);
});

test('a listing outside Winnipeg carries no cluster and a cluster filter excludes it', () => {
  /* Blank is not a wildcard. Picking "Downtown East" must not sweep in
     the 1,793 records that have no cluster at all. */
  const rows = [rec(), rec({ municipality: 'City of Brandon', cluster: '', neighbourhood: '' })];
  assert.equal(run(rows, { clusters: ['Downtown East'] }).length, 1);
});

test('cluster and neighbourhood intersect rather than nest', () => {
  /* They are two tiers of one hierarchy, but they are still two filters.
     A neighbourhood outside the chosen cluster correctly yields nothing,
     which is the honest answer to a contradictory question. */
  const rows = [rec({ cluster: 'Downtown East', neighbourhood: 'Exchange District' })];
  assert.equal(run(rows, { clusters: ['Downtown East'], neighbourhoods: ['Exchange District'] }).length, 1);
  assert.equal(run(rows, { clusters: ['Transcona'], neighbourhoods: ['Exchange District'] }).length, 0);
});

test('the cluster filter is part of the default state and of the chips', () => {
  assert.deepEqual(DEFAULT_FILTERS.clusters, []);
  const chips = describeFilters({ clusters: ['Downtown East', 'Transcona'] }, MANIFEST);
  assert.ok(chips.some((c) => c.label === 'Cluster: Downtown East, Transcona'),
    'an export must be able to state the cluster it was filtered to');
});

// ---------- the column ----------

test('the grid has a cluster column, between area and municipality', () => {
  const i = COLUMN_KEYS.indexOf('cluster');
  assert.ok(i > 0, 'cluster is a column');
  assert.equal(COLUMN_KEYS[i - 1], 'area');
  assert.equal(COLUMN_KEYS[i + 1], 'municipality');
});

test('the cluster cell prints the cluster and nothing else', () => {
  const col = COLUMNS.find((c) => c.key === 'cluster');
  assert.equal(col.text(rec({ cluster: 'Fort Garry North' })), 'Fort Garry North');
  assert.equal(col.text(rec({ cluster: null })), '');
  // The Area column keeps showing the neighbourhood, so the two columns
  // never print the same string on the same row.
  const area = COLUMNS.find((c) => c.key === 'area');
  const r = rec({ cluster: 'Downtown East', neighbourhood: 'Exchange District' });
  assert.notEqual(area.text(r), col.text(r));
});

test('cluster rides in the bundle the grid reads from', () => {
  assert.ok(REQUIRED_RECORD_COLUMNS.includes('cluster'),
    'the column must be parsed out of records.csv or it is always blank');
});

// ---------- the assessment roll ----------

test('the roll rides in the bundle without being required of an old one', () => {
  /* A folder published before 2026-09-22 has no roll_number column, and
     must still parse: unnamed text columns ride along, so the field is
     simply null. Adding it to REQUIRED_RECORD_COLUMNS would refuse every
     such folder outright. */
  assert.ok(!REQUIRED_RECORD_COLUMNS.includes('roll_number'));
});

test('the roll cell shows one roll, or how many share the footprint', () => {
  const col = COLUMNS.find((c) => c.key === 'roll');
  assert.equal(col.text(rec({ roll_number: '13052166000' })), '13052166000');
  assert.equal(col.text(rec({ roll_number: '450205' })), '450205');
  assert.equal(col.text(rec({ roll_number: '1;2;3' })), '3 rolls');
  assert.equal(col.text(rec({ roll_number: null })), '');
});

test('the roll sorts on the raw value, not the summary', () => {
  /* "3 rolls" would sort between 2 and 4 if the cell text were the sort
     key, which is why `get` and `text` are separate. */
  const col = COLUMNS.find((c) => c.key === 'roll');
  assert.equal(col.get(rec({ roll_number: '1;2;3' })), '1;2;3');
});

test('a roll number finds its listing through the search box', () => {
  /* The field most worth pasting: a roll from a tax bill or the
     assessor's site finds the listing even when nobody agrees on how to
     spell the address. */
  const rows = [rec({ roll_number: '13052166000' }), rec({ roll_number: '450205' })];
  assert.equal(run(rows, { text: '13052166000' }).length, 1);
  assert.equal(run(rows, { text: '450205' }).length, 1);
  assert.equal(run(rows, { text: '99999' }).length, 0);
});
