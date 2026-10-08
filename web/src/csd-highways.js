// Single-flight loader for mb_csd_highways.json (~60KB).
//
// Provincial highways (PTH / PR) through or near each Manitoba municipality,
// plus boundary distance and direction from Winnipeg — built by
// r/27_build_csd_highways.R from the Manitoba Road Network 2023. Consumed only
// by the Census Profile tab's community-profile narrative ("Access and
// roadways" paragraph).
//
// Resolves to the parsed JSON ({ nearbyKm, csd:{ uid:{ through, nearby,
// wpgKm, wpgDir } } }) or null when the file is missing or unparseable — the
// narrative then keeps its appraiser-note stub for roadways.

let promise = null;

export async function loadCsdHighways() {
  if (!promise) {
    promise = fetch('./data/geo/mb_csd_highways.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((v) => {
        if (v == null) promise = null;   // evict on failure so a retry can work
        return v;
      });
  }
  return promise;
}

// Test hook: forget the cached download so a fresh fetch runs next call.
export function _resetCsdHighwaysCache() {
  promise = null;
}
