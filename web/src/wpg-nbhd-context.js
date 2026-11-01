// Single-flight loader for wpg_nbhd_context.json.
//
// Where each Winnipeg neighbourhood / cluster / community area sits: boundary
// streets (or river / rail) per side, arterials through and near, nearby
// rivers, and distance + direction from downtown — built by
// r/29_build_wpg_nbhd_context.R from City of Winnipeg open data, OpenStreetMap
// rivers/rail and the curated r/lib/wpg_arterials.csv. Consumed only by the
// Census Profile tab's community-profile narrative ("Location" for WPG_*
// subjects).
//
// Resolves to the parsed JSON ({ areas:{ uid:{ sides, through, near, rivers,
// downtown } } }) or null when the file is missing or unparseable — the
// narrative then keeps its appraiser-note stub for location.

let promise = null;

export async function loadWpgNbhdContext() {
  if (!promise) {
    promise = fetch('./data/geo/wpg_nbhd_context.json')
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
export function _resetWpgNbhdContextCache() {
  promise = null;
}
