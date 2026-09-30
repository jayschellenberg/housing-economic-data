/*
 * filters.js — the filter state and the predicate that applies it.
 *
 * Pure: no DOM, no storage. filtersPanel.js turns controls into a state
 * object of this shape and back; main.js calls applyFilters() with the
 * parsed bundle. Tested under node.
 *
 * Time is measured in CYCLES ('2026-09'), the monthly rhythm the tracker
 * actually has, and "on the market" is resolved against the newest cycle
 * in the DATA rather than the wall clock — the same folder must not show
 * a smaller market every day it sits unrefreshed on someone's laptop.
 */

import { isCurrent, onMarketStatuses, policy, inBand } from './summary.js';

/** '' means "no bound" for every numeric and cycle field. */
export const DEFAULT_FILTERS = Object.freeze({
  // 'current' — on the market in the newest cycle (the default view).
  // 'any'     — every record the bundle carries, including Sold/Leased/
  //             Delisted history, which is what comparables need.
  market: 'current',
  statuses: [],           // [] = any status allowed by `market`
  spaceTypes: [],
  listingTypes: [],
  brokerages: [],
  municipalities: [],
  clusters: [],           // Winnipeg community clusters, between the two
  neighbourhoods: [],
  from: '', to: '',       // cycle bounds, matched against last_seen
  sfLo: '', sfHi: '',
  rateLo: '', rateHi: '', // $/sf/yr, the normalized lease rate
  priceLo: '', priceHi: '',
  text: '',               // what to look for; TEXT_SCOPES says where
  // Which fields `text` searches. Defaults to 'address' because mixing
  // the two is what made address search unusable: "wilkes ave" returned
  // 197 records, only 64 of them AT an address on Wilkes, with nothing on
  // screen saying which was which. 'all' is the behaviour before this
  // existed, kept for anyone who wants it.
  textScope: 'address',
  hasFlyer: false,
  mappedOnly: false,
  plausibleOnly: false,   // drop values outside the manifest's bands
  // Leave out the listings Moody's added that no brokerage source carries
  // (record_source 'moodys'). They are real listings — 705 Broadway is one
  // — but they only exist from the months Moody's was archived, so a trend
  // across April 2026 wants them out.
  brokerageSourcesOnly: false,
  collapseDuplicates: false,
});

export const defaultFilters = () => ({ ...DEFAULT_FILTERS });

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const has = (list) => Array.isArray(list) && list.length > 0;
const hasText = (s) => typeof s === 'string' && s.trim() !== '';

/** Great-circle distance in km. Used by the drawn-radius filter and by
 *  the "km from subject" column. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Stamp each record with its distance from the subject point, so the
 * grid can show and sort by it. Mutates in place (the rows are the
 * bundle's own objects, and copying 8,880 of them on every map drag is
 * not worth it); clears the stamp when there is no subject.
 */
export function annotateDistance(records, subject) {
  for (const r of records || []) {
    r._dist = (subject && r.latitude != null && r.longitude != null)
      ? haversineKm(subject.lat, subject.lng, r.latitude, r.longitude)
      : null;
  }
  return records;
}

/** The size a listing should be filtered and sorted on. */
export const sizeOf = (r) => r.sf_max ?? r.sf_min ?? null;

/** The asking rate in $/sf/yr, but only where the basis is a rate.
 *  A sale price is not a rate and must never be compared with one. */
export function rateOf(r) {
  if (r.listing_type !== 'Lease') return null;
  return r.current_price_psf_annual ?? null;
}

/** The asking price of a sale. */
export function priceOf(r) {
  if (r.listing_type !== 'Sale') return null;
  return r.current_price ?? null;
}

/**
 * Where the search box looks.
 *
 * `address` is the IDENTITY of a space — what it is called and how it is
 * filed. roll_number belongs with it because it is the field most worth
 * pasting: an assessment roll from a tax bill finds the listing even when
 * nobody agrees on how to spell the address, which is the whole reason the
 * cross-reference matches on it.
 *
 * `city` and `zoning` are deliberately NOT in `address`: both have their
 * own filters, and "Portage" would otherwise pull in every listing in
 * Portage la Prairie alongside the ones on Portage Avenue.
 */
