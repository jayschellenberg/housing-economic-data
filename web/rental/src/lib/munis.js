/*
 * munis.js — municipality index helpers (pure).
 *
 * The site's municipality picker uses the SAME groupings the Manitoba
 * Parcel Search's Sales Analysis uses: `web/public/data/muni-index.json`,
 * built by scripts/build_web_overlays.py from the province's boundary file
 * joined to the mao-scrape muni_regions.csv (muni_no, list_name — the
 * "ALTONA (TOWN)" form that sorts by place — region, and the list of
 * municipalities sharing a boundary).
 *
 * Listings carry geo_municipality = MUNI_NAME ("TOWN OF ALTONA"), and the
 * filter state keeps using those names, so everything here maps name ⇄
 * muni_no and never changes the export contract.
 */

import { UNASSIGNED } from './filters.js';

export const UNGROUPED = 'Other';

/**
 * @typedef {{muni_no:string, name:string, list_name:string, region:string, adjacent:string[]}} MuniEntry
 */

/** Index a muni-index.json payload by muni_no and by MUNI_NAME. */
export function buildMuniIndex(raw) {
  const byNo = new Map(), byName = new Map();
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || m.muni_no == null || !m.name) continue;
    const e = {
      muni_no: String(m.muni_no),
      name: String(m.name),
      list_name: m.list_name ? String(m.list_name) : String(m.name),
      region: m.region ? String(m.region) : UNGROUPED,
      adjacent: Array.isArray(m.adjacent) ? m.adjacent.map(String) : [],
    };
    byNo.set(e.muni_no, e);
    byName.set(e.name, e);
  }
  return { byNo, byName };
}

/**
 * Neighbours of a set of municipality NAMES (one hop, names again),
 * restricted to `available` names when given — offering a neighbour the
 * bundle holds no listings for would just be a dead tick.
 */
export function neighboursOf(names, index, available = null) {
  const out = new Set();
  for (const n of names) {
    const e = index?.byName.get(n);
    if (!e) continue;
    for (const no of e.adjacent) {
      const nb = index.byNo.get(no);
      if (!nb || names.includes(nb.name)) continue;
      if (available && !available.has(nb.name)) continue;
      out.add(nb.name);
    }
  }
  return out;
}

/**
 * The municipalities a filter actually covers: the explicit picks, plus
 * (when adjacency is on) every neighbour not explicitly waived off.
 * Returns [] (= no municipality narrowing) when nothing is picked.
 */
export function effectiveMunis({ munis = [], adjacent = false, muniExcluded = [] } = {}, index = null, available = null) {
  if (!munis.length) return [];
  if (!adjacent || !index) return munis.slice();
  const excluded = new Set(muniExcluded);
  const out = new Set(munis);
  for (const nb of neighboursOf(munis, index, available)) if (!excluded.has(nb)) out.add(nb);
  return [...out];
}

/**
 * Picker rows grouped by region from a tally of listings per muniKey.
 * @param {Array<{value:string,count:number}>} tally  value = MUNI_NAME or UNASSIGNED
 * @returns {Array<{region:string, rows:Array<{name,label,count,muni_no}>}>}
 *   regions alphabetical with 'Other' last; rows alphabetical by label
 */
export function groupByRegion(tally, index) {
  const byRegion = new Map();
  for (const t of tally || []) {
    const e = t.value === UNASSIGNED ? null : index?.byName.get(t.value);
    const region = e?.region || UNGROUPED;
    const label = t.value === UNASSIGNED ? '(unassigned — outside every polygon)' : (e?.list_name || t.value);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push({ name: t.value, label, count: t.count, muni_no: e?.muni_no || null });
  }
  const order = [...byRegion.keys()].sort((a, b) => (a === UNGROUPED) - (b === UNGROUPED) || a.localeCompare(b));
  return order.map((region) => ({
    region,
    rows: byRegion.get(region).sort((a, b) => (a.name === UNASSIGNED) - (b.name === UNASSIGNED) || a.label.localeCompare(b.label)),
  }));
}
