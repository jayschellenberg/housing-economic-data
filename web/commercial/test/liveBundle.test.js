/*
 * Parse the REAL published bundle when this machine has it. Self-skips
 * everywhere else (CI, Vercel, a colleague's clone), so it gates local
 * work without blocking a deploy.
 *
 * This is the test that catches a producer/consumer drift that unit
 * fixtures cannot: a column renamed in export_web.py, a manifest key
 * dropped, a CSV that stopped matching its own row count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { FILES, parseBundle, restrictedColumns, dataCycle } from '../src/lib/bundle.js';
import { currentRecords, bySpaceType } from '../src/lib/summary.js';

const PUBLISHED = process.env.COMMAVAIL_PUBLISHED_DIR
  || 'D:\\Dropbox\\RRG Shared\\Apps\\CommercialAvailability';
const EXPORT = path.join(PUBLISHED, 'export');
const present = ['manifest', 'records', 'runs']
  .every((k) => existsSync(path.join(EXPORT, FILES[k])));

test('the live bundle parses and agrees with its own manifest',
  { skip: present ? false : `no bundle at ${EXPORT}` }, () => {
    const read = (k) => readFileSync(path.join(EXPORT, FILES[k]), 'utf8');
    const bundle = parseBundle({ manifest: read('manifest'), records: read('records'), runs: read('runs') });

    const { manifest, records, runs } = bundle;
    assert.ok(records.length > 0, 'the bundle has records');
    assert.equal(records.length, manifest.counts.records);
    assert.equal(runs.length, manifest.counts.runs);

    // Every record carries the identity the rest of the app keys on.
    assert.ok(records.every((r) => r.listing_id), 'every record has a listing_id');

    // Geocoding is the map's raw material; the manifest's count must be
    // the truth, not an aspiration.
    const geocoded = records.filter((r) => r.latitude != null && r.longitude != null);
    assert.equal(geocoded.length, manifest.counts.with_coords);
    assert.ok(geocoded.every((r) => r.latitude > 41 && r.latitude < 84
      && r.longitude > -142 && r.longitude < -52), 'coordinates are in Canada');

    // Some tracked listings really are outside Manitoba — a few
    // brokerages also list in Saskatchewan and Ontario — and
    // pass3_geocode flags them rather than discarding them. So the rule
    // is not "everything is in Manitoba", it is "anything outside
    // Manitoba says so", which is what the map needs to know before it
    // fits its viewport to the extremes.
    const outside = geocoded.filter((r) => r.latitude < 48.9 || r.latitude > 60.1
      || r.longitude < -102.1 || r.longitude > -88.9);
    assert.ok(outside.every((r) => r.geo_confidence === 'wrong_province' || r.geo_confidence === 'manual'),
      `unflagged out-of-province coordinates: ${outside.filter((r) => r.geo_confidence !== 'wrong_province' && r.geo_confidence !== 'manual').map((r) => r.listing_id).slice(0, 3).join('; ')}`);

    // Runs are closed spans in cycle order, and price runs are numeric.
    for (const run of runs) {
      assert.ok(run.from <= run.to, `${run.listing_id}: ${run.from} > ${run.to}`);
      if (run.kind === 'price') assert.equal(typeof run.value, 'number');
    }
    const kinds = new Set(runs.map((r) => r.kind));
    assert.deepEqual([...kinds].sort(), ['price', 'status']);

    // The current market is a subset, and it is not empty.
    const current = currentRecords(records, manifest);
    assert.ok(current.length > 0 && current.length < records.length);
    assert.equal(dataCycle(manifest), manifest.cycles.last);

    // The licensed columns are declared, and they are really in the CSV.
    const restricted = [...restrictedColumns(manifest)];
    assert.ok(restricted.length > 0, 'the bundle declares its licensed columns');
    assert.ok(restricted.every((c) => c in records[0]),
      'every declared restricted column is present on a record');

    // The overview has something to show for every space type present.
    const rows = bySpaceType(records, manifest);
    assert.ok(rows.length > 0);
    assert.equal(rows.reduce((n, r) => n + r.total, 0),
      current.filter((r) => r.listing_type === 'Lease' || r.listing_type === 'Sale').length);
  });
