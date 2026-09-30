/*
 * filters.js — the filter state and the predicate that applies it.
 *
 * Pure: no DOM, no storage. filtersPanel.js turns controls into a state
 * object of this shape and back; main.js calls applyFilters() with the
 * parsed bundle. Tested under node.
 *
 * The time window is resolved against the DATA's date (the manifest's
 * newest observation), not the wall clock: the bundle is a weekly
 * snapshot, and "active" must mean active as of that snapshot, or the
 * same folder would show fewer listings every day it sat unrefreshed.
 */

import { normalizeShapes, passesShapeFilter } from './shapeFilter.js';
import { effectiveMunis } from './munis.js';

export const TYPES = Object.freeze(['apartment', 'row_house', 'townhouse']);
export const TYPE_LABELS = Object.freeze({ apartment: 'Apartment', row_house: 'Row house', townhouse: 'Townhouse' });

// Mirrors policy.BEDROOM_BANDS; the manifest ships the authoritative copy
// and applyFilters() takes it from there. This is only the fallback and
// the source of the display order / labels.
export const BEDROOM_BANDS = Object.freeze([
  { key: 'studio', label: 'Studio', min: 0, max: 1 },
  { key: '1br', label: '1', min: 1, max: 2 },
  { key: '2br', label: '2', min: 2, max: 3 },
  { key: '3br', label: '3', min: 3, max: 4 },
  { key: '4plus', label: '4+', min: 4, max: null },
]);

export const WINDOWS = Object.freeze([
  { key: 'active', label: 'Active' },
  { key: '3', label: '3 mo' },
  { key: '6', label: '6 mo' },
  { key: '12', label: '12 mo' },
  { key: 'all', label: 'All' },
]);

/** '' means "no bound" for every numeric text field. */
export const DEFAULT_FILTERS = Object.freeze({
  window: 'active',           // 'active' | '3' | '6' | '12' | 'all' | 'custom'
  from: '', to: '',           // ISO dates; only read when window === 'custom'
  types: [...TYPES],
  beds: BEDROOM_BANDS.map((b) => b.key),
  munis: [], nbhds: [], mls: [], sources: [],
  rentLo: '', rentHi: '',
  canonicalOnly: true,
  // "Additional filters" — collapsed by default, so each one set gets a chip.
  bathsMin: '', sqftLo: '', sqftHi: '', psfLo: '', psfHi: '',
  parking: 'any',             // any | included | paid
  elevator: 'any',            // any | yes | no
  furnished: 'any',           // any | yes | no
  pets: 'any',                // any | allowed | no
  laundry: 'any',             // any | in-unit | in-building
  heat: false, water: false, electricity: false,   // require included
  address: '', title: '',
  coordsOnly: false,
  // Subject point + radius, set from the map rather than a sidebar control.
  subjectLat: '', subjectLng: '', radiusKm: '',
  // Municipality adjacency (the "Adjacent regions" pill): when on, every
  // municipality bordering a picked one is included unless waived off.
  adjacent: false,
  muniExcluded: [],
  // Drawn area shapes (lib/shapeFilter.js), set from the map.
  shapes: [],
});

/** Key used in the municipality picker for listings outside every polygon. */
export const UNASSIGNED = '(unassigned)';

const ADDITIONAL_KEYS = [
  'bathsMin', 'sqftLo', 'sqftHi', 'psfLo', 'psfHi', 'parking', 'elevator', 'furnished',
  'pets', 'laundry', 'heat', 'water', 'electricity', 'address', 'title', 'coordsOnly',
];

export function defaultFilters() {
  return JSON.parse(JSON.stringify(DEFAULT_FILTERS));
}

