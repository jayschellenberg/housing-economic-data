/*
 * bands.js — the space-type palette and labels shared by the map, the
 * legend, the analysis charts and the KPI tiles, so a type is the same
 * colour everywhere.
 *
 * The band here is space_type, which is what the tracker actually
 * distinguishes. Listing type (Sale / Lease) is a separate axis and is
 * never folded into the colour: a retail lease and a retail sale are the
 * same kind of space quoted in different units.
 */

export const BAND_ORDER = Object.freeze([
  'Office', 'Industrial', 'Retail', 'Land', 'Investment', 'Mixed',
]);

export const BAND_COLORS = Object.freeze({
  Office: '#2a78d6',
  Industrial: '#7c3aed',
  Retail: '#1baf7a',
  Land: '#9a7b21',
  Investment: '#eb6834',
  Mixed: '#b42318',
  unknown: '#898781',
});

export const BAND_LABELS = Object.freeze({
  Office: 'Office',
  Industrial: 'Industrial',
  Retail: 'Retail',
  Land: 'Land',
  Investment: 'Investment',
  Mixed: 'Mixed',
  unknown: 'Unspecified',
  all: 'All',
});

/** The palette key for a record — its space type, or 'unknown'. A type
 *  the bundle introduces later falls back rather than disappearing. */
export function bandOf(record) {
  const t = record?.space_type;
  return t && BAND_COLORS[t] ? t : 'unknown';
}

/** Legend rows: only the types actually present, in the order above,
 *  with anything unrecognised last. */
export function legendFor(records) {
  const present = new Set((records || []).map(bandOf));
  const keys = BAND_ORDER.filter((k) => present.has(k));
  if (present.has('unknown')) keys.push('unknown');
  return keys.map((key) => ({ key, label: BAND_LABELS[key], color: BAND_COLORS[key] }));
}
