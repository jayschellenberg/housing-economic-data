// Single-flight loader for census_industry.json (~115KB).
//
// Labour force (15+) by NAICS sector from the 2021 and 2016 Censuses, keyed by
// the same uid space census_profile.json uses — built by
// r/26_census_industry.R. Consumed only by the Census Profile tab's
// community-profile narrative (economic-base paragraph + industry table).
//
// Resolves to the parsed JSON ({ years, sectors:[{code,label}], regions:[{uid,
// name, level, data:{year:{labourForce, notApplicable, counts}}}] }) or null
// when the file is missing or unparseable — the narrative then simply omits
// the industry paragraph.

let promise = null;

export async function loadCensusIndustry() {
  if (!promise) {
    promise = fetch('./data/housing/census_industry.json')
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
export function _resetCensusIndustryCache() {
  promise = null;
}
