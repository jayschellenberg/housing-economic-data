// Single-flight loader for starts_summary.json — a small (~100 KB) per-area
// index of each survey zone's / neighbourhood's headline housing-starts metrics,
// built by web/scripts/build-starts-summary.mjs from the starts shards. The
// Starts choropleth shades an area from this instead of loading every zone's
// full shard. Callers only read it, so a shared parsed object is fine.
let promise = null;

// Resolve to the parsed summary, or null if it can't be loaded. Shape:
//   { version, generated, metrics: [...],
//     geos: { "<geoUid>": { name, level, cma, cmaName, values: { "<metric>": { v, y } } } } }
export function loadStartsSummary() {
  if (!promise) {
    promise = fetch('./data/starts_summary.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return promise;
}
