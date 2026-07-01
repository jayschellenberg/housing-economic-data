/*
 * Province boundary loader for the map views. Fetches the per-province GeoJSON
 * (mb/sk/ab/bc × csd/cd) on demand and caches it, so a tab only downloads the
 * geometry for the province the user is actually looking at. Files are built by
 * r/20_build_boundaries.R from StatCan 2021 cartographic boundary files; feature
 * ids are the real CSDUID / CDUID codes that join directly to the census data.
 */

const SLUG = { '46': 'mb', '47': 'sk', '48': 'ab', '59': 'bc' };
const cache = new Map();   // `${slug}_${level}` -> Promise<FeatureCollection|null>

/** True if a boundary file exists for this province (SGC code). */
export function hasProvinceGeo(prov) {
  return Object.prototype.hasOwnProperty.call(SLUG, String(prov));
}

/** Fetch (and cache) the boundary FeatureCollection for a province + level. */
export function provinceGeo(prov, level = 'csd') {
  const slug = SLUG[String(prov)];
  if (!slug) return Promise.resolve(null);
  const key = `${slug}_${level}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`./data/geo/${key}.geojson`)
      .then(r => r.ok ? r.json() : null).catch(() => null));
  }
  return cache.get(key);
}
