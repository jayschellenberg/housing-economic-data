// Compact Manitoba census summary for other sites to read.
//
// The two parcel-search sites build a one-page preliminary property report
// and want a handful of census figures for the subject's municipality (or,
// in Winnipeg, its neighbourhood) without pulling the 5 MB
// census_profile.json. This pure function cuts that file down to Manitoba
// geographies and headline fields; the census-summary Vite plugin
// (vite.config.js) emits the result as /data/housing/census-summary.json at
// build, so it is always derived from the same census_profile.json the
// Census Profile tab shows. vercel.json opens it to other origins.

const LEVELS = new Set(['PR', 'CMA', 'CSD', 'WPG_CA', 'WPG_Cluster', 'WPG_Nbhd']);

// census_profile.json writes a suppressed or unavailable cell as {}.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (part, whole) => (num(part) != null && num(whole) ? Math.round((1000 * part) / whole) / 10 : null);

function keepRegion(r) {
  if (!LEVELS.has(r.level)) return false;
  if (r.level === 'PR') return r.uid === '46';
  if (r.level === 'CMA') return r.uid === '46602';          // Winnipeg CMA, the usual comparison
  if (r.level === 'CSD') return String(r.uid).startsWith('46');
  return true;                                              // Winnipeg community areas, clusters, neighbourhoods
}

export function summarizeRegion(r, censusYears) {
  const years = censusYears.filter((y) => r.trends?.[y]);
  const latest = years.at(-1);
  const prior = years.at(-2);
  const popNow = num(r.trends?.[latest]?.population);
  const popPrior = num(r.trends?.[prior]?.population);
  const demoYear = Object.keys(r.demo || {}).sort().at(-1) ?? null;
  const d = (demoYear && r.demo[demoYear]) || {};
  const t = r.trends?.[latest] || {};
  return {
    uid: r.uid,
    name: r.name,
    level: r.level,
    year: latest ?? null,
    population: popNow,
    population_prior: popPrior,
    prior_year: prior ?? null,
    population_change_pct: popNow != null && popPrior ? Math.round((1000 * (popNow - popPrior)) / popPrior) / 10 : null,
    households: num(t.households),
    dwellings: num(t.dwellings),
    single_detached_pct: pct(t.single_detached, t.dwellings),
    demo_year: demoYear,
    median_age: num(d.median_age),
    avg_household_size: num(d.avg_hh_size),
    age_65_plus_pct: pct(d.age_65_plus, d.population),
    owner_pct: pct(d.owner, d.tenure_total),
    renter_pct: pct(d.renter, d.tenure_total),
    median_household_income: num(d.median_hh_income),
    median_dwelling_value: num(d.median_dwelling_val),
    median_rent: num(d.median_rent),
    built_since_2016_pct: pct(d.built_2016_2021, d.period_total),
  };
}

export function buildCensusSummary(profile, builtAt = new Date().toISOString()) {
  const regions = profile.regions.filter(keepRegion).map((r) => summarizeRegion(r, profile.censusYears));
  return {
    schema: 1,
    built_at: builtAt,
    source: profile.source,
    source_url: profile.sourceUrl,
    licence: 'Statistics Canada Open Licence; Winnipeg neighbourhood history from City of Winnipeg census profiles. Credit "Statistics Canada, Census of Population".',
    note: 'Manitoba census subdivisions (uid = StatCan CSD code, e.g. 4602044 Steinbach), Manitoba (46), Winnipeg CMA (46602) and Winnipeg community areas, clusters and neighbourhoods (uid "WPG_CA:<name>", "WPG_Cluster:<name>", "WPG_NB:<name>"). Percentages are of the census universe for that field. null = suppressed or not available.',
    regions,
  };
}
