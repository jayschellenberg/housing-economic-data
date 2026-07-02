// Single-flight loader for rental_summary.json — a small (~100 KB) per-area
// index of each survey zone's / neighbourhood's headline rental metrics, built
// by web/scripts/build-rental-summary.mjs from the series shards. The rental
// choropleth maps shade an area from this instead of loading every zone's full
// shard. Callers only read it, so a shared parsed object is fine.
let promise = null;

// Resolve to the parsed summary, or null if it can't be loaded. Shape:
//   { version, generated, metrics: [...],
//     geos: { "<geoUid>": { name, level, cma, cmaName, values: { "<metric>": { v, y } } } } }
export function loadRentalSummary() {
  if (!promise) {
    promise = fetch('./data/rental_summary.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return promise;
}
