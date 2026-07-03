#!/usr/bin/env node
// Build web/public/data/schema.json — a fingerprint of the category SET per
// (series, dimension) for the rental and starts data. The refresh sanity gate
// (r/98_sanity_check.R) diffs this against the previously-committed version and
// aborts if a category disappears — catching the failure mode where CMHC renames
// a category (e.g. "Total" → "All") without changing record counts, which slips
// past the count-based checks but breaks the frontend's exact-string filters.
//
// Category sets are geography-invariant, so reading the province shards (which
// carry the full breakdown) is enough and fast. Runs after r/03 rebuilds the
// shards; also runnable by hand.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'public', 'data');
const OUT_PATH = join(DATA, 'schema.json');

// Union the category sets across the province shards of one data tree.
function fingerprint(dir) {
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter((f) => f.startsWith('province_') && f.endsWith('.json'));
  const sets = {};   // series -> dimension -> Set(category)
  for (const f of files) {
    let shard;
    try {
      shard = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      console.warn(`[schema] skipping ${f}: ${err.message}`);
      continue;
    }
    for (const r of shard.records || []) {
      if (!r.series || !r.dimension || r.category == null) continue;
      (sets[r.series] ??= {});
      (sets[r.series][r.dimension] ??= new Set()).add(String(r.category));
    }
  }
  // Sort series, dimensions and categories so the JSON is stable (clean diffs).
  const out = {};
  for (const s of Object.keys(sets).sort()) {
    out[s] = {};
    for (const d of Object.keys(sets[s]).sort()) out[s][d] = [...sets[s][d]].sort();
  }
  return out;
}

const payload = {
  version: 1,
  generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  rental: fingerprint(join(DATA, 'series')),
  starts: fingerprint(join(DATA, 'starts')),
};
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const count = (o) => Object.values(o).reduce((n, dims) => n + Object.keys(dims).length, 0);
console.log(`[schema] wrote ${OUT_PATH} — rental: ${count(payload.rental)} (series,dim) pairs; starts: ${count(payload.starts)}`);
