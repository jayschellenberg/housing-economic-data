#!/usr/bin/env node
// Build web/public/data/starts_summary.json — a small per-CMA index of each
// survey zone's / neighbourhood's headline housing-starts metrics, so the Starts
// choropleth can shade an area without loading every zone's full shard. The
// starts counterpart of build-rental-summary.mjs.
//
// It derives purely from the already-built starts shards (zone_* and
// neighbourhood_*), so it stays consistent with the committed data and needs no
// scrape. The refresh workflow runs it right after r/03 rebuilds the shards.
//
// For each geo and metric it keeps the newest year's headline value — the
// all-dwelling-types "All" figure at annual frequency, which is the area's
// aggregate count the charts show.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTS_DIR = join(HERE, '..', 'public', 'data', 'starts');
const OUT_PATH = join(HERE, '..', 'public', 'data', 'starts_summary.json');

// The Scss series the map can shade by.
const METRICS = ['Starts', 'Completions', 'Under Construction', 'Unabsorbed Inventory', 'Absorbed Units'];

// Newest headline value for one metric: the aggregate "All" dwelling-type figure
// at annual frequency. Prefer the Dwelling-Type dimension (every series carries
// "All" there); fall back to any dimension's All at annual frequency.
function headline(records, series) {
  const cands = records.filter((r) =>
    r.series === series &&
    r.category === 'All' &&
    (r.frequency == null || r.frequency === 'Annual'));
  if (!cands.length) return null;
  const byType = cands.filter((r) => r.dimension === 'Dwelling Type');
  const pool = byType.length ? byType : cands;
  let best = null;
  for (const r of pool) {
    const v = Number(r.value);
    if (r.value == null || !Number.isFinite(v)) continue;
    if (!best || r.year > best.y) best = { v, y: r.year };
  }
  return best;
}

function build() {
  const files = readdirSync(STARTS_DIR)
    .filter((f) => (f.startsWith('zone_') || f.startsWith('neighbourhood_')) && f.endsWith('.json'));

  const geos = {};
  let withData = 0;
  for (const file of files) {
    let shard;
    try {
      shard = JSON.parse(readFileSync(join(STARTS_DIR, file), 'utf8'));
    } catch (err) {
      console.warn(`[starts-summary] skipping ${file}: ${err.message}`);
      continue;
    }
    const recs = shard.records || [];
    const values = {};
    for (const m of METRICS) {
      const h = headline(recs, m);
      if (h) values[m] = h;
    }
    if (!Object.keys(values).length) continue;
    geos[String(shard.geoUid)] = {
      name: shard.geoName,
      level: shard.geoLevel,
      cma: shard.parentUid != null ? String(shard.parentUid) : null,
      cmaName: shard.parentName ?? null,
      values,
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
  console.log(`[starts-summary] wrote ${withData} areas from ${files.length} shards → ${OUT_PATH}`);
}

build();
