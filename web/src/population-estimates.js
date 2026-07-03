// Single-flight loader for population_estimates.json (~650KB).
//
// Annual (July 1) StatsCan population estimates, keyed by the same uid space
// census_profile.json uses (2-digit province SGC / 7-digit CSDUID) — built by
// r/23_scrape_population_estimates.R. Only the Census Profile tab consumes it,
// but the single-flight cache keeps re-activations from re-downloading.
//
// Resolves to the parsed JSON ({ source, sourceUrl, note, asOf, series }) or
// null when the file is missing or unparseable — the caller simply skips the
// annual-estimates chart in that case.

let promise = null;

export async function loadPopulationEstimates() {
  if (!promise) {
    promise = fetch('./data/housing/population_estimates.json')
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
export function _resetPopulationEstimatesCache() {
  promise = null;
}
