/*
 * yardi-data.js — pure helpers for the Yardi Rental tab: the chart catalogue
 * and the reshaping of yardi.json's flat observations into card inputs and
 * quarter tables. No DOM here (tested in test/yardi-data.test.js).
 *
 * yardi.json (Yardi-Rental/ingest/parse_yardi.py):
 *   editions: [{ id: '2026Q2', label: 'Q2 2026', cover: 'Q3 2026', ... }]
 *   obs:      [[quarter, geo, segment, metric, value, src, edition], ...]
 *     segment  total | bachelor | 1br | 2br | 3br
 *     src      't' = read from a table (exact), 'c' = measured off a chart
 */

export const SOURCE = 'Yardi Canadian National Multifamily Report';

export const CMAS = ['National', 'Winnipeg', 'Saskatoon', 'Calgary', 'Edmonton', 'Vancouver',
  'Toronto', 'Hamilton', 'Kitchener–Cambridge–Waterloo', 'London', 'Ottawa–Gatineau', 'Montreal', 'Halifax'];
export const DEFAULT_CENTRES = ['Winnipeg', 'National'];
/** Charts open here: Q3 2023 data is the first with bedroom-type detail. */
export const DEFAULT_FROM = '2023Q3';

export const PROVINCES = ['National', 'Manitoba', 'Saskatchewan', 'Alberta', 'British Columbia', 'Ontario', 'Quebec', 'Nova Scotia'];
/** The province a CMA sits in, for highlighting the expense rows. */
export const CMA_PROVINCE = {
  National: 'National', Winnipeg: 'Manitoba', Saskatoon: 'Saskatchewan', Calgary: 'Alberta', Edmonton: 'Alberta',
  Vancouver: 'British Columbia', Toronto: 'Ontario', Hamilton: 'Ontario', 'Kitchener–Cambridge–Waterloo': 'Ontario',
  London: 'Ontario', 'Ottawa–Gatineau': 'Ontario', Montreal: 'Quebec', Halifax: 'Nova Scotia',
};

export const SEGMENTS = [
  { id: 'bachelor', label: 'Bachelor' },
  { id: '1br', label: '1-Bedroom' },
  { id: '2br', label: '2-Bedroom' },
  { id: '3br', label: '3-Bedroom' },
];

export const METRICS = {
  rent:           { label: 'In-Place Rent', units: 'dollar' },
  rent_yoy:       { label: 'In-Place Rent Change (Y/Y)', units: 'percent' },
  lol:            { label: 'New-Lease Rent Change', units: 'percent' },
  vacancy:        { label: 'Vacancy Rate', units: 'percent' },
  turnover:       { label: 'Annual Turnover', units: 'percent' },
  turnover_q:     { label: 'Quarterly Turnover', units: 'percent' },
  renewal:        { label: 'Expiring-Lease Renewal', units: 'percent' },
  stay:           { label: 'Length of Stay', units: 'months' },
  digital_conv:   { label: 'Digital Prospect Conversion', units: 'percent' },
  digital_per100: { label: 'Digital Prospects per 100 Units', units: 'units' },
  exp_rm:         { label: 'Repairs & Maintenance', units: 'dollar' },
  exp_ctrl:       { label: 'Controllable Expense', units: 'dollar' },
  exp_total:      { label: 'Total Expense', units: 'dollar' },
};

export const GROUPS = [
  { id: 'total',    label: 'Rents, Vacancy & Turnover' },
  { id: 'bedroom',  label: 'By Unit Type' },
  { id: 'tables',   label: 'Quarter Table' },
  { id: 'leasing',  label: 'Length of Stay' },
  { id: 'expense',  label: 'Operating Expenses by Province' },
];

/** All-units trend charts: one line per selected centre. */
export const CENTRE_CHARTS = [
  // withNational: National is always drawn beside the centre (Jason, 2026-10-07;
  // vacancy and turnover added the same day).
  { id: 'rent', group: 'total', metric: 'rent', title: 'Average In-Place Rent', withNational: true,
    subtitle: 'All units; read off the report’s history chart (approximate)' },
  { id: 'rent_yoy', group: 'total', metric: 'rent_yoy', title: 'In-Place Rent Change, Year over Year', withNational: true },
  // "Lease over lease" sits in the subtitle so the title fits one line.
  { id: 'lol', group: 'total', metric: 'lol', title: 'New-Lease Rent Change', subtitle: 'Lease over lease', withNational: true },
  { id: 'vacancy', group: 'total', metric: 'vacancy', title: 'Apartment Vacancy Rate', withNational: true },
  { id: 'turnover', group: 'total', metric: 'turnover', title: 'Annual Tenant Turnover', withNational: true },
  { id: 'stay', group: 'leasing', metric: 'stay', title: 'Average Resident Length of Stay', subtitle: 'Months' },
];

/** Per-centre bedroom charts: one line per bedroom type. */
export const BEDROOM_CHARTS = [
  { id: 'rent', metric: 'rent', title: 'In-Place Rent by Unit Type' },
  { id: 'lol', metric: 'lol', title: 'New-Lease Rent Change by Unit Type' },
  { id: 'vacancy', metric: 'vacancy', title: 'Vacancy Rate by Unit Type' },
  { id: 'turnover', metric: 'turnover', title: 'Annual Turnover by Unit Type' },
];

