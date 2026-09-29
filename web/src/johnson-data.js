/*
 * Johnson Report — data model (pure functions, no DOM).
 *
 * The Johnson Report is a semi-annual (June / December) survey of Winnipeg
 * commercial real estate: industrial, office and retail vacancy and lease
 * rates by district, and annual sales summaries. It is copyrighted subscriber
 * material, so NOTHING from it ships with this site. The user runs
 * `ingest/parse_johnson.py` (in the Johnson-Report project) over their Word
 * files, which writes one JSON per edition into a `web-data/` folder; the
 * Johnson Report tab reads that folder in the browser (johnson-store.js).
 *
 * This module turns those edition JSONs into chart records:
 *
 *   - CHARTS is the catalog: which parsed tables (`series` ids from the
 *     Python catalog) make up each chart, how the table maps to lines and
 *     dates, and its units.
 *   - buildChartRecords() renders one chart for one view:
 *       'edition'  — exactly what that edition printed (its own 10-year
 *                    look-back), the "snapshot in time";
 *       'series'   — every edition up to the selected one merged into one
 *                    long series, LATEST EDITION WINS where they overlap,
 *                    so a revised figure replaces the earlier print.
 *
 * Dates: a June table is dated YYYY-06-30 and a December table YYYY-12-31,
 * so June and December readings of the same measure interleave into one
 * semi-annual line. Annual tables (sales, leasing) are dated YYYY-12-31.
 */

// --- Catalog -----------------------------------------------------------------
//
// Chart `kind`s:
//   matrix-rows   table is district × year; each row is a line, x = year column
//   records-cols  table is year × measures; each column is a line, x = row year
//   records-col   one named column pulled from several tables; one line per
//                 table, x = row year (e.g. PRICE/SF from users/investors/all)
//   period-rows   rows are "June 2017" / "December 2017"; columns are lines
//
// `district: true` marks the charts the district picker applies to.
// `family` groups the June and December versions of one measure so the long
// series interleaves them; a chart with no family is annual.

export const GROUPS = [
  { id: 'ind_vac',   label: 'Industrial vacancy' },
  { id: 'ind_lease', label: 'Industrial leasing' },
  { id: 'office',    label: 'Office' },
  { id: 'retail',    label: 'Retail' },
  { id: 'summary',   label: 'Vacancy summary' },
  { id: 'sales',     label: 'Building sales' },
  { id: 'apt',       label: 'Apartment sales' },
  { id: 'land',      label: 'Land sales' },
];