export const TEXT_SCOPES = Object.freeze({
  address: ['address', 'property_name', 'unit', 'roll_number'],
  notes: ['comments'],
  all: ['address', 'property_name', 'unit', 'city', 'comments', 'zoning', 'roll_number'],
});

const scopeFields = (scope) => TEXT_SCOPES[scope] || TEXT_SCOPES.address;

// An apostrophe joins a word; every other mark separates one. Splitting on
// it turns Mary's into "mary" + "s", and then "st marys rd" matches nothing.
const APOSTROPHE = /['’]/g;
const NOT_ALNUM = /[^a-z0-9]+/g;

/** Lowercase words, punctuation gone. "St. Mary's Road" -> [st, marys, road] */
export function searchTokens(text) {
  return String(text ?? '').toLowerCase().replace(APOSTROPHE, '')
    .replace(NOT_ALNUM, ' ').trim().split(' ')
    .filter(Boolean);
}

// Street types, abbreviation -> the long form both sides are compared in.
//
// A prefix rule alone cannot do this. Some abbreviations are truncations
// ("ave" IS the start of "avenue") and some are contractions ("rd" is not
// the start of "road", nor "blvd" of "boulevard"), so half the vocabulary
// would silently never match.
//
// This is a SEARCH convenience and not a join key: v3/civic_address.py is
// the authority the roll lanes match on, and if this list drifts from it
// the cost is a search result, not a wrong property.
const STREET_TYPES = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', rd: 'road',
  dr: 'drive', blvd: 'boulevard', bv: 'boulevard', cr: 'crescent',
  cres: 'crescent', pl: 'place', pkwy: 'parkway', pky: 'parkway',
  py: 'parkway', trl: 'trail', hwy: 'highway', cir: 'circle', ct: 'court',
  sq: 'square', terr: 'terrace', ter: 'terrace', gdns: 'gardens',
  gdn: 'garden', grv: 'grove', ln: 'lane', prom: 'promenade',
};
const expand = (t) => STREET_TYPES[t] || t;

/**
 * Does one typed word answer one word of the data?
 *
 * Street types are expanded on both sides first, so it no longer matters
 * which spelling the source happened to use. What survives after that is a
 * PREFIX rule in both directions, which covers a half-typed street name
 * ("porta" finds Portage) and an abbreviation this list has never heard of.
 *
 * Numbers must match EXACTLY, because a civic number is an identity and
 * not a prefix — "105 Main" must not find 1050 Main Street. The one
 * concession is a letter suffix: typing 1076 finds 1076A, the same door.
 */
export function tokenMatches(want, have) {
  if (/^\d+$/.test(want)) {
    return have === want
      || (have.length === want.length + 1 && have.startsWith(want)
          && /[a-z]/.test(have[want.length]));
  }
  const w = expand(want);
  const h = expand(have);
  return h.startsWith(w) || w.startsWith(h);
}

/**
 * Search the fields a person would search.
 *
 * Was a contiguous substring, which meant typing the street type, spelled
 * as stored, with the punctuation in the right places: "st marys rd" found
 * none of the nine St. Mary's Road listings and "101 Regent W" missed
 * "101 Regent Avenue W". Now every typed word has to answer some word of
 * ONE field — order-free, so "Portage 1500" works, but never spread across
 * two fields, which would match an address to an unrelated comment.
 *
 * The exact-substring test stays and runs first: it is the cheap path, and
 * it is what a pasted roll number or a quoted phrase hits.
 */
function matchesText(r, needle, scope) {
  const q = String(needle ?? '').trim().toLowerCase();
  if (!q) return true;
  const wanted = searchTokens(q);
  if (!wanted.length) return true;
  const fields = scopeFields(scope);
  // Tokens are cached on the record: the box filters every record on every
  // keystroke, and re-splitting 8,900 comment fields each time is the one
  // place this gets slow enough to feel.
  let cache = r._search;
  if (!cache) {
    cache = {};
    for (const key of TEXT_SCOPES.all) {
      if (r[key]) cache[key] = searchTokens(r[key]);
    }
    Object.defineProperty(r, '_search', { value: cache, enumerable: false });
  }
  for (const key of fields) {
    const field = r[key];
    if (!field) continue;
    if (String(field).toLowerCase().includes(q)) return true;
    const have = cache[key];
    if (have && wanted.every((w) => have.some((h) => tokenMatches(w, h)))) return true;
  }
  return false;
}

