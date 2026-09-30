/*
 * analysis.js — the numbers behind the Analysis tab. Pure; node-tested.
 *
 * Every median follows the shared policy: rents inside the display band
 * only, suppressed (null) below min_n_for_median. Means follow the same
 * rule so a tile never shows a mean where the median is withheld.
 *
 * Trends come from rent_segments.csv: each row is a run of weeks a
 * listing sat at one rent. A listing counts in a period when any of its
 * runs overlaps it, at the rent of the latest run that does. Rent per
 * square foot needs the listing's sqft, so trends join segments to
 * listings by id.
 */

import { bedroomBand, rentPerSqft, usableSqft, BEDROOM_BANDS } from './filters.js';
import { BAND_ORDER } from './bands.js';

const DAY_MS = 86400000;

// ---- small stats ---------------------------------------------------------------

export function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** n, median, mean, p25, p75 — medians/means null below minN. */
export function summarize(values, minN = 5) {
  const v = values.filter((x) => Number.isFinite(x));
  const s = v.slice().sort((a, b) => a - b);
  const ok = v.length >= minN;
  return {
    n: v.length,
    median: ok ? median(v) : null,
    mean: ok ? mean(v) : null,
    p25: ok ? quantile(s, 0.25) : null,
    p75: ok ? quantile(s, 0.75) : null,
    min: v.length ? s[0] : null,
    max: v.length ? s[s.length - 1] : null,
  };
}

function policyBits(policy = {}) {
  return {
    lo: policy.display_rent_min ?? 500,
    hi: policy.display_rent_max ?? 5000,
    minN: policy.min_n_for_median ?? 5,
    bands: policy.bedroom_bands || BEDROOM_BANDS,
  };
}

/** Band key for a listing, 'unknown' when unbandable. */
export function bandOf(l, bands) {
  return bedroomBand(l.bedrooms, bands) || 'unknown';
}

const inBand = (l, lo, hi) => l.rent != null && l.rent >= lo && l.rent <= hi;

// ---- band statistics ------------------------------------------------------------

/**
 * Per-band and overall rent / $ per sf statistics for a set of rows.
 * @returns {{ all: Stats, bands: Record<string, Stats>, nRows: number }}
 *   Stats = { rent: summarize(), psf: summarize(), n }
 */
export function bandStats(rows, policy = {}) {
  const { lo, hi, minN, bands } = policyBits(policy);
  const buckets = new Map([...BAND_ORDER, 'unknown'].map((k) => [k, { rent: [], psf: [] }]));
  const all = { rent: [], psf: [] };
  for (const l of rows) {
    if (!inBand(l, lo, hi)) continue;
    const b = buckets.get(bandOf(l, bands));
    const psf = rentPerSqft(l);
    all.rent.push(l.rent); b.rent.push(l.rent);
    if (psf != null) { all.psf.push(psf); b.psf.push(psf); }
  }
  const pack = (x) => ({ n: x.rent.length, rent: summarize(x.rent, minN), psf: summarize(x.psf, minN) });
  const out = { nRows: rows.length, all: pack(all), bands: {} };
  for (const [k, x] of buckets) out.bands[k] = pack(x);
  return out;
}

// ---- by market -------------------------------------------------------------------

export const MARKET_KEYS = Object.freeze({
  muni: { label: 'Municipality', get: (l) => l.geo_municipality || '(unassigned)' },
  mls: { label: 'MLS area', get: (l) => l.geo_mls_area || '(none)' },
  nbhd: { label: 'Wpg neighbourhood', get: (l) => l.geo_neighborhood || '(none)' },
  city: { label: 'City (as listed)', get: (l) => l.city || '(none)' },
});

/**
 * One row per market with overall + per-band statistics, largest markets
 * first. `limit` caps the rows (the long tail of one-listing towns adds
 * nothing to a table).
 */
