/*
 * results.js — what the results grid shows and exports: the column
 * catalogue, sorting, paging, the count-line statistics, and the CSV
 * serializer. Pure; tested under node.
 */

import { rentPerSqft, bedroomBand, BEDROOM_BANDS } from './filters.js';

const fmtInt = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-CA'));
const fmtMoney = (n) => (n == null ? '' : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtNum = (n, dp = 1) => (n == null ? '' : Number(n).toFixed(dp).replace(/\.0$/, ''));

/** Area label: the finest geography we have. */
export function areaOf(l) {
  return l.geo_neighborhood || l.geo_mls_area || null;
}

/** What the address cell should read — address, else the title. */
export function addressOf(l) {
  return l.address || l.title || l.url || '';
}

/**
 * Table columns. `get` yields the raw sortable value; `text` the cell
 * string. `num` right-aligns and sorts numerically.
 */
export const COLUMNS = Object.freeze([
  { key: 'source', label: 'Source', get: (l) => l.source, text: (l) => l.source },
  { key: 'address', label: 'Address', get: (l) => addressOf(l), text: (l) => addressOf(l) },
  { key: 'muni', label: 'Municipality', get: (l) => l.geo_municipality || l.city || '', text: (l) => l.geo_municipality || l.city || '' },
  { key: 'area', label: 'Area', get: (l) => areaOf(l) || '', text: (l) => areaOf(l) || '' },
  { key: 'type', label: 'Type', get: (l) => l.property_type || '', text: (l) => l.property_type || '' },
  { key: 'beds', label: 'Beds', num: true, get: (l) => l.bedrooms, text: (l) => (l.bedrooms == null ? '' : l.bedrooms === 0 ? 'Studio' : fmtNum(l.bedrooms)) },
  { key: 'baths', label: 'Baths', num: true, get: (l) => l.bathrooms, text: (l) => fmtNum(l.bathrooms) },
  { key: 'sqft', label: 'Sq ft', num: true, get: (l) => (l.sqft > 0 ? l.sqft : null), text: (l) => (l.sqft > 0 ? fmtInt(l.sqft) : '') },
  { key: 'rent', label: 'Rent', num: true, get: (l) => l.rent, text: (l) => fmtMoney(l.rent) },
  { key: 'psf', label: '$/sf', num: true, get: (l) => rentPerSqft(l), text: (l) => { const v = rentPerSqft(l); return v == null ? '' : `$${v.toFixed(2)}`; } },
  // km from the subject point; blank until one is set (filters.annotateDistance).
  { key: 'dist', label: 'km', num: true, get: (l) => l._dist ?? null, text: (l) => (l._dist == null ? '' : l._dist.toFixed(1)) },
  { key: 'first_seen', label: 'First seen', get: (l) => l.first_seen || '', text: (l) => l.first_seen || '' },
  { key: 'last_seen', label: 'Last seen', get: (l) => l.last_seen || '', text: (l) => l.last_seen || '' },
  { key: 'status', label: 'Status', get: (l) => l.status || '', text: (l) => l.status || '' },
]);

/** Stable sort by a column key. Nulls sort last in either direction. */
export function sortRows(rows, key, dir = 'asc') {
  const col = COLUMNS.find((c) => c.key === key);
  if (!col) return rows.slice();
  const sign = dir === 'desc' ? -1 : 1;
  const decorated = rows.map((l, i) => ({ l, i, v: col.get(l) }));
  decorated.sort((a, b) => {
    const an = a.v == null || a.v === '', bn = b.v == null || b.v === '';
    if (an && bn) return a.i - b.i;
    if (an) return 1;
    if (bn) return -1;
    let c;
    if (col.num) c = Number(a.v) - Number(b.v);
    else c = String(a.v).localeCompare(String(b.v), 'en', { numeric: true, sensitivity: 'base' });
    return c !== 0 ? c * sign : a.i - b.i;
  });
  return decorated.map((d) => d.l);
}

export function pageSlice(rows, page, pageSize) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), page: p, pages };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Count-line statistics under the shared policy: medians only over rents
 * inside the display band, suppressed below min_n. Per-bedroom medians
 * follow the same rule.
 */
export function stats(rows, policy = {}) {
  const lo = policy.display_rent_min ?? 500, hi = policy.display_rent_max ?? 5000;
  const minN = policy.min_n_for_median ?? 5;
  const bands = policy.bedroom_bands || BEDROOM_BANDS;
  const rents = [], psfs = [];
  const byBand = new Map(bands.map((b) => [b.key, []]));
  let canonical = 0;
  for (const l of rows) {
    if (l.dedup_canonical) canonical++;
    if (l.rent == null || l.rent < lo || l.rent > hi) continue;
    rents.push(l.rent);
    const psf = rentPerSqft(l);
    if (psf != null) psfs.push(psf);
    const band = bedroomBand(l.bedrooms, bands);
    if (band != null) byBand.get(band).push(l.rent);
  }
  const guard = (vals) => (vals.length >= minN ? median(vals) : null);
  return {
    n: rows.length,
    canonical,
    inBand: rents.length,
    medianRent: guard(rents),
    medianPsf: guard(psfs),
    byBand: bands.map((b) => ({ key: b.key, n: byBand.get(b.key).length, median: guard(byBand.get(b.key)) })),
    minN,
  };
}

// ---- CSV export --------------------------------------------------------------

const EXPORT_FIELDS = [
  'id', 'source', 'url', 'title', 'address', 'city', 'postal_code',
  'geo_neighborhood', 'geo_mls_area', 'geo_municipality', 'lat', 'lng',
  'property_type', 'bedrooms', 'bathrooms', 'sqft', 'rent', 'rent_psf', 'distance_km',
  'pet_policy', 'parking_included', 'parking_rate', 'laundry', 'elevator',
  'util_heat', 'util_water', 'util_electricity', 'util_internet', 'util_cable', 'furnished',
  'first_seen', 'last_seen', 'rent_observed', 'status', 'available_date',
  'dedup_canonical', 'cited_in_report', 'evidence_path',
];

function csvCell(v) {
  if (v == null) return '';
  if (v === true) return '1';
  if (v === false) return '0';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The filtered rows as CSV text, one row per listing, UTF-8 with BOM
 *  so Excel opens accented street names correctly. */
export function toCsv(rows) {
  const lines = [EXPORT_FIELDS.join(',')];
  for (const l of rows) {
    const rec = {
      ...l,
      rent_psf: (() => { const v = rentPerSqft(l); return v == null ? null : v.toFixed(3); })(),
      distance_km: l._dist == null ? null : l._dist.toFixed(2),
    };
    lines.push(EXPORT_FIELDS.map((k) => csvCell(rec[k])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export { fmtInt, fmtMoney, EXPORT_FIELDS };
