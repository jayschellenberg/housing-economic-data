/*
 * fcc-data.js — pure helpers for the FCC Farmland tab: reshaping
 * fcc_farmland.json into card inputs, region tables and narrative lists.
 * No DOM here (tested in test/fcc-data.test.js).
 *
 * fcc_farmland.json (FCC-Farmland/ingest/parse_fcc.py):
 *   provinces:   [{ code, name }]                  CA first
 *   prov_change: [[year, prov, pct]]               annual % change, cultivated land
 *   regions:     [{ id, prov, name, land }]        land = cultivated | pasture
 *   region_obs:  [[year, regionId, value, pct, lo, hi, pub]]
 *                value = restated $/acre (historic report), pub = as printed that year,
 *                pct / lo / hi = that year's annual table (% change, 90% value range)
 *   narratives:  [{ year, period, prov, paras, report }]   period annual|spring|fall|mid
 *   reports:     [{ file, year, period, kind }]
 */

export const SOURCE = 'Farm Credit Canada, FCC Farmland Values Report';
export const CANADA = 'CA';
export const DEFAULT_PROV = 'MB';

export const GROUPS = [
  { id: 'change', label: 'Annual % Change' },
  { id: 'regions', label: 'Value by Region' },
  { id: 'table', label: 'Region Table' },
  { id: 'narrative', label: 'Report Narrative' },
];

export const LAND_LABEL = { cultivated: 'Cultivated land', pasture: 'Pastureland' };

// Spring reports looked back at July–December of the year before; fall
// reports at January–June. Annual reports (2013 on) cover the calendar year.
export const PERIOD_ORDER = ['annual', 'fall', 'mid', 'spring'];
export function periodLabel(year, period) {
  if (period === 'annual') return `${year} annual report (January–December ${year})`;
  if (period === 'mid') return `${year} mid-year update (January–June ${year})`;
  if (period === 'fall') return `Fall ${year} report (January–June ${year})`;
  if (period === 'spring') return `Spring ${year} report (July–December ${year - 1})`;
  return `${year} ${period}`;
}

export const isIrrigated = (r) => /irrigated/i.test(r.name);

export function provName(data, code) {
  return (data?.provinces || []).find(p => p.code === code)?.name || code;
}

/** prov → Map(year → pct). */
export function changeIndex(data) {
  const idx = new Map();
  for (const [y, p, v] of data?.prov_change || []) {
    if (!idx.has(p)) idx.set(p, new Map());
    idx.get(p).set(y, v);
  }
  return idx;
}

/** regionId → [{ year, value, pct, lo, hi, pub }] sorted by year. */
export function regionIndex(data) {
  const idx = new Map();
  for (const [year, id, value, pct, lo, hi, pub] of data?.region_obs || []) {
    if (!idx.has(id)) idx.set(id, []);
    idx.get(id).push({ year, value, pct, lo, hi, pub });
  }
  for (const arr of idx.values()) arr.sort((a, b) => a.year - b.year);
  return idx;
}

/**
 * A province's regions grouped for the charts: dryland cultivated, irrigated,
 * pastureland. Regions with no figure since `activeSince` (FCC's pre-2020
 * Ontario regions, Newfoundland's) are left out unless asked for.
 */
