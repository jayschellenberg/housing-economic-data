/*
 * brokerage-data.js — pure helpers for the Brokerage Reports tab: reshaping
 * brokerage.json (Brokerage-Reports/ingest/parse_brokerage.py) into card
 * inputs and tables. No DOM here (tested in test/brokerage-data.test.js).
 *
 * brokerage.json:
 *   sources:     [{ id, publisher, sector, period, file, folder }]
 *   obs:         [{ publisher, sector, period, date, geo, segment, metric,
 *                   value, unit, src, page, flag }]
 *                flag '' | 'prev_q' | 'prev_y' | 'headline' | 'ocr' |
 *                     'approx_map' | 'forecast|edition=YYYYQn' (a | joins several)
 *   metrics:     { metric: { label, unit } }        unit pct | sf | psf | cad | count
 *   definitions: { publisher: text }
 *   missing:     [{ publisher, sector, period, reason }]   reason 'no file' | 'not published'
 *   qc:          [{ publisher, sector, period, file, note }]
 */

export const SOURCE = 'Brokerage market reports (Capital Group, Colliers, CBRE, Avison Young)';

export const SECTORS = [
  { id: 'industrial', label: 'Industrial' },
  { id: 'office', label: 'Office' },
  { id: 'retail', label: 'Retail' },
  { id: 'hotel', label: 'Hotels' },
];

// Cards per sector, in page order. A metric no publisher printed for the
// selection draws nothing.
export const SECTOR_METRICS = {
  industrial: ['vacancy_rate', 'availability_rate', 'asking_net_rent_psf', 'absorption_sf', 'absorption_ytd_sf',
               'new_supply_sf', 'under_construction_sf', 'inventory_sf', 'vacant_sf', 'available_sf',
               'sublease_vacant_sf', 'additional_rent_psf', 'asking_price_psf', 'asking_gross_rent_psf'],
  office: ['vacancy_rate', 'asking_net_rent_psf', 'absorption_sf', 'absorption_ytd_sf', 'new_supply_sf',
           'under_construction_sf', 'inventory_sf', 'vacant_sf', 'direct_vacant_sf', 'sublease_vacant_sf',
           'additional_rent_psf', 'asking_gross_rent_psf', 'buildings'],
  retail: ['vacancy_rate', 'asking_net_rent_psf', 'additional_rent_psf', 'inventory_sf', 'gla_sf', 'sales_psf'],
  hotel: ['occupancy', 'adr', 'revpar', 'occupancy_yoy', 'adr_yoy', 'revpar_yoy'],
};

// brokerage.json unit -> indicator-chart formatter name (format.js INDICATOR_FMT).
export const UNIT_FMT = { pct: 'percent', psf: 'dollar_psf', sf: 'sf', cad: 'dollar', count: 'units' };

// Which obs are the publisher's market total for a sector — the default
// "compare publishers" lines. Office totals are the "All" class row where the
// publisher prints classes.
export const TOTAL_SEGMENT = { industrial: '', office: 'All', retail: '', hotel: '' };
export const TOTAL_GEO = 'Winnipeg';

/** Publishers in a fixed display order; anything new goes after. */
export const PUBLISHER_ORDER = ['Capital Group', 'Colliers', 'Colliers (national snapshot)', 'CBRE', 'CBRE Hotels', 'Avison Young'];

const FLAG_SKIP = new Set(['prev_q', 'prev_y']);

export function flagParts(flag) {
  return String(flag || '').split('|').filter(Boolean);
}
export function isForecast(flag) {
  return flagParts(flag).some(p => p === 'forecast');
}
function editionOf(flag) {
  const p = flagParts(flag).find(x => x.startsWith('edition='));
  return p ? p.slice(8) : '';
}

export const seriesKey = (o, variant = '') => [o.publisher, o.sector, o.geo, o.segment, o.metric, variant].join('|');

/**
 * Map(seriesKey -> { publisher, sector, geo, segment, metric, variant,
 * points: [{ period, date, value, src, flag }] sorted by date }).
 * variant '' = published actuals; 'forecast:YYYYQn' = that edition's forecast.
 * Prior-quarter restatements (prev_q / prev_y) are left out.
 */