/** Merge a stored/partial state over the defaults, dropping unknown keys. */
export function normalizeFilters(partial) {
  const out = defaultFilters();
  if (!partial || typeof partial !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (!(k in partial)) continue;
    const v = partial[k];
    if (k === 'shapes') out[k] = normalizeShapes(v);
    else if (Array.isArray(out[k])) { if (Array.isArray(v)) out[k] = v.map(String); }
    else if (typeof out[k] === 'boolean') out[k] = Boolean(v);
    else out[k] = v == null ? '' : String(v);
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

const num = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Band key for a bedrooms value under `bands` ({key,min,max}[]). */
export function bedroomBand(v, bands = BEDROOM_BANDS) {
  if (v == null || !Number.isFinite(Number(v)) || Number(v) < 0) return null;
  const x = Number(v);
  for (const b of bands) if (b.max == null || x < b.max) return b.key;
  return null;
}

const NO_PETS = /^(0|no|none|no pets|not allowed|not available|not permitted)$/i;

/** 'allowed' | 'no' | null from the sources' free-text pet policies. */
export function normalizePets(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  return NO_PETS.test(t) ? 'no' : 'allowed';
}

/**
 * A stated size we are willing to divide by. Scrapers pass through junk
 * (-1, 1, 12,345), and a $/sf mean is wide open to a 10 sf "unit"; no
 * apartment, row house or townhouse rents at under 100 sf or over 10,000.
 */
export function usableSqft(sqft) {
  return sqft != null && Number.isFinite(sqft) && sqft >= 100 && sqft <= 10000 ? sqft : null;
}

/** Rent per square foot, or null when either side is unusable. */
export function rentPerSqft(l) {
  const s = usableSqft(l.sqft);
  if (l.rent == null || l.rent <= 0 || s == null) return null;
  return l.rent / s;
}

/** Municipality key for the picker: the geo value, or UNASSIGNED. */
export function muniKey(l) {
  return l.geo_municipality || UNASSIGNED;
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** {lat, lng} when the filter state carries a usable subject, else null. */
export function subjectOf(f) {
  const lat = num(f?.subjectLat), lng = num(f?.subjectLng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Stamp `_dist` (km from the subject, or null) on each row in place.
 * A derived, underscore-prefixed field: the table and CSV read it, the
 * bundle parser never writes it.
 */
export function annotateDistance(rows, subject) {
  for (const l of rows) {
    l._dist = subject && l.lat != null && l.lng != null
      ? haversineKm(subject.lat, subject.lng, l.lat, l.lng)
      : null;
  }
  return rows;
}

/** ISO date minus N days / months (calendar arithmetic in UTC). */
export function shiftIso(iso, { days = 0, months = 0 } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (months) d.setUTCMonth(d.getUTCMonth() + months);
  if (days) d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The [from, to] window (ISO strings or null) a filter state denotes,
 * given the data's as-of date and the policy's active window.
 */
export function resolveWindow(f, { asOf, activeWindowDays = 60 } = {}) {
  switch (f.window) {
    case 'active': return { from: shiftIso(asOf, { days: -activeWindowDays }), to: null };
    case '3': case '6': case '12': return { from: shiftIso(asOf, { months: -Number(f.window) }), to: null };
    case 'custom': return { from: f.from || null, to: f.to || null };
    default: return { from: null, to: null };
  }
}

const has = (arr, v) => arr.length === 0 || arr.includes(v);
const contains = (hay, needle) => !needle || (hay != null && String(hay).toLowerCase().includes(needle));
const tri = (setting, value) => setting === 'any' || (setting === 'yes' ? value === true : value === false);

/**
 * Apply a filter state to the parsed listings.
 * @param {Array} listings  typed records from bundle.js
 * @param {Object} f        filter state (normalizeFilters output)
 * @param {Object} ctx      { asOf, policy } from the manifest; muniIndex
 *                          (lib/munis.js buildMuniIndex) for adjacency
 * @returns {Array} matching listings, in input order
 */
export function applyFilters(listings, f, { asOf, policy, muniIndex = null } = {}) {
  const bands = policy?.bedroom_bands || BEDROOM_BANDS;
  const munis = effectiveMunis(f, muniIndex);
  const shapes = Array.isArray(f.shapes) ? f.shapes : [];
  const win = resolveWindow(f, { asOf, activeWindowDays: policy?.active_window_days ?? 60 });
  const allTypes = f.types.length === 0 || TYPES.every((t) => f.types.includes(t));
  const allBeds = f.beds.length === 0 || bands.every((b) => f.beds.includes(b.key));
  const rentLo = num(f.rentLo), rentHi = num(f.rentHi);
  const bathsMin = num(f.bathsMin);
  const sqftLo = num(f.sqftLo), sqftHi = num(f.sqftHi);
  const psfLo = num(f.psfLo), psfHi = num(f.psfHi);
  const addr = f.address.trim().toLowerCase();
  const title = f.title.trim().toLowerCase();
  const subject = subjectOf(f);
  const radius = num(f.radiusKm);
  const useRadius = subject != null && radius != null && radius > 0;

  const out = [];
  for (const l of listings) {
    // Observation span overlaps the window: last seen on/after `from`,
    // first seen on/before `to`. Dates are ISO strings, so string compare.
    if (win.from && (l.last_seen == null || l.last_seen < win.from)) continue;
    if (win.to && (l.first_seen == null || l.first_seen > win.to)) continue;
    if (f.canonicalOnly && l.dedup_canonical === false) continue;
    if (!allTypes && !f.types.includes(l.property_type)) continue;
    if (!allBeds) {
      const band = bedroomBand(l.bedrooms, bands);
      if (band == null || !f.beds.includes(band)) continue;
    }
    if (!has(munis, muniKey(l))) continue;
    if (!has(f.nbhds, l.geo_neighborhood)) continue;
    if (!has(f.mls, l.geo_mls_area)) continue;
    if (!has(f.sources, l.source)) continue;
    if (rentLo != null && (l.rent == null || l.rent < rentLo)) continue;
    if (rentHi != null && (l.rent == null || l.rent > rentHi)) continue;
    if (bathsMin != null && (l.bathrooms == null || l.bathrooms < bathsMin)) continue;
    if (sqftLo != null && (l.sqft == null || l.sqft < sqftLo)) continue;
    if (sqftHi != null && (l.sqft == null || l.sqft > sqftHi)) continue;
    if (psfLo != null || psfHi != null) {
      const psf = rentPerSqft(l);
      if (psf == null) continue;
      if (psfLo != null && psf < psfLo) continue;
      if (psfHi != null && psf > psfHi) continue;
    }
    if (f.parking === 'included' && l.parking_included !== true) continue;
    if (f.parking === 'paid' && !(l.parking_included === false || (l.parking_rate != null && l.parking_rate > 0))) continue;
    if (!tri(f.elevator, l.elevator)) continue;
    if (!tri(f.furnished, l.furnished)) continue;
    if (f.pets !== 'any' && normalizePets(l.pet_policy) !== f.pets) continue;
    if (f.laundry !== 'any' && l.laundry !== f.laundry) continue;
    if (f.heat && l.util_heat !== true) continue;
    if (f.water && l.util_water !== true) continue;
    if (f.electricity && l.util_electricity !== true) continue;
    if (!contains(l.address, addr)) continue;
    if (!contains(l.title, title)) continue;
    if (f.coordsOnly && (l.lat == null || l.lng == null)) continue;
    if (useRadius) {
      if (l.lat == null || l.lng == null) continue;
      if (haversineKm(subject.lat, subject.lng, l.lat, l.lng) > radius) continue;
    }
    if (shapes.length && !passesShapeFilter(l.lat != null && l.lng != null ? { lat: l.lat, lng: l.lng } : null, shapes)) continue;
    out.push(l);
  }
  return out;
}

// ---- chips ------------------------------------------------------------------

const money = (n) => `$${Math.round(Number(n)).toLocaleString('en-CA')}`;
const range = (lo, hi, fmt = String, unit = '') => {
  const u = unit ? ` ${unit}` : '';
  if (lo !== '' && hi !== '') return `${fmt(lo)}–${fmt(hi)}${u}`;
  if (lo !== '') return `≥ ${fmt(lo)}${u}`;
  if (hi !== '') return `≤ ${fmt(hi)}${u}`;
  return '';
};

/**
 * One chip per "Additional filters" control that is away from its
 * default, so a collapsed disclosure can never silently narrow the
 * results. Returns [{key, label}].
 */
export function additionalChips(f) {
  const d = DEFAULT_FILTERS;
  const chips = [];
  const push = (key, label) => { if (label) chips.push({ key, label }); };
  if (f.bathsMin !== d.bathsMin) push('bathsMin', `≥ ${f.bathsMin} bath`);
  push('sqft', range(f.sqftLo, f.sqftHi, (v) => Number(v).toLocaleString('en-CA'), 'sf'));
  push('psf', range(f.psfLo, f.psfHi, (v) => `$${Number(v).toFixed(2)}`, '/sf'));
  if (f.parking !== d.parking) push('parking', f.parking === 'included' ? 'Parking incl.' : 'Parking paid');
  if (f.elevator !== d.elevator) push('elevator', f.elevator === 'yes' ? 'Elevator' : 'No elevator');
  if (f.furnished !== d.furnished) push('furnished', f.furnished === 'yes' ? 'Furnished' : 'Unfurnished');
  if (f.pets !== d.pets) push('pets', f.pets === 'allowed' ? 'Pets allowed' : 'No pets');
  if (f.laundry !== d.laundry) push('laundry', `Laundry ${f.laundry}`);
  const utils = [f.heat && 'heat', f.water && 'water', f.electricity && 'hydro'].filter(Boolean);
  if (utils.length) push('utilities', `${utils.join(' + ')} incl.`);
  if (f.address.trim()) push('address', `Address "${f.address.trim()}"`);
  if (f.title.trim()) push('title', `Title "${f.title.trim()}"`);
  if (f.coordsOnly) push('coordsOnly', 'Mapped only');
  // Set on the map, not in the sidebar — still a narrowing the user may
  // not see from the filter panel, so it gets a chip too.
  const subj = subjectOf(f), r = Number(f.radiusKm);
  if (subj && Number.isFinite(r) && r > 0) push('radius', `≤ ${r} km of subject`);
  const shapes = Array.isArray(f.shapes) ? f.shapes : [];
  if (shapes.length) {
    const inc = shapes.filter((s) => s.mode !== 'exclude').length, exc = shapes.length - inc;
    push('shapes', [inc ? `${inc} drawn area${inc === 1 ? '' : 's'}` : '', exc ? `${exc} excluded area${exc === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '));
  }
  return chips;
}

/** Is any control (main or additional) away from its default? */
export function isDefault(f) {
  const d = defaultFilters();
  return JSON.stringify(normalizeFilters(f)) === JSON.stringify(d);
}

export { ADDITIONAL_KEYS, money };
