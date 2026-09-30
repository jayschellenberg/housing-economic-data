/*
 * subjectLookup.js — turn what someone types into a place for the subject.
 *
 * Three ways in, all offline. The page promises nothing leaves the
 * machine, so there is no geocoder to call:
 *
 *   coordinates    "49.8951, -97.1384" — or pasted the other way round,
 *                  which a GIS export usually does
 *   an address     Winnipeg's civic address points, shipped in the
 *                  connected folder (export/address_points.csv, ~232k)
 *   a listing      any geocoded record's own address, which is the only
 *                  source outside Winnipeg
 *
 * The address points are what make this worth having. An appraisal
 * subject is usually a property with NO listing, and a lookup over the
 * listings alone could never find it.
 *
 * Matching reuses the search box's rules (filters.js tokenMatches): a
 * civic number is exact, street words match by prefix with the types
 * expanded, so "233 portage ave" and "233 Portage Avenue" land on the
 * same door. The number is what the index is keyed on — every address
 * has one, it is exact, and it cuts 232k candidates to a few dozen before
 * any word is compared.
 *
 * Pure; tested under node.
 */

import { searchTokens, tokenMatches } from './filters.js';

// Manitoba, generously. A pasted pair outside this is not a place the
// data can say anything about, and is most often lat/lng swapped.
const LAT = [48, 61];
const LNG = [-103, -88];
const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;

/**
 * "49.8951, -97.1384" -> { lat, lng }, or null.
 * Accepts either order, since lng-first is how a GIS export writes it.
 */
export function parseCoordinates(text) {
  const m = String(text ?? '').trim()
    .match(/^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (inRange(a, LAT) && inRange(b, LNG)) return { lat: a, lng: b };
  if (inRange(b, LAT) && inRange(a, LNG)) return { lat: b, lng: a };
  return null;
}

/** "233 PORTAGE AVENUE" -> "233 Portage Avenue", for a suggestion list. */
export function displayAddress(key) {
  return String(key ?? '').toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    // Directions and ordinals read wrong title-cased: "Ave W", "10th".
    .replace(/\b(Ne|Nw|Se|Sw)\b/g, (d) => d.toUpperCase())
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_m, n, s) => n + s.toLowerCase())
    // A one-letter suffix is part of the civic number: 1076A, not 1076a.
    .replace(/\b(\d+)([a-z])\b/g, (_m, n, l) => n + l.toUpperCase());
}

/**
 * Index the address points and the listings by civic number.
 *
 * @param {string} pointsCsv  address_points.csv text ("address,lat,lon"),
 *                            or '' when the folder does not carry it
 * @param {object[]} records  bundle records, for listings with coordinates
 */
export function buildSubjectIndex(pointsCsv, records = []) {
  const byNumber = new Map();
  let points = 0;
  let listings = 0;

  /** Add one place; returns the entry, or null when it has no number. */
  const add = (label, lat, lng, source, where = '') => {
    const tokens = searchTokens(label);
    const num = tokens.find((t) => /^\d/.test(t));
    if (!num) return null;
    // Keyed on the digits alone, so 1076 and 1076A share a bucket and the
    // letter rule in tokenMatches still decides between them.
    const key = num.replace(/[a-z]+$/, '');
    let bucket = byNumber.get(key);
    if (!bucket) byNumber.set(key, (bucket = []));
    const entry = { label, lat, lng, source, where, tokens };
    bucket.push(entry);
    return entry;
  };

  // No quote-aware parse needed: the keys are civic_address output, which
  // strips punctuation, so a comma can only be a field separator — and a
  // 232k-row file is worth reading at split() speed.
  const text = String(pointsCsv ?? '');
  let start = text.indexOf('\n') + 1;               // skip the header
  while (start > 0 && start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    const c2 = line.lastIndexOf(',');
    const c1 = c2 > 0 ? line.lastIndexOf(',', c2 - 1) : -1;
    if (c1 <= 0) continue;
    const lat = Number(line.slice(c1 + 1, c2));
    const lng = Number(line.slice(c2 + 1));
    if (!inRange(lat, LAT) || !inRange(lng, LNG)) continue;
    if (add(displayAddress(line.slice(0, c1)), lat, lng, 'address')) points++;
  }

  // One entry per distinct listed address, not per record: 8,901 records
  // are ~4,000 places, and a suggestion list of five copies of one
  // building is noise.
  const seen = new Set();
  for (const r of records || []) {
    if (r?.latitude == null || r?.longitude == null || !r.address) continue;
    const k = `${String(r.address).toLowerCase()}|${r.municipality || r.city || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (add(r.address, r.latitude, r.longitude, 'listing', r.municipality || r.city || '')) {
      listings++;
    }
  }
  return { byNumber, points, listings };
}

/**
 * Ranked places for a typed query: [{ label, lat, lng, source, where }].
 *
 * Every typed word must answer a word of the candidate. An address point
 * outranks a listing at the same door because it is the city's own
 * survey, and listings are geocoded — close, but not the civic record.
 */
export function lookupSubject(query, index, { limit = 8 } = {}) {
  const coords = parseCoordinates(query);
  if (coords) {
    return [{ label: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
      ...coords, source: 'coordinates' }];
  }
  if (!index) return [];
  const wanted = searchTokens(query);
  const num = wanted.find((t) => /^\d+$/.test(t) || /^\d+[a-z]$/.test(t));
  if (!num) return [];
  const bucket = index.byNumber.get(num.replace(/[a-z]+$/, '')) || [];
  const hits = bucket.filter((c) => wanted.every((w) => c.tokens.some((h) => tokenMatches(w, h))));
  // A listing and an address point at the same door are the same answer.
  const byLabel = new Map();
  for (const h of hits) {
    const k = h.label.toLowerCase();
    const prev = byLabel.get(k);
    if (!prev || (prev.source === 'listing' && h.source === 'address')) byLabel.set(k, h);
  }
  return [...byLabel.values()]
    .sort((a, b) => (a.source === b.source ? 0 : a.source === 'address' ? -1 : 1)
      || a.tokens.length - b.tokens.length
      || a.label.localeCompare(b.label, 'en', { numeric: true }))
    .slice(0, limit)
    .map(({ label, lat, lng, source, where }) => ({ label, lat, lng, source, where: where || '' }));
}