export function marketTable(rows, by = 'muni', policy = {}, { limit = 40 } = {}) {
  const key = MARKET_KEYS[by] || MARKET_KEYS.muni;
  const groups = new Map();
  for (const l of rows) {
    const k = key.get(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const out = [...groups.entries()].map(([market, list]) => {
    const s = bandStats(list, policy);
    return { market, n: list.length, all: s.all, bands: s.bands };
  });
  // Named markets by size; the catch-all "(none)" / "(unassigned)" bucket
  // last, however large — it is not a market.
  const catchAll = (m) => (m.startsWith('(') ? 1 : 0);
  out.sort((a, b) => catchAll(a.market) - catchAll(b.market) || b.n - a.n || a.market.localeCompare(b.market));
  return out.slice(0, limit);
}

// ---- periods ------------------------------------------------------------------------

/** 'YYYY-MM' for month, or the Monday 'YYYY-MM-DD' for week. */
export function periodKey(iso, gran = 'month') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  if (gran === 'month') return `${m[1]}-${m[2]}`;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dow = (d.getUTCDay() + 6) % 7;      // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Every period key from `from` to `to` inclusive. */
export function periodsBetween(from, to, gran = 'month') {
  const a = periodKey(from, gran), b = periodKey(to, gran);
  if (!a || !b || a > b) return a ? [a] : [];
  const out = [];
  if (gran === 'month') {
    let [y, mo] = a.split('-').map(Number);
    const [y2, mo2] = b.split('-').map(Number);
    while (y < y2 || (y === y2 && mo <= mo2)) {
      out.push(`${y}-${String(mo).padStart(2, '0')}`);
      mo++; if (mo > 12) { mo = 1; y++; }
    }
  } else {
    const d = new Date(a + 'T00:00:00Z');
    const end = new Date(b + 'T00:00:00Z');
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); }
  }
  return out;
}

/** Date object at the start of a period key (for time axes). */
export function periodDate(key) {
  return new Date((key.length === 7 ? key + '-01' : key) + 'T00:00:00Z');
}

// ---- trends -------------------------------------------------------------------------

/**
 * Median rent, median $/sf and active inventory per period and band.
 * @param {Array} listings   typed listing records (all of them — the id join)
 * @param {Array} segments   rent runs
 * @param {Object} opts      { ids: Set<number>|null (scope), policy, gran }
 * @returns {{ rent: Row[], psf: Row[], inventory: Row[], periods: string[] }}
 *   Row = { period, date, band, median, n } (inventory rows: { period, date, band, n })
 */
export function trendSeries(listings, segments, { ids = null, policy = {}, gran = 'month' } = {}) {
  const { lo, hi, minN, bands } = policyBits(policy);
  const byId = new Map(listings.map((l) => [l.id, l]));
  // period -> listing_id -> { rent, band, psf } ; later segments overwrite
  const cells = new Map();
  for (const s of segments) {
    if (ids && !ids.has(s.listing_id)) continue;
    const l = byId.get(s.listing_id);
    if (!l) continue;
    const band = bandOf(l, bands);
    const rent = s.rent;
    const sq = usableSqft(l.sqft);
    const psf = rent != null && rent > 0 && sq != null ? rent / sq : null;
    for (const p of periodsBetween(s.from, s.to, gran)) {
      if (!cells.has(p)) cells.set(p, new Map());
      cells.get(p).set(s.listing_id, { rent, band, psf });
    }
  }
  const periods = [...cells.keys()].sort();
  const rentRows = [], psfRows = [], invRows = [];
  for (const p of periods) {
    const date = periodDate(p);
    const perBand = new Map([...BAND_ORDER, 'all'].map((k) => [k, { rent: [], psf: [], n: 0 }]));
    for (const { rent, band, psf } of cells.get(p).values()) {
      const targets = [perBand.get('all'), perBand.get(band)].filter(Boolean);
      for (const t of targets) {
        t.n++;
        if (rent != null && rent >= lo && rent <= hi) { t.rent.push(rent); if (psf != null) t.psf.push(psf); }
      }
    }
    for (const [band, t] of perBand) {
      invRows.push({ period: p, date, band, n: t.n });
      rentRows.push({ period: p, date, band, n: t.rent.length, median: t.rent.length >= minN ? median(t.rent) : null, mean: t.rent.length >= minN ? mean(t.rent) : null });
      psfRows.push({ period: p, date, band, n: t.psf.length, median: t.psf.length >= minN ? median(t.psf) : null, mean: t.psf.length >= minN ? mean(t.psf) : null });
    }
  }
  return { rent: rentRows, psf: psfRows, inventory: invRows, periods };
}

// ---- distribution ---------------------------------------------------------------------