export const CHARTS = [
  // --- Industrial vacancy (semi-annual, by district) ---
  { id: 'ind_vac_total',  group: 'ind_vac', kind: 'matrix-rows', series: ['ind_vac_total_district'],
    title: 'Industrial Vacancy — Total Inventory', units: 'percent', district: true, family: 'ind_vac_total' },
  { id: 'ind_vac_invest', group: 'ind_vac', kind: 'matrix-rows', series: ['ind_vac_invest_district'],
    title: 'Industrial Vacancy — Investment Properties', units: 'percent', district: true, family: 'ind_vac_invest' },
  { id: 'ind_vac_single', group: 'ind_vac', kind: 'matrix-rows', series: ['ind_vac_single_district'],
    title: 'Industrial Vacancy — Single-Tenant Investment', units: 'percent', district: true, family: 'ind_vac_single' },
  { id: 'ind_vac_multi',  group: 'ind_vac', kind: 'matrix-rows', series: ['ind_vac_multi_district'],
    title: 'Industrial Vacancy — Multi-Tenant Investment', units: 'percent', district: true, family: 'ind_vac_multi' },
  { id: 'ind_vac_sf',     group: 'ind_vac', kind: 'records-cols', series: ['ind_vac_distribution'],
    title: 'Industrial Vacant Space — Owner-Occupied vs Investment', units: 'sf', family: 'ind_vac_sf' },

  // --- Industrial leasing (annual, December editions) ---
  { id: 'ind_rate',        group: 'ind_lease', kind: 'matrix-rows', series: ['ind_lease_rate_district'],
    title: 'Industrial Net Lease Rates by District', units: 'dollar_psf', district: true },
  { id: 'ind_rate_single', group: 'ind_lease', kind: 'matrix-rows', series: ['ind_lease_rate_single'],
    title: 'Industrial Net Lease Rates — Single-Tenant', units: 'dollar_psf', district: true },
  { id: 'ind_rate_multi',  group: 'ind_lease', kind: 'matrix-rows', series: ['ind_lease_rate_multi'],
    title: 'Industrial Net Lease Rates — Multi-Tenant', units: 'dollar_psf', district: true },
  { id: 'ind_rate_age',    group: 'ind_lease', kind: 'matrix-rows', series: ['ind_lease_rate_age'],
    title: 'Industrial Net Lease Rates by Building Age', units: 'dollar_psf' },
  { id: 'ind_leased_sf',   group: 'ind_lease', kind: 'matrix-rows', series: ['ind_leasing_sf_district'],
    title: 'Industrial Space Leased by District', units: 'sf', district: true },
  { id: 'ind_rate_type',   group: 'ind_lease', kind: 'records-cols', series: ['ind_leasing_by_type'],
    columns: { 'RATE': 'Single-tenant rate', 'RATE#2': 'Multi-tenant rate', 'RATE#3': 'All rate' },
    title: 'Industrial Net Lease Rates by Property Type', units: 'dollar_psf' },

  // --- Office ---
  { id: 'office_headlease', group: 'office', kind: 'matrix-rows', series: ['office_headlease_history'],
    title: 'Office Headlease Vacancy by Class', units: 'percent', family: 'office_headlease',
    // Rows carry a group (Downtown / Suburban); the line label is "Downtown · Class A".
    groupLabel: true,
    defaultRows: ['Downtown · Class A', 'Downtown · Class B', 'Downtown · Class C', 'Downtown · Total A,B,C', 'Suburban · Total Suburban', 'Total Inventory'] },
  { id: 'office_sublease',  group: 'office', kind: 'period-rows', series: ['office_sublease_history'],
    title: 'Downtown Office Vacancy Including Subleases — Investment Class A–C', units: 'percent' },
  { id: 'office_dt_rate',   group: 'office', kind: 'records-cols', series: ['office_dt_vac_rate'],
    title: 'Downtown Office Headlease Vacancy — Class A–C', units: 'percent', family: 'office_dt_rate' },
  { id: 'office_dt_lease',  group: 'office', kind: 'records-cols', series: ['office_dt_lease_rates'],
    columns: { 'CLASS A RATE': 'Class A', 'CLASS B RATE': 'Class B' },
    title: 'Downtown Office Lease Rates — Class A & B', units: 'dollar_psf' },

  // --- Retail ---
  { id: 'retail_vac',   group: 'retail', kind: 'matrix-rows', series: ['retail_vac_district'],
    title: 'Retail Vacancy by District — Total Inventory', units: 'percent', district: true, family: 'retail_vac' },
  { id: 'strip_vac',    group: 'retail', kind: 'matrix-rows', series: ['strip_vac_district'],
    title: 'Strip Centre Vacancy by District', units: 'percent', district: true, family: 'strip_vac' },
  { id: 'strip_rate',   group: 'retail', kind: 'matrix-rows', series: ['strip_lease_rate_district'],
    title: 'Strip Centre Net Lease Rates by District', units: 'dollar_psf', district: true },
  { id: 'retail_ask',   group: 'retail', kind: 'edition-col', series: ['retail_vac_rent_district'],
    column: 'ASKING RENT', title: 'Retail Asking Net Rent of Vacant Space by District', units: 'dollar_psf',
    district: true, family: 'retail_ask' },
  { id: 'retail_ask_type', group: 'retail', kind: 'edition-col', series: ['retail_asking_rent_type'],
    column: 'ASKING RENT', title: 'Retail Asking Net Rent of Vacant Space by Type', units: 'dollar_psf',
    family: 'retail_ask_type' },
  { id: 'retail_inv_rate', group: 'retail', kind: 'edition-col', series: ['retail_inventory_snapshot'],
    column: 'RATE', title: 'Retail Vacancy Rate by Type', units: 'percent', family: 'retail_inv_rate' },

  // --- Vacancy summary ---
  { id: 'vac_compare', group: 'summary', kind: 'records-cols', series: ['vac_rate_comparison'],
    title: 'Vacancy Rate Comparison — Industrial, Office, Retail', units: 'percent',
    // These tables hold both seasons in their columns; "YEAR END" columns are dated December.
    seasonColumns: true },
  { id: 'vac_sf', group: 'summary', kind: 'records-cols', series: ['comm_vac_sf_summary'],
    title: 'Vacant Space — Industrial, Office, Retail', units: 'sf', family: 'vac_sf' },

  // --- Building sales (annual) ---
  { id: 'sales_volume', group: 'sales', kind: 'records-cols', series: ['sales_volume_all'],
    title: 'Annual Dollar Volume of Sales by Sector', units: 'dollar_millions' },
  { id: 'sales_volume_inv', group: 'sales', kind: 'records-cols', series: ['sales_volume_invest'],
    title: 'Annual Dollar Volume of Investment Sales', units: 'dollar_millions' },
  { id: 'ind_sales_psf', group: 'sales', kind: 'records-col',
    series: ['ind_sales_summary', 'ind_sales_users', 'ind_sales_investors'],
    seriesLabels: { ind_sales_summary: 'All industrial', ind_sales_users: 'Sales to users', ind_sales_investors: 'Sales to investors' },
    column: 'PRICE PER SQ FT', title: 'Industrial Building Sales — Price per Sq Ft', units: 'dollar_psf' },
  { id: 'ind_sales_psf_district', group: 'sales', kind: 'matrix-rows', series: ['ind_sales_psf_district'],
    title: 'Industrial Building Sales — Price per Sq Ft by District', units: 'dollar_psf', district: true },
  { id: 'office_sales_psf', group: 'sales', kind: 'records-col',
    series: ['office_sales_summary', 'office_sales_users', 'office_sales_investors', 'retail_invest_sales'],
    seriesLabels: { office_sales_summary: 'All office', office_sales_users: 'Office — users', office_sales_investors: 'Office — investors', retail_invest_sales: 'Retail investment' },
    column: 'PRICE/SF', title: 'Office & Retail Building Sales — Price per Sq Ft', units: 'dollar_psf' },
  { id: 'comm_sales_volume', group: 'sales', kind: 'records-cols', series: ['comm_sales_volume'],
    title: 'Dollar Volume of Office, Retail, Miscellaneous & Restaurant Sales', units: 'dollar_millions' },

  // --- Apartment sales (annual) ---
  { id: 'apt_psf', group: 'apt', kind: 'records-col',
    series: ['apt_sales', 'apt_sales_pre1946', 'apt_sales_1946_1959', 'apt_sales_1960_1969', 'apt_sales_1970plus'],
    seriesLabels: { apt_sales: 'All apartments', apt_sales_pre1946: 'Pre 1946', apt_sales_1946_1959: '1946–1959', apt_sales_1960_1969: '1960–1969', apt_sales_1970plus: '1970+' },
    column: 'SF PRICE', title: 'Apartment Sales — Price per Sq Ft by Age Group', units: 'dollar_psf' },
  { id: 'apt_suite', group: 'apt', kind: 'records-col',
    series: ['apt_sales', 'apt_sales_pre1946', 'apt_sales_1946_1959', 'apt_sales_1960_1969', 'apt_sales_1970plus'],
    seriesLabels: { apt_sales: 'All apartments', apt_sales_pre1946: 'Pre 1946', apt_sales_1946_1959: '1946–1959', apt_sales_1960_1969: '1960–1969', apt_sales_1970plus: '1970+' },
    column: 'PRICE/SUITE', title: 'Apartment Sales — Price per Suite by Age Group', units: 'dollar' },
  { id: 'apt_volume', group: 'apt', kind: 'records-col', series: ['apt_sales'],
    seriesLabels: { apt_sales: 'Dollar volume' },
    column: '$ VOLUME', title: 'Apartment Sales — Annual Dollar Volume', units: 'dollar_millions' },

  // --- Land sales (annual) ---
  { id: 'land_ind_price', group: 'land', kind: 'records-cols', series: ['land_sales_ind_prices'],
    columns: { 'PRICE/SF': 'Price per sq ft' }, title: 'Industrial Land — Price per Sq Ft', units: 'dollar_psf' },
  { id: 'land_ind_acre', group: 'land', kind: 'records-cols', series: ['land_sales_ind_prices'],
    columns: { 'PRICE/ACRE': 'Price per acre' }, title: 'Industrial Land — Price per Acre', units: 'dollar' },
  { id: 'land_comm_price', group: 'land', kind: 'records-cols', series: ['land_sales_comm'],
    columns: { 'PRICE/SF': 'Price per sq ft' }, title: 'Commercial Land — Price per Sq Ft', units: 'dollar_psf' },
  { id: 'land_acres', group: 'land', kind: 'records-cols', series: ['land_sales_ind_comm'],
    columns: { 'INDUSTRIAL ACRES': 'Industrial', 'COMMERCIAL ACRES': 'Commercial', 'TOTAL ACRES': 'Total' },
    title: 'Land Sold — Acres per Year', units: 'acres' },
  { id: 'land_ind_psf_district', group: 'land', kind: 'matrix-rows', series: ['land_ind_psf_district'],
    title: 'Industrial Land — Price per Sq Ft by District', units: 'dollar_psf', district: true },
];