export function provRegions(data, rIdx, prov, { activeSince = null } = {}) {
  const out = { cultivated: [], irrigated: [], pasture: [] };
  for (const r of data?.regions || []) {
    if (r.prov !== prov) continue;
    const obs = rIdx.get(r.id) || [];
    if (!obs.some(o => o.value != null || o.pub != null)) continue;
    if (activeSince != null && !obs.some(o => o.year >= activeSince && (o.value != null || o.pub != null))) continue;
    const key = r.land === 'pasture' ? 'pasture' : isIrrigated(r) ? 'irrigated' : 'cultivated';
    out[key].push(r);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function years(data) {
  const ys = new Set((data?.prov_change || []).map(r => r[0]));
  for (const r of data?.region_obs || []) ys.add(r[0]);
  return [...ys].sort((a, b) => a - b);
}

/** Years an annual region table exists for (value ranges published). */
export function tableYears(data) {
  return [...new Set((data?.region_obs || []).filter(r => r[3] != null || r[4] != null).map(r => r[0]))].sort((a, b) => a - b);
}

const yDate = (y) => `${y}-01-01`;
const inRange = (y, { from, to }) => (from == null || y >= from) && (to == null || y <= to);

/** Card input for the provinces' % change: lines = [{ prov, label }]. */
export function changeCardInput(chartId, cIdx, lines, range = {}) {
  const records = [];
  const seriesMeta = [];
  for (const ln of lines) {
    const m = cIdx.get(ln.prov);
    if (!m) continue;
    const id = `${chartId}:${ln.prov}`;
    const pts = [...m.entries()].filter(([y, v]) => v != null && inRange(y, range)).sort((a, b) => a[0] - b[0]);
    if (!pts.length) continue;
    for (const [y, v] of pts) records.push({ id, date: yDate(y), value: v });
    seriesMeta.push({ id, chartLabel: ln.label, units: 'percent', provider: 'local', frequency: 'annual' });
  }
  return { records, seriesMeta };
}

/**
 * Card input for regional $/acre: the restated series (`value`), falling
 * back to the as-published figure only for regions the historic report does
 * not carry (the parser already put those in `value`). A gap of more than a
 * year breaks the line.
 */
export function regionCardInput(chartId, rIdx, regions, range = {}) {
  const records = [];
  const seriesMeta = [];
  for (const r of regions) {
    const id = `${chartId}:${r.id}`;
    const pts = (rIdx.get(r.id) || []).filter(o => o.value != null && inRange(o.year, range));
    if (!pts.length) continue;
    pts.forEach((o, i) => {
      if (i && o.year - pts[i - 1].year > 1) records.push({ id, date: yDate(pts[i - 1].year + 1), value: null });
      records.push({ id, date: yDate(o.year), value: o.value });
    });
    seriesMeta.push({ id, chartLabel: r.name, units: 'dollar', provider: 'local', frequency: 'annual' });
  }
  return { records, seriesMeta };
}

/** Rows of the annual region table for one province and year. */
export function regionTableRows(rIdx, regions, year) {
  const rows = [];
  for (const r of regions) {
    const o = (rIdx.get(r.id) || []).find(x => x.year === year);
    if (!o || (o.pct == null && o.pub == null && o.value == null)) continue;
    rows.push({ region: r, value: o.pub ?? o.value, pct: o.pct, lo: o.lo, hi: o.hi });
  }
  return rows;
}

/** A table of % change by year for the given provinces (latest year first). */
export function changeTable(cIdx, provs, { from = null, to = null } = {}) {
  const ys = new Set();
  for (const p of provs) for (const y of cIdx.get(p)?.keys() || []) if (inRange(y, { from, to })) ys.add(y);
  return [...ys].sort((a, b) => b - a).map(y => ({ year: y, values: provs.map(p => cIdx.get(p)?.get(y) ?? null) }));
}

/** Narratives for a province, newest first; annual before mid-year within a year. */
export function narrativesFor(data, prov) {
  return (data?.narratives || []).filter(n => n.prov === prov)
    .sort((a, b) => b.year - a.year || PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period));
}

/** Years with a narrative for the province, newest first. */
export function narrativeYears(data, prov) {
  return [...new Set(narrativesFor(data, prov).map(n => n.year))];
}

/**
 * Split a paragraph into text and region-name runs so the tab can bold the
 * regions the narrative explains: [{ text, region: bool }]. Longest names win
 * ("Westman and Central Plains-Pembina Valley" before "Westman").
 */
export function markRegions(text, names) {
  const uniq = [...new Set(names.map(n => n.replace(/\s*\((irrigated)\)\s*$/i, '')))]
    .filter(n => n.length > 3)
    .sort((a, b) => b.length - a.length);
  if (!uniq.length) return [{ text, region: false }];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\u2010-\u2015 ]+');
  const re = new RegExp(`\\b(${uniq.map(esc).join('|')})\\b`, 'g');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), region: false });
    out.push({ text: m[0], region: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), region: false });
  return out;
}

/** "$1,500" */
export const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? '**' : `$${Math.round(v).toLocaleString('en-CA')}`);
/** "9.3%" — FCC publishes one decimal. */
export const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '**' : `${v.toFixed(1)}%`);
export const fmtRange = (lo, hi) => (lo == null || hi == null ? '**' : `${fmtMoney(lo)} – ${fmtMoney(hi)}`);