/**
 * One row per space when `collapseDuplicates` is on. 440 records are the
 * same unit listed by two brokerages; counting both doubles a market.
 * The survivor is the one a person would rather see: priced over
 * unpriced, then most recently seen, then the lowest id so the choice is
 * stable across runs.
 */
export function collapseDuplicates(rows) {
  const best = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.dup_group) { out.push(r); continue; }
    const prev = best.get(r.dup_group);
    if (!prev || betterCopy(r, prev)) best.set(r.dup_group, r);
  }
  return out.concat([...best.values()]);
}

function betterCopy(a, b) {
  const priced = (r) => (r.current_price != null ? 1 : 0);
  if (priced(a) !== priced(b)) return priced(a) > priced(b);
  const seen = (r) => r.last_seen || '';
  if (seen(a) !== seen(b)) return seen(a) > seen(b);
  return String(a.listing_id) < String(b.listing_id);
}

/**
 * Apply `filters` to `records`. `manifest` supplies the data cycle, the
 * on-market vocabulary and the plausibility bands — all bundle-defined,
 * never assumed here.
 */
export function applyFilters(records, filters, manifest) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) };
  const statuses = onMarketStatuses(manifest);
  const bands = policy(manifest);

  const wantStatus = has(f.statuses) ? new Set(f.statuses.map((s) => String(s).toLowerCase())) : null;
  const wantSpace = has(f.spaceTypes) ? new Set(f.spaceTypes) : null;
  const wantListing = has(f.listingTypes) ? new Set(f.listingTypes) : null;
  const wantBrokerage = has(f.brokerages) ? new Set(f.brokerages) : null;
  const wantMuni = has(f.municipalities) ? new Set(f.municipalities) : null;
  const wantCluster = has(f.clusters) ? new Set(f.clusters) : null;
  const wantNbhd = has(f.neighbourhoods) ? new Set(f.neighbourhoods) : null;

  const sfLo = num(f.sfLo), sfHi = num(f.sfHi);
  const rateLo = num(f.rateLo), rateHi = num(f.rateHi);
  const priceLo = num(f.priceLo), priceHi = num(f.priceHi);

  let out = records.filter((r) => {
    if (f.market === 'current' && !isCurrent(r, manifest, statuses)) return false;
    if (wantStatus && !wantStatus.has(String(r.status || '').toLowerCase())) return false;
    if (wantSpace && !wantSpace.has(r.space_type)) return false;
    if (wantListing && !wantListing.has(r.listing_type)) return false;
    if (wantBrokerage && !wantBrokerage.has(r.brokerage)) return false;
    if (wantMuni && !wantMuni.has(r.municipality)) return false;
    // Cluster and neighbourhood are two tiers of one hierarchy, but they
    // intersect like every other pair of filters: picking a cluster and a
    // neighbourhood outside it correctly yields nothing.
    if (wantCluster && !wantCluster.has(r.cluster)) return false;
    if (wantNbhd && !wantNbhd.has(r.neighbourhood)) return false;

    // Cycle bounds read last_seen: "was this on the market in that window".
    if (hasText(f.from) && (!r.last_seen || r.last_seen < f.from)) return false;
    if (hasText(f.to) && (!r.last_seen || r.last_seen > f.to)) return false;

    const size = sizeOf(r);
    if (sfLo != null && (size == null || size < sfLo)) return false;
    if (sfHi != null && (size == null || size > sfHi)) return false;

    // A rate or price bound restricts to listings that HAVE one: asking
    // "under $15/sf" cannot sensibly include an unpriced listing.
    if (rateLo != null || rateHi != null) {
      const rate = rateOf(r);
      if (rate == null) return false;
      if (rateLo != null && rate < rateLo) return false;
      if (rateHi != null && rate > rateHi) return false;
    }
    if (priceLo != null || priceHi != null) {
      const price = priceOf(r);
      if (price == null) return false;
      if (priceLo != null && price < priceLo) return false;
      if (priceHi != null && price > priceHi) return false;
    }

    if (f.hasFlyer && !r.flyer_path) return false;
    if (f.mappedOnly && (r.latitude == null || r.longitude == null)) return false;
    if (f.brokerageSourcesOnly && r.record_source === 'moodys') return false;

    if (f.plausibleOnly) {
      const rate = rateOf(r), price = priceOf(r);
      if (rate != null && !inBand(rate, bands.leaseRate)) return false;
      if (price != null && !inBand(price, bands.salePrice)) return false;
      if (size != null && !inBand(size, bands.size)) return false;
    }

    if (hasText(f.text) && !matchesText(r, f.text, f.textScope)) return false;
    return true;
  });

  if (f.collapseDuplicates) out = collapseDuplicates(out);
  return out;
}

