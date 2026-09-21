/*
 * Winnipeg address → census geography lookup.
 *
 * Resolves a typed street address to the three City-of-Winnipeg virtual
 * geographies the Census Profile tab reports on: Neighbourhood, Neighbourhood
 * Cluster and Community Area.
 *
 * The index (data/geo/wpg_address_index.json, ~150 KB / ~50 KB gzipped) is
 * built by r/25_build_wpg_address_index.R from the City's own address file and
 * its cluster / community-area boundaries. See that script's header for why
 * the City's per-address label beats a census dissemination-area join (which
 * was measured wrong for 4% of addresses at cluster level).
 *
 * Not every neighbourhood the City names has a census profile — 26 of 237 are
 * newer or finer than the 2021 DA vintage r/12 builds from. This module
 * reports what the City says; the caller checks each level against the regions
 * it actually has.
 *
 * Index shape:
 *   areas:   [[neighbourhood|null, cluster, communityArea], …]
 *   streets: { "<NAME TYPE DIR>": areaIdx                  // whole street, one area
 *                                 | [evenRuns, oddRuns] }  // [[fromNumber, areaIdx], …]
 * Runs are split by parity because boundary streets routinely have their two
 * sides in different areas; a lookup bisects for the last run starting at or
 * below the house number.
 *
 * Unlike ./census-profile.js this caches the PARSED object rather than the
 * text: nothing here mutates the index, so one shared copy is safe.
 */

// Street types exactly as the City spells them (its `street_type` domain), used
// to split a street key into name / type / direction.
const TYPES = new Set([
  'ALLEY', 'AVE', 'BAY', 'BEND', 'BLVD', 'CIR', 'CLOSE', 'COMMON', 'COVE',
  'CRES', 'CROSS', 'CRT', 'DR', 'FWY', 'GATE', 'GDN', 'GDNS', 'GROVE', 'HWY',
  'KEY', 'LANE', 'MEWS', 'PATH', 'PK', 'PKY', 'PL', 'PROM', 'PT', 'RD',
  'RIDGE', 'ROW', 'RUN', 'SQ', 'ST', 'TERR', 'TRAIL', 'WALK', 'WAY',
]);

const DIRS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

// What people type → the City's code. Only entries that differ from the code
// itself need to be here; anything already in TYPES passes through.
const TYPE_ALIASES = {
  AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', STR: 'ST', ROAD: 'RD',
  BOULEVARD: 'BLVD', BOUL: 'BLVD', DRIVE: 'DR', CRESCENT: 'CRES', CRESC: 'CRES',
  COURT: 'CRT', CT: 'CRT', PLACE: 'PL', PARKWAY: 'PKY', PKWY: 'PKY',
  PARK: 'PK', PROMENADE: 'PROM', POINT: 'PT', POINTE: 'PT', TERRACE: 'TERR',
  GARDEN: 'GDN', GARDENS: 'GDNS', SQUARE: 'SQ', CIRCLE: 'CIR', HIGHWAY: 'HWY',
  FREEWAY: 'FWY', CIRCUIT: 'CIR', LN: 'LANE', TR: 'TRAIL', RDG: 'RIDGE',
};

const DIR_ALIASES = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHWEST: 'NW', NORTHEAST: 'NE', SOUTHWEST: 'SW', SOUTHEAST: 'SE',
};

// Unit designators to drop: "Unit 5 - 123 Main St", "#5-123 Main St", "123 Main St Apt 5".
const UNIT_WORDS = /\b(?:UNIT|APT|APARTMENT|SUITE|STE|BSMT|BASEMENT|PH)\b\.?\s*#?\s*[A-Z0-9-]*/g;

