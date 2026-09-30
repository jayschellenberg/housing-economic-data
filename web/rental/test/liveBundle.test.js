// Parses the REAL export folder when it is on this machine (Jason's
// Dropbox, or RENTAL_EXPORT_DIR). Skips cleanly anywhere else (CI,
// colleagues without the folder). This is the one test that proves the
// Python producer and the JS consumer agree on the live shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FILES, parseBundle } from '../src/lib/bundle.js';

const DIR = process.env.RENTAL_EXPORT_DIR
  || 'D:\\Dropbox\\RRG Shared\\Apps\\RentalDashboard\\export';

const present = existsSync(path.join(DIR, FILES.manifest));

test('live export bundle parses and matches its manifest', { skip: !present && 'export folder not present' }, () => {
  const read = (n) => readFileSync(path.join(DIR, n), 'utf8');
  const t0 = Date.now();
  const b = parseBundle({ manifest: read(FILES.manifest), listings: read(FILES.listings), segments: read(FILES.segments) });
  const ms = Date.now() - t0;
  assert.equal(b.listings.length, b.manifest.counts.listings);
  assert.equal(b.segments.length, b.manifest.counts.segments);
  // Every listing has an id and a source; every segment points at a listing.
  const ids = new Set(b.listings.map((l) => l.id));
  assert.equal(ids.size, b.listings.length, 'listing ids unique');
  assert.ok(b.listings.every((l) => l.source));
  assert.ok(b.segments.every((s) => ids.has(s.listing_id)), 'segments reference exported listings');
  // Typed, not stringly.
  const withRent = b.listings.filter((l) => l.rent != null);
  assert.ok(withRent.length > b.listings.length * 0.5);
  assert.ok(withRent.every((l) => Number.isInteger(l.rent)));
  assert.ok(b.listings.some((l) => l.dedup_canonical === true));
  console.log(`  parsed ${b.listings.length} listings + ${b.segments.length} segments in ${ms} ms`);
});