/** Rent histogram rows { bin, band, n } over the display band, bin width `step`. */
export function histogram(rows, policy = {}, step = 100) {
  const { lo, hi, bands } = policyBits(policy);
  const counts = new Map();
  for (const l of rows) {
    if (!inBand(l, lo, hi)) continue;
    const bin = Math.floor(l.rent / step) * step;
    const k = `${bin}|${bandOf(l, bands)}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => { const [bin, band] = k.split('|'); return { bin: Number(bin), band, n }; })
    .sort((a, b) => a.bin - b.bin || BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
}

/** Points for rent vs size: { sqft, rent, band, id } (usable sqft + display-band rent). */
export function sizePoints(rows, policy = {}) {
  const { lo, hi, bands } = policyBits(policy);
  return rows.filter((l) => usableSqft(l.sqft) != null && inBand(l, lo, hi))
    .map((l) => ({ id: l.id, sqft: l.sqft, rent: l.rent, band: bandOf(l, bands), address: l.address || l.title || '' }));
}

// ---- other statistics -------------------------------------------------------------------

function daysBetween(a, b) {
  const da = Date.parse(String(a) + 'T00:00:00Z'), db = Date.parse(String(b) + 'T00:00:00Z');
  return Number.isFinite(da) && Number.isFinite(db) ? Math.round((db - da) / DAY_MS) : null;
}
const share = (n, d) => (d ? n / d : null);

/**
 * Per-band: median days observed, share with a rent change, median % change
 * (first run → last run), amenity shares; plus the source mix.
 */
export function otherStats(rows, segments, policy = {}) {
  const { minN, bands } = policyBits(policy);
  const ids = new Set(rows.map((l) => l.id));
  const runs = new Map();          // listing_id -> [{rent, from}]
  for (const s of segments) {
    if (!ids.has(s.listing_id)) continue;
    if (!runs.has(s.listing_id)) runs.set(s.listing_id, []);
    runs.get(s.listing_id).push(s);
  }
  const perBand = new Map([...BAND_ORDER, 'all'].map((k) => [k, { n: 0, days: [], changed: 0, pct: [], parking: 0, parkingKnown: 0, elevator: 0, elevatorKnown: 0, heat: 0, furnished: 0, furnishedKnown: 0, pets: 0, petsKnown: 0 }]));
  const sources = new Map();
  for (const l of rows) {
    sources.set(l.source, (sources.get(l.source) || 0) + 1);
    const b = bandOf(l, bands);
    for (const t of [perBand.get('all'), perBand.get(b)].filter(Boolean)) {
      t.n++;
      const d = daysBetween(l.first_seen, l.last_seen);
      if (d != null) t.days.push(d);
      const r = (runs.get(l.id) || []).filter((s) => s.rent != null).sort((x, y) => x.from.localeCompare(y.from));
      if (r.length > 1) {
        const first = r[0].rent, last = r[r.length - 1].rent;
        if (first !== last) { t.changed++; if (first > 0) t.pct.push(((last - first) / first) * 100); }
      }
      if (l.parking_included != null) { t.parkingKnown++; if (l.parking_included) t.parking++; }
      if (l.elevator != null) { t.elevatorKnown++; if (l.elevator) t.elevator++; }
      if (l.util_heat === true) t.heat++;
      if (l.furnished != null) { t.furnishedKnown++; if (l.furnished) t.furnished++; }
      const p = l.pet_policy == null ? null : String(l.pet_policy).trim();
      if (p) { t.petsKnown++; if (!/^(0|no|none|no pets|not allowed|not available|not permitted)$/i.test(p)) t.pets++; }
    }
  }
  const bandsOut = {};
  for (const [k, t] of perBand) {
    bandsOut[k] = {
      n: t.n,
      daysMedian: t.days.length >= minN ? median(t.days) : null,
      changedShare: share(t.changed, t.n),
      changePctMedian: t.pct.length >= minN ? median(t.pct) : null,
      parkingShare: share(t.parking, t.parkingKnown), parkingKnown: t.parkingKnown,
      elevatorShare: share(t.elevator, t.elevatorKnown), elevatorKnown: t.elevatorKnown,
      heatShare: share(t.heat, t.n),
      furnishedShare: share(t.furnished, t.furnishedKnown),
      petsShare: share(t.pets, t.petsKnown), petsKnown: t.petsKnown,
    };
  }
  const total = rows.length;
  const sourceRows = [...sources.entries()].map(([source, n]) => ({ source, n, share: share(n, total) })).sort((a, b) => b.n - a.n);
  return { bands: bandsOut, sources: sourceRows };
}
