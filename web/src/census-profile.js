// Single-flight loader for census_profile.json (~5MB).
//
// Three tabs need this file — Census Profile, Housing Stock, and Affordability.
// Before lazy tab init they each fetched it at page load, so first paint pulled
// the 5MB three times concurrently. This caches the fetched TEXT so the download
// happens once, while every caller still JSON.parses its own fresh object.
//
// Why parse-per-caller and not a shared parsed object: census.js rewrites region
// names in place (r.name = cleanName(...)). Handing every caller the same object
// would let that mutation leak into the Housing/Affordability views depending on
// which tab was opened first. A fresh parse per caller keeps them isolated at the
// cost of re-parsing — cheap next to the download, and only when a tab is opened.

let textPromise = null;

// Resolve to the parsed census_profile.json, or null if it can't be loaded.
// Callers already handle null (they render a "data not found" message).
export async function loadCensusProfile() {
  if (!textPromise) {
    textPromise = fetch('./data/housing/census_profile.json')
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
  }
  const text = await textPromise;
  if (text == null) {
    textPromise = null;   // evict on failure so a later tab activation can retry
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Test hook: forget the cached download so a fresh fetch runs next call.
export function _resetCensusProfileCache() {
  textPromise = null;
}