export function seriesIndex(data) {
  const idx = new Map();
  for (const o of data?.obs || []) {
    const parts = flagParts(o.flag);
    if (parts.some(p => FLAG_SKIP.has(p))) continue;
    const variant = isForecast(o.flag) ? `forecast:${editionOf(o.flag)}` : '';
    const k = seriesKey(o, variant);
    if (!idx.has(k)) idx.set(k, { publisher: o.publisher, sector: o.sector, geo: o.geo, segment: o.segment, metric: o.metric, variant, points: [] });
    idx.get(k).points.push({ period: o.period, date: o.date, value: o.value, src: o.src, flag: o.flag });
  }
  for (const s of idx.values()) s.points.sort((a, b) => a.date.localeCompare(b.date));
  return idx;
}

/** Publishers that print anything for the sector, in display order. */
export function publishersFor(idx, sector) {
  const set = new Set();
  for (const s of idx.values()) if (s.sector === sector) set.add(s.publisher);
  return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
const rank = (p) => { const i = PUBLISHER_ORDER.indexOf(p); return i < 0 ? 99 : i; };

/** [{ geo, segment, label }] a publisher prints for a sector, totals first. */
export function areasFor(idx, sector, publisher) {
  const seen = new Map();
  for (const s of idx.values()) {
    if (s.sector !== sector || s.publisher !== publisher) continue;
    const k = `${s.geo}|${s.segment}`;
    if (!seen.has(k)) seen.set(k, { geo: s.geo, segment: s.segment, label: areaLabel(s.geo, s.segment) });
  }
  const isTotal = (a) => a.geo === TOTAL_GEO && a.segment === TOTAL_SEGMENT[sector];
  return [...seen.values()].sort((a, b) => (isTotal(b) - isTotal(a)) || a.label.localeCompare(b.label));
}

export function areaLabel(geo, segment) {
  if (!segment || segment === 'All') return geo === TOTAL_GEO ? 'Winnipeg (total)' : geo;
  return `${geo} ${segment}`;
}

/** The sector's "market total" line for each publisher that has one. */
export function totalLines(idx, sector) {
  return publishersFor(idx, sector)
    .map(p => ({ publisher: p, geo: TOTAL_GEO, segment: TOTAL_SEGMENT[sector] }))
    .filter(l => [...idx.values()].some(s => s.sector === sector && s.publisher === l.publisher && s.geo === l.geo && s.segment === l.segment));
}

const inRange = (period, { from, to }) => (from == null || Number(period.slice(0, 4)) >= from) && (to == null || Number(period.slice(0, 4)) <= to);

/**
 * Card input for one metric: lines = [{ publisher, geo, segment, label? }].
 * Each line's actual series is one chart series; a hotel line also gets a
 * dashed-style series per forecast edition when `forecasts` is true.
 * Returns { records, seriesMeta, dashedIds, flags } — flags names the caveats
 * (ocr / approx_map / headline) found in the points drawn.
 */
export function cardInput(chartId, idx, sector, metric, lines, range = {}, { forecasts = false } = {}) {
  const records = [];
  const seriesMeta = [];
  const dashedIds = [];
  const flags = new Set();
  let units = 'index';
  for (const ln of lines) {
    const variants = [''];
    if (forecasts) {
      for (const s of idx.values()) {
        if (s.sector === sector && s.publisher === ln.publisher && s.geo === ln.geo && s.segment === ln.segment && s.metric === metric && s.variant) variants.push(s.variant);
      }
    }
    for (const variant of variants) {
      const s = idx.get(seriesKey({ publisher: ln.publisher, sector, geo: ln.geo, segment: ln.segment, metric }, variant));
      if (!s) continue;
      const pts = s.points.filter(p => p.value != null && inRange(p.period, range));
      if (!pts.length) continue;
      const id = `${chartId}:${ln.publisher}:${ln.geo}:${ln.segment}:${variant}`;
      const base = ln.label || `${ln.publisher} — ${areaLabel(ln.geo, ln.segment)}`;
      const label = variant ? `${base} (forecast, ${variant.slice(9)} edition)` : base;
      for (const p of pts) {
        records.push({ id, date: p.date, value: p.value });
        for (const f of flagParts(p.flag)) if (!['forecast'].includes(f) && !f.startsWith('edition=')) flags.add(f);
      }
      units = unitFor(idx, metric);
      seriesMeta.push({ id, chartLabel: label, units, provider: 'local', frequency: sector === 'hotel' ? 'annual' : 'quarterly', geo: ln.geo });
      if (variant) dashedIds.push(id);
    }
  }
  return { records, seriesMeta, dashedIds, flags: [...flags].sort() };
}

export function unitFor(idx, metric) {
  for (const s of idx.values()) if (s.metric === metric && s.points.length) return UNIT_FMT[unitOfMetric(metric)] || 'index';
  return 'index';
}
// Mirrors METRICS in ingest/common.py; the JSON's `metrics` block is the
// authority when loaded, this is the fallback for a chart with no data yet.
const UNITS = {
  vacancy_rate: 'pct', availability_rate: 'pct', occupancy: 'pct', occupancy_yoy: 'pct', adr_yoy: 'pct', revpar_yoy: 'pct',
  asking_net_rent_psf: 'psf', asking_gross_rent_psf: 'psf', additional_rent_psf: 'psf', asking_price_psf: 'psf', sales_psf: 'psf',
  adr: 'cad', revpar: 'cad', buildings: 'count',
};
export const unitOfMetric = (m) => UNITS[m] || 'sf';

export function metricLabel(data, metric) {
  return data?.metrics?.[metric]?.label || metric;
}

/** The periods a set of series spans, newest first. */
export function periodsOf(seriesList) {
  const ps = new Set();
  for (const s of seriesList) for (const p of s.points) ps.add(p.period);
  return [...ps].sort().reverse();
}

/**
 * Rows for a "latest figures" table: one per line, the last `n` periods any
 * of the lines has. Cells are the published values (null = not published).
 */
export function latestTable(idx, sector, metric, lines, n = 6) {
  const series = lines.map(ln => ({ ln, s: idx.get(seriesKey({ publisher: ln.publisher, sector, geo: ln.geo, segment: ln.segment, metric }, '')) })).filter(x => x.s);
  const periods = periodsOf(series.map(x => x.s)).slice(0, n);
  const rows = series.map(({ ln, s }) => {
    const byP = new Map(s.points.map(p => [p.period, p]));
    return {
      label: ln.label || `${ln.publisher} — ${areaLabel(ln.geo, ln.segment)}`,
      values: periods.map(p => byP.get(p)?.value ?? null),
      flags: periods.map(p => flagParts(byP.get(p)?.flag).filter(f => f !== 'headline')),
    };
  });
  return { periods, rows };
}

export function periodLabel(period) {
  const m = /^(\d{4})Q([1-4])$/.exec(period);
  return m ? `Q${m[2]} ${m[1]}` : period;
}

/** Report coverage per publisher and sector: editions on disk and the gaps. */
export function coverage(data) {
  const by = new Map();
  for (const s of data?.sources || []) {
    for (const sec of String(s.sector).split('+')) {
      const k = `${s.publisher}|${sec}`;
      if (!by.has(k)) by.set(k, { publisher: s.publisher, sector: sec, periods: new Set(), missing: [], unpublished: [] });
      by.get(k).periods.add(s.period);
    }
  }
  for (const m of data?.missing || []) {
    const k = `${m.publisher}|${m.sector}`;
    if (!by.has(k)) by.set(k, { publisher: m.publisher, sector: m.sector, periods: new Set(), missing: [], unpublished: [] });
    by.get(k)[m.reason === 'not published' ? 'unpublished' : 'missing'].push(m.period);
  }
  return [...by.values()].map(r => ({
    publisher: r.publisher, sector: r.sector,
    editions: r.periods.size,
    first: [...r.periods].sort()[0] || '',
    last: [...r.periods].sort().slice(-1)[0] || '',
    missing: r.missing.sort(),
    // quarters the publisher never posted (checked on its website)
    unpublished: r.unpublished.sort(),
  })).sort((a, b) => a.sector.localeCompare(b.sector) || rank(a.publisher) - rank(b.publisher));
}

export function years(idx) {
  const ys = new Set();
  for (const s of idx.values()) for (const p of s.points) ys.add(Number(p.period.slice(0, 4)));
  return [...ys].sort((a, b) => a - b);
}

export const fmtValue = (v, unit) => {
  if (v == null || !Number.isFinite(v)) return '**';
  if (unit === 'pct') return `${v.toFixed(1)}%`;
  if (unit === 'psf') return `$${v.toFixed(2)}`;
  if (unit === 'cad') return `$${Math.round(v).toLocaleString()}`;
  if (unit === 'count') return Math.round(v).toLocaleString();
  return Math.round(v).toLocaleString();
};