/** True when anything differs from the defaults — drives "Clear all". */
export function isDefault(filters) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) };
  return Object.keys(DEFAULT_FILTERS).every((k) => {
    const a = f[k], b = DEFAULT_FILTERS[k];
    if (Array.isArray(b)) return !has(a);
    return a === b;
  });
}

const CHIP_LABELS = {
  spaceTypes: 'Type', listingTypes: 'Sale/Lease', statuses: 'Status',
  brokerages: 'Brokerage', municipalities: 'Municipality',
  clusters: 'Cluster', neighbourhoods: 'Neighbourhood',
};

/**
 * Human-readable chips for the active filters — the same text an export
 * uses to state what the reader is looking at, so a spreadsheet can
 * never lose the qualifier that produced it.
 */
export function describeFilters(filters, manifest) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) };
  const chips = [];
  const cycle = manifest?.cycles?.last;

  chips.push(f.market === 'current'
    ? { key: 'market', label: `On the market${cycle ? ` (${cycle})` : ''}`, sticky: true }
    : { key: 'market', label: 'All records, including history', sticky: true });

  for (const [key, label] of Object.entries(CHIP_LABELS)) {
    if (has(f[key])) chips.push({ key, label: `${label}: ${f[key].join(', ')}` });
  }
  if (hasText(f.from) || hasText(f.to)) {
    chips.push({ key: 'cycles', label: `Seen ${f.from || 'start'} to ${f.to || cycle || 'latest'}` });
  }
  if (hasText(f.sfLo) || hasText(f.sfHi)) {
    chips.push({ key: 'size', label: `${f.sfLo || '0'}–${f.sfHi || '∞'} sf` });
  }
  if (hasText(f.rateLo) || hasText(f.rateHi)) {
    chips.push({ key: 'rate', label: `$${f.rateLo || '0'}–$${f.rateHi || '∞'}/sf/yr` });
  }
  if (hasText(f.priceLo) || hasText(f.priceHi)) {
    chips.push({ key: 'price', label: `Price $${f.priceLo || '0'}–$${f.priceHi || '∞'}` });
  }
  // The scope rides WITH the text rather than as a chip of its own: an
  // export has to be able to say where it looked, and “dock” alone does
  // not distinguish a note from a street.
  if (hasText(f.text)) {
    const where = { address: 'in address', notes: 'in notes', all: 'anywhere' }[f.textScope]
      || 'in address';
    chips.push({ key: 'text', label: `“${f.text.trim()}” ${where}` });
  }
  if (f.hasFlyer) chips.push({ key: 'hasFlyer', label: 'Has a flyer' });
  if (f.mappedOnly) chips.push({ key: 'mappedOnly', label: 'Mapped only' });
  if (f.brokerageSourcesOnly) chips.push({ key: 'brokerageSourcesOnly', label: 'Brokerage sources only' });
  if (f.plausibleOnly) chips.push({ key: 'plausibleOnly', label: 'Plausible values only' });
  if (f.collapseDuplicates) chips.push({ key: 'collapseDuplicates', label: 'One row per space' });
  return chips;
}

/** The distinct values present in `records`, with counts, for a picker. */
export function optionsFor(records, field) {
  const counts = new Map();
  for (const r of records) {
    const v = r[field];
    if (v == null || v === '') continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}