export const CHART_BY_ID = Object.fromEntries(CHARTS.map(c => [c.id, c]));

// Aggregate row labels that every district chart draws solid (the rest dashed
// beside them, as the CMHC charts do), and that stay on when the picker is
// narrowed. "Total" appears in dollar tables, "Overall" in vacancy tables.
export const AGGREGATE_LABELS = new Set(['Overall', 'Total', 'Total Inventory']);

// --- Dates -------------------------------------------------------------------

export function seasonDate(year, season) {
  return season === 'jun' ? `${year}-06-30` : `${year}-12-31`;
}

/** "June 2017" / "December 2017" / "2017" → ISO date, or null. */
export function periodToDate(label) {
  const s = String(label || '').trim();
  let m = /^(June|Jun|December|Dec)\s+(\d{4})$/i.exec(s);
  if (m) return seasonDate(m[2], /^jun/i.test(m[1]) ? 'jun' : 'dec');
  m = /^(\d{4})\*{0,2}$/.exec(s);
  if (m) return `${m[1]}-12-31`;
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06" → "Jun 2026" for subtitles and edition names. */
export function editionLabel(ed) {
  if (!ed) return '';
  return `${ed.season === 'jun' ? 'June' : 'December'} ${ed.year}`;
}

export function shortEditionLabel(ed) {
  if (!ed) return '';
  return `${MONTHS[ed.month - 1]}-${ed.year}`;
}

// --- Editions ----------------------------------------------------------------

export function sortEditions(editions) {
  return [...editions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Editions up to and including `uptoId` (or all when null), oldest first. */
export function editionsUpTo(editions, uptoId) {
  const sorted = sortEditions(editions);
  return uptoId ? sorted.filter(e => e.id <= uptoId) : sorted;
}

function tablesFor(edition, seriesIds) {
  const want = new Set(seriesIds);
  return (edition?.tables || []).filter(t => t.series && want.has(t.series));
}

/** The season a table's readings belong to: its own, else the edition's. */
function tableSeason(table, edition) {
  return table.season || edition.season;
}

// --- Table → points ----------------------------------------------------------
// A point is { line, date, value, edition } — chart-agnostic. `line` is the
// legend label.

function rowLabel(row, chart) {
  if (chart.groupLabel && row.group) return `${row.group} · ${row.label}`;
  return row.label;
}

function matrixRowsPoints(chart, table, edition) {
  const out = [];
  const season = chart.family ? tableSeason(table, edition) : 'dec';
  table.columns.forEach((col, j) => {
    const m = /^(\d{4})/.exec(String(col));
    if (!m) return;                                // "% Increase Since 2016" etc.
    const date = seasonDate(m[1], season);
    for (const row of table.rows) {
      const v = row.values[j];
      if (typeof v !== 'number') continue;
      out.push({ line: rowLabel(row, chart), date, value: v, edition: edition.id });
    }
  });
  return out;
}

/** Column names de-duplicated: a second "RATE" becomes "RATE#2". */
export function uniqueColumns(columns) {
  const seen = new Map();
  return columns.map(c => {
    const n = (seen.get(c) || 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}#${n}`;
  });
}

function recordsColsPoints(chart, table, edition) {
  const out = [];
  const cols = uniqueColumns(table.columns);
  const wanted = chart.columns ? Object.keys(chart.columns) : cols.filter(Boolean);
  const season = chart.family ? tableSeason(table, edition) : null;
  for (const row of table.rows) {
    const m = /^(\d{4})/.exec(String(row.label));
    if (!m) continue;
    wanted.forEach((col) => {
      const j = cols.indexOf(col);
      if (j < 0) return;
      const v = row.values[j];
      if (typeof v !== 'number') return;
      let date;
      if (chart.seasonColumns) {
        // "INDUSTRIAL JUNE" / "INDUSTRIAL YEAR END": the column names the season.
        date = seasonDate(m[1], /JUNE/i.test(col) ? 'jun' : 'dec');
      } else {
        date = seasonDate(m[1], season || 'dec');
      }
      let line = chart.columns ? chart.columns[col] : titleCase(col);
      if (chart.seasonColumns) line = titleCase(col.replace(/\s+(JUNE|YEAR END|DECEMBER)$/i, ''));
      out.push({ line, date, value: v, edition: edition.id });
    });
  }
  return out;
}

function recordsColPoints(chart, table, edition) {
  const out = [];
  const cols = uniqueColumns(table.columns);
  const j = cols.indexOf(chart.column);
  if (j < 0) return out;
  const line = chart.seriesLabels?.[table.series] || titleCase(table.series);
  for (const row of table.rows) {
    const m = /^(\d{4})/.exec(String(row.label));
    if (!m) continue;
    const v = row.values[j];
    if (typeof v !== 'number') continue;
    out.push({ line, date: `${m[1]}-12-31`, value: v, edition: edition.id });
  }
  return out;
}

function periodRowsPoints(chart, table, edition) {
  const out = [];
  const cols = uniqueColumns(table.columns);
  for (const row of table.rows) {
    const date = periodToDate(row.label);
    if (!date) continue;
    cols.forEach((col, j) => {
      const v = row.values[j];
      if (typeof v !== 'number' || !col) return;
      out.push({ line: titleCase(col), date, value: v, edition: edition.id });
    });
  }
  return out;
}

/**
 * A snapshot table where each row is a district / type and the columns are
 * "<year> VACANCY", "<year> ASKING RENT" (two years side by side) or a single
 * "ASKING RENT" / "RATE" column for the edition's own period. Every reading
 * is dated by its column year (or the edition) and the edition's season.
 */
function editionColPoints(chart, table, edition) {
  const out = [];
  const season = tableSeason(table, edition);
  table.columns.forEach((col, j) => {
    const name = String(col || '');
    const m = /^(\d{4})\s+(.+)$/.exec(name);
    const measure = m ? m[2] : name;
    if (measure.toUpperCase() !== chart.column.toUpperCase()) return;
    const year = m ? m[1] : edition.year;
    const date = seasonDate(year, season);
    for (const row of table.rows) {
      const v = row.values[j];
      if (typeof v !== 'number') continue;
      out.push({ line: row.label, date, value: v, edition: edition.id });
    }
  });
  return out;
}

const POINTS = {
  'matrix-rows':  matrixRowsPoints,
  'records-cols': recordsColsPoints,
  'records-col':  recordsColPoints,
  'period-rows':  periodRowsPoints,
  'edition-col':  editionColPoints,
};

export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\bSq Ft\b/g, 'sq ft').replace(/\bA,b,c\b/g, 'A,B,C');
}

/** Every point one edition contributes to a chart. */
export function editionPoints(chart, edition) {
  const fn = POINTS[chart.kind];
  if (!fn) return [];
  const out = [];
  for (const t of tablesFor(edition, chart.series)) out.push(...fn(chart, t, edition));
  return out;
}

// --- Views -------------------------------------------------------------------

/**
 * Merge editions oldest→newest so a later edition's reading of the same
 * (line, date) replaces an earlier one. Returns points sorted by line then date.
 */
export function mergeLatestWins(pointsByEdition) {
  const map = new Map();
  for (const pts of pointsByEdition) {
    for (const p of pts) map.set(`${p.line}\u0000${p.date}`, p);
  }
  return [...map.values()].sort((a, b) =>
    a.line < b.line ? -1 : a.line > b.line ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

/**
 * Points for a chart under a view.
 *   view = 'edition' → the selected edition's own tables only
 *   view = 'series'  → every edition up to the selected one, latest wins
 */
export function chartPoints(chart, editions, { view, editionId }) {
  const sorted = editionsUpTo(editions, editionId);
  if (view === 'edition') {
    const ed = sorted.find(e => e.id === editionId) || sorted[sorted.length - 1];
    return ed ? mergeLatestWins([editionPoints(chart, ed)]) : [];
  }
  return mergeLatestWins(sorted.map(ed => editionPoints(chart, ed)));
}

/** Distinct line labels in first-seen order. */
export function lineLabels(points) {
  const seen = new Set();
  const out = [];
  for (const p of points) if (!seen.has(p.line)) { seen.add(p.line); out.push(p.line); }
  return out;
}

/**
 * Every district label used by any district chart across the given editions,
 * aggregates last. Drives the sidebar picker.
 */
export function allDistricts(editions) {
  const seen = new Set();
  for (const chart of CHARTS.filter(c => c.district)) {
    for (const ed of editions) {
      for (const p of editionPoints(chart, ed)) seen.add(p.line);
    }
  }
  const names = [...seen];
  const agg = names.filter(n => AGGREGATE_LABELS.has(n));
  const rest = names.filter(n => !AGGREGATE_LABELS.has(n)).sort((a, b) => a.localeCompare(b));
  return [...rest, ...agg];
}

/**
 * Convert points into the {records, seriesMeta} pair buildIndicatorCard
 * expects. `keep` optionally restricts the lines (district picker); the
 * aggregate line is always kept when present.
 */
export function toCardInput(chart, points, { keep = null, lineOrder = null } = {}) {
  let labels = lineLabels(points);
  if (lineOrder) {
    const idx = new Map(lineOrder.map((l, i) => [l, i]));
    labels = [...labels].sort((a, b) => (idx.get(a) ?? 1e9) - (idx.get(b) ?? 1e9));
  }
  // The aggregate (Overall / Total) reads last in the legend, under its components.
  labels = [...labels.filter(l => !AGGREGATE_LABELS.has(l)), ...labels.filter(l => AGGREGATE_LABELS.has(l))];
  if (keep) {
    const k = new Set(keep);
    labels = labels.filter(l => k.has(l) || AGGREGATE_LABELS.has(l));
  }
  const ids = new Map(labels.map(l => [l, `${chart.id}:${l}`]));
  const records = points.filter(p => ids.has(p.line))
    .map(p => ({ id: ids.get(p.line), date: p.date, value: p.value }));
  const seriesMeta = labels.map(l => ({
    id: ids.get(l), chartLabel: l, units: chart.units, provider: 'johnson',
    frequency: chart.family || chart.kind === 'period-rows' || chart.seasonColumns ? 'monthly' : 'annual',
    geo: 'Winnipeg',
  }));
  const dashedIds = labels.some(l => AGGREGATE_LABELS.has(l))
    ? labels.filter(l => !AGGREGATE_LABELS.has(l)).map(l => ids.get(l))
    : [];
  return { records, seriesMeta, dashedIds };
}

/** "Source: The Johnson Report (June 2026)" / "(Dec-2009 to Jun-2026 editions)". */
export function sourceLabel(editions, { view, editionId }) {
  const sorted = editionsUpTo(editions, editionId);
  if (!sorted.length) return 'The Johnson Report';
  const last = sorted.find(e => e.id === editionId) || sorted[sorted.length - 1];
  if (view === 'edition' || sorted.length === 1) return `The Johnson Report, ${editionLabel(last)}`;
  return `The Johnson Report, ${shortEditionLabel(sorted[0])} to ${shortEditionLabel(last)} editions`;
}