export const EXPENSE_METRICS = ['exp_rm', 'exp_ctrl', 'exp_total'];

// --- Quarters ---------------------------------------------------------------

export const qOrd = (q) => Number(q.slice(0, 4)) * 4 + Number(q.slice(-1)) - 1;
export const qLabel = (q) => `Q${q.slice(-1)} ${q.slice(0, 4)}`;
/** The ISO date the cards plot a quarter at: its first day. */
export const qDate = (q) => `${q.slice(0, 4)}-${String((Number(q.slice(-1)) - 1) * 3 + 1).padStart(2, '0')}-01`;

// --- Observations -----------------------------------------------------------

/** Map "geo|segment|metric" → [{ q, v, src, ed }] sorted by quarter. */
export function indexObs(data) {
  const m = new Map();
  for (const [q, geo, seg, metric, v, src, ed] of data?.obs || []) {
    const k = `${geo}|${seg}|${metric}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ q, v, src, ed });
  }
  for (const arr of m.values()) arr.sort((a, b) => qOrd(a.q) - qOrd(b.q));
  return m;
}

/** Points for one series, limited to quarters in [from, to] (either may be null). */
export function seriesPoints(index, geo, seg, metric, { from = null, to = null } = {}) {
  return (index.get(`${geo}|${seg}|${metric}`) || [])
    .filter(p => (!from || qOrd(p.q) >= qOrd(from)) && (!to || qOrd(p.q) <= qOrd(to)));
}

/**
 * Card input for buildIndicatorCard: { records, seriesMeta, approx } where
 * lines = [{ label, geo, seg, metric }]. Quarters with no figure between two
 * that have one get a null record so the line breaks — unless `bridge`, when
 * the line joins the quarters either side.
 * `approx` lists the chart-read quarters per line, for the About note.
 */
export function toCardInput(chartId, index, lines, { bridge = false, ...range } = {}) {
  const records = [];
  const seriesMeta = [];
  const approx = [];
  for (const ln of lines) {
    const pts = seriesPoints(index, ln.geo, ln.seg, ln.metric, range);
    if (!pts.filter(p => Number.isFinite(p.v)).length) continue;
    const id = `${chartId}:${ln.label}`;
    const have = new Map(pts.map(p => [qOrd(p.q), p]));
    const lo = Math.min(...have.keys()), hi = Math.max(...have.keys());
    for (let o = lo; o <= hi; o++) {
      const q = `${Math.floor(o / 4)}Q${(o % 4) + 1}`;
      const p = have.get(o);
      if (p || !bridge) records.push({ id, date: qDate(q), value: p ? p.v : null });
    }
    seriesMeta.push({
      id, chartLabel: ln.label, units: METRICS[ln.metric]?.units || 'index',
      provider: 'local', frequency: 'quarterly', geo: ln.geo,
    });
    const c = pts.filter(p => p.src === 'c').map(p => p.q);
    if (c.length) approx.push({ label: ln.label, quarters: c });
  }
  return { records, seriesMeta, approx };
}

/** "Q1 2020–Q3 2021, Q1 2022" from a sorted list of quarters. */
export function quarterRanges(qs) {
  const sorted = [...new Set(qs)].sort((a, b) => qOrd(a) - qOrd(b));
  const out = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last && qOrd(q) === qOrd(last[1]) + 1) last[1] = q;
    else out.push([q, q]);
  }
  return out.map(([a, b]) => (a === b ? qLabel(a) : `${qLabel(a)}–${qLabel(b)}`)).join(', ');
}

/** Quarters that have any observation, oldest first. */
export function quarterList(data) {
  return [...new Set((data?.obs || []).map(r => r[0]))].sort((a, b) => qOrd(a) - qOrd(b));
}

/** The value of one cell, or null. */
export function valueAt(index, geo, seg, metric, q) {
  const p = (index.get(`${geo}|${seg}|${metric}`) || []).find(x => x.q === q);
  return p && Number.isFinite(p.v) ? p.v : null;
}

/**
 * A quarter table: rows = geos, columns = metrics present that quarter for
 * the segment. Columns with no figure at all are dropped, so an edition's own
 * layout (renewal % in 2021, quarterly turnover in 2022) shows as printed.
 * Only table figures (src 't') count — chart readings never fill a table.
 */
export function quarterTable(index, { geos, seg, metrics, q }) {
  const cell = (geo, m) => {
    const p = (index.get(`${geo}|${seg}|${m}`) || []).find(x => x.q === q && x.src === 't');
    return p && Number.isFinite(p.v) ? p.v : null;
  };
  const cols = metrics.filter(m => geos.some(g => cell(g, m) != null));
  const rows = geos.map(g => ({ geo: g, values: cols.map(m => cell(g, m)) }))
    .filter(r => r.values.some(v => v != null));
  return { cols, rows };
}

/**
 * The expense edition to show for a quarter: the latest quarter at or before
 * it that has expense readings (the charts began with the Q3 2025 data).
 */
export function expenseQuarter(index, q) {
  let best = null;
  for (const [k, pts] of index) {
    if (!k.endsWith('|total|exp_total')) continue;
    for (const p of pts) {
      if (qOrd(p.q) <= qOrd(q) && (!best || qOrd(p.q) > qOrd(best))) best = p.q;
    }
  }
  return best;
}
