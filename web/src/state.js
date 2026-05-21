/*
 * URL state encoder/decoder. Serialises the active filter set into the
 * browser's query string so a copied URL restores the same view.
 *
 * Adapted from MBOpenData/WebSearch/web/src/lib/urlState.js — same
 * schema-driven pattern, with the keys reduced to what this app needs.
 * Unknown params are ignored; malformed values are silently dropped.
 */

const STRING_MAX = 80;

function cleanString(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t.length > STRING_MAX) return undefined;
  return t;
}

function cleanInt(min, max) {
  return (v) => {
    if (typeof v !== 'string') return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) return undefined;
    return n;
  };
}

function oneOf(allowed) {
  const set = new Set(allowed);
  return (v) => (typeof v === 'string' && set.has(v) ? v : undefined);
}

export const SCHEMA = {
  geoLevel:     { param: 'gl', validate: oneOf(['province','cma','csd','zone','neighbourhood']), format: (v) => v },
  geoUid:       { param: 'gu', validate: cleanString,                  format: (v) => v },
  dwellingType: { param: 'dw', validate: oneOf(['All','Apartment','Row']), format: (v) => v },
  season:       { param: 's',  validate: oneOf(['April','October']),   format: (v) => v },
  yearFrom:     { param: 'yf', validate: cleanInt(1990, 2100),         format: (v) => String(v) },
  yearTo:       { param: 'yt', validate: cleanInt(1990, 2100),         format: (v) => String(v) },
  breakdown:    { param: 'bd', validate: oneOf(['Bedroom Type','Year of Construction','Structure Size','Rent Ranges']), format: (v) => v },
};

const PARAM_TO_KEY = Object.fromEntries(
  Object.entries(SCHEMA).map(([k, def]) => [def.param, k])
);

export function encodeState(state) {
  if (!state || typeof state !== 'object') return '';
  const usp = new URLSearchParams();
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (!(key in state)) continue;
    const v = state[key];
    if (v == null || v === '') continue;
    const formatted = def.format(v);
    if (formatted == null || formatted === '') continue;
    usp.set(def.param, formatted);
  }
  return usp.toString();
}

export function decodeState(search) {
  const result = {};
  if (search == null) return result;
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  if (!raw) return result;
  let usp;
  try { usp = new URLSearchParams(raw); } catch { return result; }
  for (const [param, value] of usp.entries()) {
    const key = PARAM_TO_KEY[param];
    if (!key) continue;
    const parsed = SCHEMA[key].validate(value);
    if (parsed === undefined) continue;
    result[key] = parsed;
  }
  return result;
}

export function syncURL(state) {
  const qs = encodeState(state);
  const next = qs ? `?${qs}` : window.location.pathname;
  window.history.replaceState(null, '', next);
}
