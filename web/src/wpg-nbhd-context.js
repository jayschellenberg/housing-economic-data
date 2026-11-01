// Single-flight loader for wpg_nbhd_context.json (+ wpg_nbhd_landuse.json).
//
// Where each Winnipeg neighbourhood / cluster / community area sits: boundary
// streets (or river / rail) per side, arterials through and near, nearby
// rivers, and distance + direction from downtown — built by
// r/29_build_wpg_nbhd_context.R from City of Winnipeg open data, OpenStreetMap
// rivers/rail and the curated r/lib/wpg_arterials.csv. Land use from current
// zoning (category shares + commercial corridors) comes from
// r/30_build_wpg_nbhd_landuse.R and is merged in as `landuse` per area.
// Consumed only by the Census Profile tab's community-profile narrative
// (WPG_* subjects).
//
// Resolves to the parsed JSON ({ areas:{ uid:{ sides, through, near, rivers,
// downtown, landuse? } } }) or null when the context file is missing or
// unparseable — the narrative then keeps its appraiser-note stubs. A missing
// land-use file just leaves `landuse` off.

let promise = null;

const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

export async function loadWpgNbhdContext() {
  if (!promise) {
    promise = Promise.all([getJson('./data/geo/wpg_nbhd_context.json'), getJson('./data/geo/wpg_nbhd_landuse.json')])
      .then(([ctx, lu]) => {
        if (ctx?.areas && lu?.areas) {
          for (const [uid, v] of Object.entries(lu.areas)) if (ctx.areas[uid]) ctx.areas[uid].landuse = v;
        }
        return ctx ?? null;
      })
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