// Punctuation-insensitive form used for all matching. The City spells some
// names with periods or apostrophes ("DR. DAVID MARSH", "GOVERNOR'S") and most
// without, so both sides of every comparison go through this.
export const canon = (s) => String(s || '')
  .toUpperCase()
  .replace(/[.'`‘’,]/g, '')
  .replace(/[-‐-―]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Split a canonical street key into { name, type, dir }. A bare street with no
// type ("BAY") keeps its name — the type is only stripped when something else
// remains.
function splitKey(key) {
  const t = key.split(' ');
  let dir = '', type = '';
  if (t.length > 1 && DIRS.has(t[t.length - 1])) dir = t.pop();
  if (t.length > 1 && TYPES.has(t[t.length - 1])) type = t.pop();
  return { name: t.join(' '), type, dir };
}

// ---- loader ----------------------------------------------------------------

let indexPromise = null;

// Resolve to the parsed index (with its lookup maps attached), or null if the
// file can't be loaded. Callers render a message when it's null.
export async function loadWpgAddressIndex() {
  if (!indexPromise) {
    indexPromise = fetch('./data/geo/wpg_address_index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.streets ? prepare(j) : null))
      .catch(() => null);
  }
  const idx = await indexPromise;
  if (!idx) indexPromise = null;      // evict on failure so a later attempt retries
  return idx;
}

// Test hook: forget the cached index so a fresh fetch runs next call.
export function _resetWpgAddressCache() {
  indexPromise = null;
}

// Attach the match maps once, rather than rebuilding them on every keystroke.
function prepare(idx) {
  const byCanon = new Map();          // "PORTAGE AVE"  → real key
  const byName  = new Map();          // "PORTAGE"      → [real key, …]
  for (const key of Object.keys(idx.streets)) {
    const c = canon(key);
    byCanon.set(c, key);
    const { name } = splitKey(c);
    const arr = byName.get(name);
    if (arr) arr.push(key); else byName.set(name, [key]);
  }
  idx._byCanon = byCanon;
  idx._byName = byName;
  return idx;
}

// ---- input parsing ---------------------------------------------------------

/**
 * Pull a house number and a normalized street key out of free-typed input.
 * Returns null when there's no leading house number to work with.
 */
export function parseAddress(input) {
  let s = canon(input)
    .replace(/\bWINNIPEG\b.*$/, '')       // trailing "Winnipeg, MB R3C 0A1"
    .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/g, '')
    .replace(UNIT_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "5 123 MAIN ST" after a "5-123 Main St" unit prefix collapsed: if two bare
  // numbers lead and the first is the shorter, it was the unit.
  const lead = s.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (lead && lead[1].length <= lead[2].length) s = `${lead[2]} ${lead[3]}`;

  const m = s.match(/^(\d+)\s*[A-Z]?\s+(.+)$/);   // "123A MAIN ST" → 123, "MAIN ST"
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;

  const tokens = m[2].split(' ').filter(Boolean);
  if (!tokens.length) return null;
  // The literal remainder, before any type/direction expansion. A handful of
  // streets END in a word that also names a type — "The Promenade", "Blairmore
  // Gardens", "Kinsbourne Green" — and expanding it ("THE PROM") would miss.
  const raw = tokens.join(' ');

  // Expand the trailing direction and type words to the City's codes.
  let dir = '';
  const lastD = tokens[tokens.length - 1];
  if (tokens.length > 1 && (DIRS.has(lastD) || DIR_ALIASES[lastD])) {
    dir = DIR_ALIASES[lastD] || lastD;
    tokens.pop();
  }
  let type = '';
  const lastT = tokens[tokens.length - 1];
  if (tokens.length > 1 && (TYPES.has(lastT) || TYPE_ALIASES[lastT])) {
    type = TYPE_ALIASES[lastT] || lastT;
    tokens.pop();
  }

  return { number, raw, name: tokens.join(' '), type, dir };
}

// ---- fuzzy street suggestions ---------------------------------------------

// Levenshtein distance, abandoned once every cell in a row exceeds `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// Up to `limit` real street keys whose name is closest to `name`.
function suggest(idx, name, limit = 5) {
  const max = name.length <= 4 ? 1 : name.length <= 8 ? 2 : 3;
  const scored = [];
  for (const [n, keys] of idx._byName) {
    // A typed prefix ("CORYD") is a strong hint on its own.
    const d = n.startsWith(name) ? 0 : editDistance(name, n, max);
    if (d <= max) scored.push([d, n.length, keys]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.flatMap(([, , keys]) => keys).slice(0, limit);
}

// ---- lookup ----------------------------------------------------------------

function areaAt(entry, number) {
  if (typeof entry === 'number') return entry;
  if (!Array.isArray(entry)) return null;
  const even = number % 2 === 0;
  // Prefer the matching side; fall back to the other when a street only has
  // addresses on one side.
  let runs = entry[even ? 0 : 1];
  if (!runs || !runs.length) runs = entry[even ? 1 : 0];
  if (!runs || !runs.length) return null;
  let lo = 0, hi = runs.length - 1, found = 0;
  while (lo <= hi) {                       // last run starting at or below `number`
    const mid = (lo + hi) >> 1;
    if (runs[mid][0] <= number) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return runs[found][1];
}

/**
 * Resolve free-typed input to its census areas.
 *
 * Success: { ok: true, number, street, neighbourhood, cluster, communityArea }
 * Failure: { ok: false, reason: 'empty'|'no-number'|'unknown-street'|'ambiguous'|'no-data',
 *            number, suggestions: [street key, …] }  — `number` is present
 *            whenever one was parsed, so the caller can rebuild the input from
 *            a suggestion.
 */
export function lookupAddress(idx, input) {
  if (!idx) return { ok: false, reason: 'no-data', suggestions: [] };
  if (!String(input || '').trim()) return { ok: false, reason: 'empty', suggestions: [] };

  const p = parseAddress(input);
  if (!p) return { ok: false, reason: 'no-number', suggestions: [] };

  // Literal first, then the type/direction-expanded form: "THE PROMENADE" is a
  // street name in its own right, and expanding it to "THE PROM" would miss.
  const full = [p.name, p.type, p.dir].filter(Boolean).join(' ');
  let key = idx._byCanon.get(p.raw) || idx._byCanon.get(full);

  if (!key) {
    // Typed a type or direction the City doesn't use on that street — fall back
    // to the bare name, which is unambiguous for the large majority of streets.
    for (const name of [p.name, p.raw]) {
      const candidates = idx._byName.get(name) || [];
      if (candidates.length === 1) { [key] = candidates; break; }
      if (candidates.length > 1)
        return { ok: false, reason: 'ambiguous', number: p.number, suggestions: candidates };
    }
  }

  if (!key) return { ok: false, reason: 'unknown-street', number: p.number,
                     suggestions: suggest(idx, p.name) };

  const ai = areaAt(idx.streets[key], p.number);
  const area = ai == null ? null : idx.areas[ai];
  if (!area) return { ok: false, reason: 'no-data', number: p.number, suggestions: [] };

  return {
    ok: true,
    number: p.number,
    street: key,
    neighbourhood: area[0] || null,
    cluster: area[1] || null,
    communityArea: area[2] || null,
  };
}
