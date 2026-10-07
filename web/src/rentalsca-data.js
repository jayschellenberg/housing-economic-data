/*
 * rentalsca-data.js — pure helpers for the Rentals.ca tab: the chart
 * catalogue and the reshaping of rentalsca.json's flat observations into
 * card inputs and month tables. No DOM here (tested in
 * test/rentalsca-data.test.js).
 *
 * rentalsca.json (RentalsCa/ingest/parse_rentalsca.py):
 *   months:  ['2024-01', ...]          data months (report month − 1)
 *   reports: [{ month, title, captured }]
 *   city_province: { Winnipeg: 'Manitoba', ... }
 *   obs: [[month, geo, level, segment, unit, metric, value, src, report], ...]
 *     level    city | province | national
 *     segment  all | ac | apt | condo | house
 *     unit     total | 0br | 1br | 2br | 3br
 *     metric   rent | mom | yoy
 *     src      't' = report table, 'd' = derived from a neighbouring month's change
 */

export const SOURCE = 'Rentals.ca & Urbanation National Rent Report';
export const CANADA = 'Canada';
export const DEFAULT_CENTRES = ['Winnipeg', CANADA];

export const SEGMENTS = {
  all: 'All property types',
  ac: 'Apartments & condos',
};

// Bedroom types first, All units last, as the CMHC charts order them.
export const UNITS = [
  { id: '0br', label: 'Studio' },
  { id: '1br', label: '1-Bedroom' },
  { id: '2br', label: '2-Bedroom' },
  { id: '3br', label: '3-Bedroom' },
  { id: 'total', label: 'All units' },
];
export const UNIT_LABEL = Object.fromEntries(UNITS.map(u => [u.id, u.label]));

export const PROPERTY_TYPES = [
  { id: 'all', label: 'All property types' },
  { id: 'apt', label: 'Purpose-built apartments' },
  { id: 'condo', label: 'Condo apartments' },
  { id: 'house', label: 'Houses & townhouses' },
];

export const GROUPS = [
  { id: 'city', label: 'Asking Rents by Centre' },
  { id: 'province', label: 'Asking Rents by Province' },
  { id: 'national', label: 'Canada by Property Type' },
  { id: 'tables', label: 'Month Table' },
];

// --- Months -----------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
export const mOrd = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
export const mLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const mDate = (m) => `${m}-01`;
const fromOrd = (o) => `${Math.floor(o / 12)}-${String((o % 12) + 1).padStart(2, '0')}`;
/** The report a data month was published in: the following month. */
export const reportMonth = (m) => fromOrd(mOrd(m) + 1);

// --- Observations ----------------------------------------------------------

const key = (level, geo, seg, unit, metric) => `${level}|${geo}|${seg}|${unit}|${metric}`;

/** Map "level|geo|segment|unit|metric" → [{ m, v, src }] sorted by month. */
export function indexObs(data) {
  const idx = new Map();
  for (const [m, geo, level, seg, unit, metric, v, src] of data?.obs || []) {
    const k = key(level, geo, seg, unit, metric);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ m, v, src });
  }
  for (const arr of idx.values()) arr.sort((a, b) => mOrd(a.m) - mOrd(b.m));
  return idx;
}

/**
 * Where a centre's figures live. Cities are rows of the city table; Canada
 * is the national "All" row for all property types, or the province table's
 * Canada row for apartments & condos (the national table has no A&C row).
 */
export function centreSource(centre, seg) {
  if (centre !== CANADA) return { level: 'city', geo: centre, seg };
  return seg === 'ac' ? { level: 'province', geo: CANADA, seg: 'ac' } : { level: 'national', geo: CANADA, seg: 'all' };
}

export function points(index, { level, geo, seg, unit, metric }, { from = null, to = null } = {}) {
  return (index.get(key(level, geo, seg, unit, metric)) || [])
    .filter(p => (!from || mOrd(p.m) >= mOrd(from)) && (!to || mOrd(p.m) <= mOrd(to)));
}

export function valueAt(index, spec, m) {
  const p = (index.get(key(spec.level, spec.geo, spec.seg, spec.unit, spec.metric)) || []).find(x => x.m === m);
  return p && Number.isFinite(p.v) ? p : null;
}

/**
 * Card input for buildIndicatorCard: lines = [{ label, level, geo, seg,
 * unit, metric, units }]. Lines join across one or two months with no
 * figure (a report the Archive did not keep) but break across a longer gap,
 * where a table stopped carrying the series (studio rents for apartments &
 * condos, late 2025 to mid 2026). `derived` lists each line's estimated months.
 */
export const MAX_JOIN_GAP = 2;

export function toCardInput(chartId, index, lines, range = {}) {
  const records = [];
  const seriesMeta = [];
  const derived = [];
  for (const ln of lines) {
    const pts = points(index, ln, range).filter(p => Number.isFinite(p.v));
    if (!pts.length) continue;
    const id = `${chartId}:${ln.label}`;
    pts.forEach((p, i) => {
      if (i && mOrd(p.m) - mOrd(pts[i - 1].m) > MAX_JOIN_GAP + 1) {
        records.push({ id, date: mDate(fromOrd(mOrd(pts[i - 1].m) + 1)), value: null });
      }
      records.push({ id, date: mDate(p.m), value: p.v });
    });
    seriesMeta.push({ id, chartLabel: ln.label, units: ln.units || 'dollar', provider: 'local', frequency: 'monthly', geo: ln.geo });
    const d = pts.filter(p => p.src === 'd').map(p => p.m);
    if (d.length) derived.push({ label: ln.label, months: d });
  }
  return { records, seriesMeta, derived };
}

/** "January–February 2024, October 2025" from a list of months. */
export function monthRanges(ms) {
  const sorted = [...new Set(ms)].sort((a, b) => mOrd(a) - mOrd(b));
  const runs = [];
  for (const m of sorted) {
    const last = runs[runs.length - 1];
    if (last && mOrd(m) === mOrd(last[1]) + 1) last[1] = m;
    else runs.push([m, m]);
  }
  return runs.map(([a, b]) => {
    if (a === b) return mLabel(a);
    return a.slice(0, 4) === b.slice(0, 4)
      ? `${MONTHS[Number(a.slice(5, 7)) - 1]}–${mLabel(b)}`
      : `${mLabel(a)}–${mLabel(b)}`;
  }).join(', ');
}

/** Cities in the data, by name. */
export function cityList(data) {
  return [...new Set((data?.obs || []).filter(r => r[2] === 'city').map(r => r[1]))].sort((a, b) => a.localeCompare(b));
}

/** Months in the data that a report actually covers (not only estimates). */
export function reportedMonths(data) {
  return new Set((data?.reports || []).map(r => r.month));
}
