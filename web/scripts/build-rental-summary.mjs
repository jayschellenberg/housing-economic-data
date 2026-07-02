#!/usr/bin/env node
// Build web/public/data/rental_summary.json — a small per-CMA index of each
// survey zone's / neighbourhood's headline rental metrics, so the choropleth
// maps can shade an area without loading every zone's full shard.
//
// It derives purely from the already-built series shards (zone_* and
// neighbourhood_*), so it stays consistent with the committed data and needs no
// scrape. The refresh workflow runs it right after r/03 rebuilds the shards; it
// can also be run by hand at any time.
//
// For each geo and each metric it keeps the newest year's headline value — the
// "Total" bedroom-type figure for all dwelling types in the October survey,
// which is exactly what the charts show as the area's aggregate.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERIES_DIR = join(HERE, '..', 'public', 'data', 'series');
const OUT_PATH = join(HERE, '..', 'public', 'data', 'rental_summary.json');

// The metrics the maps can shade by (same set the charts plot).
const METRICS = ['Median Rent', 'Average Rent', 'Vacancy Rate', 'Average Rent Change', 'Rental Universe'];

// Newest headline value for one metric in a shard's records: the aggregate
// "Total" figure (all dwelling types, October survey). Prefer the Bedroom-Type
// dimension — every series carries "Total" there — but fall back to any
// dimension's Total, since the aggregate value is the same across dimensions.
function headline(records, series) {
  const cands = records.filter((r) =>
    r.series === series &&
    r.category === 'Total' &&
    r.dwellingType === 'All' &&
    (r.season == null || r.season === 'October'));
  if (!cands.length) return null;
  const byBedroom = cands.filter((r) => r.dimension === 'Bedroom Type');
  const pool = byBedroom.length ? byBedroom : cands;
  let best = null;
  for (const r of pool) {
    const v = Number(r.value);
    if (r.value == null || !Number.isFinite(v)) continue;
    if (!best || r.year > best.y) best = { v, y: r.year };
  }
  return best;
}

function build() {
  const files = readdirSync(SERIES_DIR)
    .filter((f) => (f.startsWith('zone_') || f.startsWith('neighbourhood_')) && f.endsWith('.json'));

  const geos = {};
  let withData = 0;
  for (const file of files) {
    let shard;
    try {
      shard = JSON.parse(readFileSync(join(SERIES_DIR, file), 'utf8'));
    } catch (err) {
      console.warn(`[rental-summary] skipping ${file}: ${err.message}`);
      continue;
    }
    const recs = shard.records || [];
    const values = {};
    for (const m of METRICS) {
      const h = headline(recs, m);
      if (h) values[m] = h;
    }
    if (!Object.keys(values).length) continue;   // no headline data — skip
    geos[String(shard.geoUid)] = {
      name: shard.geoName,
      level: shard.geoLevel,          // "zone" | "neighbourhood"
      cma: shard.parentUid ?? null,   // CMA code the area belongs to
      cmaName: shard.parentName ?? null,
      values,                         // { "<metric>": { v, y } }
    };
    withData++;
  }

  const payload = {
    version: 1,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    metrics: METRICS,
    geos,
  };
  writeFileSync(OUT_PATH, JSON.stringify(payload), 'utf8');
  console.log(`[rental-summary] wrote ${withData} areas from ${files.length} shards → ${OUT_PATH}`);
}

build();
