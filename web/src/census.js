/*
 * Census Profile view — Population & Dwelling Trends (2006–2021) plus a 2021
 * Demographics comparison (subject vs a comparison area vs Manitoba), for every
 * Manitoba geography (province / CMA-CA / census division / municipality) and
 * the City-of-Winnipeg virtual geographies (Community Area / Cluster /
 * Neighbourhood). This is the web port of the MBCensusData Shiny app / Excel
 * report; data is pre-built by r/12_census_profile.R into
 * web/public/data/housing/census_profile.json.
 *
 * Tables mirror the appraisal report layout exactly; two charts per section are
 * rendered as Observable Plot cards so the tab-level "Download Word/Excel
 * (charts)" buttons (wired in main.js) capture them.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark, PALETTE } from './plot-theme.js';
import { downloadCard } from './chart.js';

// Geography levels, in dropdown group order.
const LEVEL_GROUPS = [
  { tag: 'PR',          label: 'Province' },
  { tag: 'CMA',         label: 'CMA / CA' },
  { tag: 'CD',          label: 'Census Divisions' },
  { tag: 'CSD',         label: 'Municipalities (CSD)' },
  { tag: 'WPG_CA',      label: 'Winnipeg — Community Areas' },
  { tag: 'WPG_Cluster', label: 'Winnipeg — Clusters' },
  { tag: 'WPG_Nbhd',    label: 'Winnipeg — Neighbourhoods' },
];

// Province scoping for the area cascade. Winnipeg virtual geos (WPG_*) belong to
// Manitoba; every other region's province is the first two digits of its uid.
const PROV_LABEL = { '46': 'Manitoba', '47': 'Saskatchewan', '48': 'Alberta', '59': 'British Columbia' };
const PROV_ORDER = ['46', '47', '48', '59'];
const provOf = (r) => String(r.uid).startsWith('WPG') ? '46' : String(r.uid).slice(0, 2);

// Trends table layout (mirrors MBCensusData display_trends). `key` reads from a
// year's trend object; `popchg` is computed; `header` is a section divider.
const TREND_ROWS = [
  { label: 'Population',                key: 'population', fmt: 'int' },
  { label: 'Population % Change',       popchg: true,      fmt: 'pct' },
  { label: 'Total Private Dwellings*',  key: 'households', fmt: 'int' },
  { header: 'Occupied Dwellings by Type*' },
  { label: 'Single-Detached House',     key: 'single_detached', fmt: 'int' },
  { label: 'Apartment (<5 Storeys)',    key: 'apt_lt5',         fmt: 'int' },
  { label: 'Apartment (5+ Storeys)',    key: 'apt_ge5',         fmt: 'int' },
  { label: 'Semi-Detached House',       key: 'semi_detached',   fmt: 'int' },
  { label: 'Row House',                 key: 'row_house',       fmt: 'int' },
  { label: 'Apt or Flat in a Duplex',   key: 'apt_duplex',      fmt: 'int' },
  { label: 'Movable Dwelling',          key: 'movable',         fmt: 'int' },
  { label: 'Other',                     key: 'other_attached',  fmt: 'int' },
];

// Dwelling-type rows used by the trends stacked-bar chart (short labels).
const TYPE_SERIES = [
  ['single_detached', 'Single-detached'], ['apt_lt5', 'Apt <5'],
  ['apt_ge5', 'Apt 5+'], ['semi_detached', 'Semi-detached'],
  ['row_house', 'Row'], ['apt_duplex', 'Duplex'],
  ['movable', 'Movable'], ['other_attached', 'Other'],
];

// Demographics table layout (mirrors MBCensusData display_demographics).
const DEMO_SECTIONS = [
  { header: 'Age Range', rows: [
    { label: 'Total Counted',           key: 'population',   denom: 'population', fmt: 'int' },
    { label: '0 to 14 years',           key: 'age_0_14',     denom: 'population', fmt: 'int' },
    { label: '15 to 64 years',          key: 'age_15_64',    denom: 'population', fmt: 'int' },
    { label: '65 years and over',       key: 'age_65_plus',  denom: 'population', fmt: 'int' },
    { label: 'Median Age of Population', key: 'median_age',  denom: null,         fmt: 'dec1' },
  ]},
  { header: 'Household Size', rows: [
    { label: '1 person',             key: 'hh_size_1',     denom: 'hh_size_total', fmt: 'int' },
    { label: '2 persons',            key: 'hh_size_2',     denom: 'hh_size_total', fmt: 'int' },
    { label: '3 persons',            key: 'hh_size_3',     denom: 'hh_size_total', fmt: 'int' },
    { label: '4 persons',            key: 'hh_size_4',     denom: 'hh_size_total', fmt: 'int' },
    { label: '5 or more persons',    key: 'hh_size_5plus', denom: 'hh_size_total', fmt: 'int' },
    { label: 'Average household size', key: 'avg_hh_size',  denom: null,           fmt: 'dec1' },
  ]},
  { header: 'Occupied Dwellings by Bedrooms (25% Sample)', rows: [
    { label: 'No bedrooms (bachelor)', key: 'bed_0',     denom: 'bed_total', fmt: 'int' },
    { label: '1 bedroom',              key: 'bed_1',     denom: 'bed_total', fmt: 'int' },
    { label: '2 bedrooms',             key: 'bed_2',     denom: 'bed_total', fmt: 'int' },
    { label: '3 bedrooms',             key: 'bed_3',     denom: 'bed_total', fmt: 'int' },
    { label: '4 or more bedrooms',     key: 'bed_4plus', denom: 'bed_total', fmt: 'int' },
  ]},
  { header: 'Age of Dwellings (25% Sample)', rows: [
    { label: '1960 or before', key: 'built_1960',      denom: 'period_total', fmt: 'int' },
    { label: '1961 to 1980',   key: 'built_1961_1980', denom: 'period_total', fmt: 'int' },
    { label: '1981 to 1990',   key: 'built_1981_1990', denom: 'period_total', fmt: 'int' },
    { label: '1991 to 2000',   key: 'built_1991_2000', denom: 'period_total', fmt: 'int' },
    { label: '2001 to 2005',   key: 'built_2001_2005', denom: 'period_total', fmt: 'int' },
    { label: '2006 to 2010',   key: 'built_2006_2010', denom: 'period_total', fmt: 'int' },
    { label: '2011 to 2015',   key: 'built_2011_2015', denom: 'period_total', fmt: 'int' },
    { label: '2016 to 2021',   key: 'built_2016_2021', denom: 'period_total', fmt: 'int' },
  ]},
  { header: 'Dwelling Tenure (25% sample)', rows: [
    { label: 'Owner',  key: 'owner',  denom: 'tenure_total', fmt: 'int' },
    { label: 'Renter', key: 'renter', denom: 'tenure_total', fmt: 'int' },
  ]},
  { header: 'Median Shelter Values/Costs (2020)', rows: [
    { label: 'Median Value of Dwellings',  key: 'median_dwelling_val', denom: null, fmt: 'usd' },
    { label: 'Median Monthly Rental Cost', key: 'median_rent',         denom: null, fmt: 'usd' },
  ]},
  { header: 'Median Income Levels (2020)', rows: [
    { label: 'Median Individual Income', key: 'median_ind_income', denom: null, fmt: 'usd' },
    { label: 'Median Household Income',  key: 'median_hh_income',  denom: null, fmt: 'usd' },
  ]},
  { header: 'Shelter-Cost Stress', rows: [
    { label: 'Tenants spending 30%+ on shelter', key: 'tenant_stir_30', denom: null, fmt: 'stir' },
  ]},
];

// ---- formatters ------------------------------------------------------------
const miss  = (v) => v == null || !Number.isFinite(Number(v));   // null / NaN / Infinity → "**"
const fInt  = (v) => miss(v) ? '**' : Number(v).toLocaleString();
const fUsd  = (v) => miss(v) ? '**' : `$${Math.round(Number(v)).toLocaleString()}`;
const fDec1 = (v) => miss(v) ? '**' : Number(v).toFixed(1);
const fPct0 = (v) => miss(v) ? '**' : `${Math.round(Number(v) * 100)}%`;          // fraction → "27%"
const fPct1 = (v) => miss(v) ? '**' : `${(Number(v) * 100).toFixed(1)}%`;         // fraction → "5.2%"
const fStir = (v) => miss(v) ? '**' : `${Math.round(Number(v))}%`;                // already 0–100
const fmtVal = (v, kind) => kind === 'usd' ? fUsd(v) : kind === 'dec1' ? fDec1(v)
                          : kind === 'stir' ? fStir(v) : fInt(v);

// Census periods offered by the Demographics period selector.
const DEMO_PERIODS = ['2021', '2016', '2011'];

// Read a region's demographics object for a given census period. The rebuilt
// data keys `demo` by year ({ "2021": {…}, "2016": {…}, "2011": {…} }); the
// current (pre-rebuild) file ships a single flat object that represents 2021.
// Handle both so the tab keeps working until r/12_census_profile.R is re-run.
function demoFor(region, period) {
  const d = region && region.demo;
  if (!d) return null;
  const yearKeyed = ['2006', '2011', '2016', '2021'].some(y => Object.prototype.hasOwnProperty.call(d, y));
  if (yearKeyed) return d[period] || null;
  return period === '2021' ? d : null;   // legacy flat shape = 2021 only
}

export async function initCensus() {
  const $area    = [1, 2, 3].map(i => document.getElementById(`census-area${i}`));
  const $prov    = [1, 2, 3].map(i => document.getElementById(`census-prov${i}`));
  const $period  = document.getElementById('census-period');
  const $headline = document.getElementById('census-headline');
  const $charts   = document.getElementById('census-chart-grid');
  const $tables   = document.getElementById('census-tables');
  if (!$area[0] || !$tables) return;

  const data = await fetch('./data/housing/census_profile.json')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!data || !Array.isArray(data.regions)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census profile data not found. Run r/12_census_profile.R.</p>';
    return;
  }

  // Clean cancensus type codes for display: "Manitoba (Man.)" → "Manitoba",
  // "Winnipeg (B)" → "Winnipeg (CMA)", "Brandon (D)" → "Brandon (CA)". CSD codes
  // ("(RM)", "(CY)", "(T)", "(IRI)"…) are kept — they distinguish same-named
  // municipalities and match the census naming appraisers expect.
  for (const r of data.regions) {
    let n = String(r.name || '').replace(/\s{2,}/g, ' ').trim();
    if (r.level === 'PR')  n = n.replace(/\s*\([^)]*\)$/, '');                         // (Man.)/(Sask.)/(Alta.)
    if (r.level === 'CMA') n = n.replace(/\s*\(B\)$/, ' (CMA)').replace(/\s*\((D|K)\)$/, ' (CA)');
    if (r.level === 'CD')  n = n.replace(/\s*\(CDR\)$/, '');                           // census-division type code
    r.name = n;
  }

  const years  = (data.censusYears || []).map(String);
  const byUid  = new Map(data.regions.map(r => [r.uid, r]));

  // Province + area cascade for each of the three pickers. The area <select> is
  // grouped by level (optgroups) but scoped to the chosen province, so the
  // ~1,400 SK/AB/BC municipalities only appear under their own province rather
  // than swamping one flat list. Manitoba additionally carries the Winnipeg
  // virtual geographies.
  const provsPresent = PROV_ORDER.filter(p => data.regions.some(r => provOf(r) === p));
  const fillProv = (sel, prov) => {
    sel.innerHTML = provsPresent
      .map(p => `<option value="${p}">${escapeHtml(PROV_LABEL[p] || p)}</option>`).join('');
    sel.value = prov;
  };
  const fillArea = (sel, prov, defaultUid) => {
    const opt = (r) => `<option value="${escapeHtml(r.uid)}">${escapeHtml(r.name)}</option>`;
    sel.innerHTML = LEVEL_GROUPS.map(g => {
      const arr = data.regions.filter(r => r.level === g.tag && provOf(r) === prov)
        .sort((a, b) => a.name.localeCompare(b.name));
      return arr.length ? `<optgroup label="${escapeHtml(g.label)}">${arr.map(opt).join('')}</optgroup>` : '';
    }).join('');
    if (defaultUid && data.regions.some(r => r.uid === defaultUid && provOf(r) === prov)) sel.value = defaultUid;
  };

  // Defaults mirror the old subject / comparison / Manitoba layout while leaving
  // all three pickers free: Area 1 = first Winnipeg cluster if the rebuilt data
  // has them, else RM of Springfield (the sample report) / first MB CSD; Area 2 =
  // Winnipeg CMA; Area 3 = Manitoba (PR). All three start scoped to Manitoba.
  const manitoba    = data.regions.find(r => r.level === 'PR' && r.uid === '46');
  const wpgCma      = data.regions.find(r => r.level === 'CMA' && /^winnipeg/i.test(r.name));
  const firstCsd    = data.regions.find(r => r.level === 'CSD' && provOf(r) === '46');
  const firstClust  = data.regions.filter(r => r.level === 'WPG_Cluster')
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  const area1Def = firstClust?.uid || (byUid.has('4612047') ? '4612047' : firstCsd?.uid);
  const areaDefs = [area1Def, wpgCma?.uid, manitoba?.uid];
  $prov.forEach((psel, i) => { fillProv(psel, '46'); fillArea($area[i], '46', areaDefs[i]); });
  if ($period && !DEMO_PERIODS.includes($period.value)) $period.value = '2021';

  // Ensure the two table containers exist before the first render.
  $tables.innerHTML = '<section class="cmhc-table-block" id="census-trends"></section>' +
                      '<section class="cmhc-table-block" id="census-demo"></section>';

  let lastTrendTables = [];
  let lastDemoTable   = null;

  function render() {
    const period = $period?.value || '2021';
    // The three chosen areas, de-duped (picking the same area twice collapses
    // it rather than repeating a table/column).
    const cols = [];
    for (const sel of $area) {
      const r = byUid.get(sel.value);
      if (r && !cols.some(c => c.uid === r.uid)) cols.push(r);
    }
    if (!cols.length) return;
    const subject = cols[0];

    renderHeadline(subject, period);
    renderCharts(subject, cols, period);
    lastTrendTables = renderTrends(cols);
    lastDemoTable   = renderDemographics(cols, period);
  }

  // ---- Headline -----------------------------------------------------------
  function renderHeadline(subject, period) {
    const t = subject.trends || {};
    const demo = demoFor(subject, period);
    const trendY = years.filter(y => t[y]?.population != null);
    const lastY  = trendY[trendY.length - 1];
    const prevY  = trendY[trendY.length - 2];
    // Prefer the selected period's population; fall back to the latest census
    // the area has trend data for (Winnipeg areas only carry 2021).
    const pop     = demo?.population ?? (lastY ? t[lastY].population : null);
    const popYear = demo?.population != null ? period : lastY;
    let chg = '';
    if (lastY && prevY && t[prevY].population) {
      const d = (t[lastY].population - t[prevY].population) / t[prevY].population * 100;
      chg = ` <span>(${d >= 0 ? '+' : ''}${d.toFixed(1)}% ${prevY}→${lastY})</span>`;
    }
    $headline.innerHTML = `
      <div class="cmhc-hsk-title">${escapeHtml(subject.name)} — census profile</div>
      <div class="cmhc-hsk-stats">
        <span><strong>${pop == null ? '—' : pop.toLocaleString()}</strong> population (${popYear || '—'})${chg}</span>
        <span><strong>${fInt(demo?.households)}</strong> private dwellings (${escapeHtml(period)})</span>
      </div>`;
  }

  // ---- Trends tables (one per area, all stacked) --------------------------
  function renderTrends(cols) {
    const models = [];
    // Skip areas with no multi-census trend data (SK/AB/BC municipalities carry
    // demographics only) so they don't render an all-blank Trends table.
    const html = cols.filter(c => Object.keys(c.trends || {}).length).map(subject => {
      const { tableHtml, model } = trendTableFor(subject);
      models.push(model);
      return tableHtml;
    }).join('');
    $tables.querySelector('#census-trends').innerHTML = html ||
      '<p class="text-sm text-neutral-600">No multi-census population &amp; dwelling trends for the selected area(s). Municipalities (CSDs) outside Manitoba currently carry demographics only — pick a province, CMA/CA or census division for trend history.</p>';
    return models;
  }

  // Build one Population & Dwelling Trends table (all censuses) for an area,
  // returning both the HTML and the export model.
  function trendTableFor(subject) {
    const t = subject.trends || {};
    const pop = (y) => t[y]?.population;
    const cell = (row, y) => {
      if (row.popchg) {
        const i = years.indexOf(y);
        if (i <= 0) return '';
        const prev = pop(years[i - 1]), cur = pop(y);
        return (prev && cur != null) ? fPct1((cur - prev) / prev) : '';
      }
      return fmtVal(t[y]?.[row.key], row.fmt);
    };

    let body = '';
    for (const row of TREND_ROWS) {
      if (row.header) {
        body += `<tr><td colspan="${years.length + 1}" style="font-weight:600;background:#f3f4f6">${escapeHtml(row.header)}</td></tr>`;
        continue;
      }
      body += `<tr><td>${escapeHtml(row.label)}</td>${years.map(y => `<td>${cell(row, y)}</td>`).join('')}</tr>`;
    }
    const tableHtml = `
      <div class="cmhc-table-title">Population &amp; Dwelling Trends — ${escapeHtml(subject.name)}</div>
      <table class="cmhc-table">
        <thead><tr><th></th>${years.map(y => `<th>${y}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="text-xs text-neutral-500 mt-1 mb-3">* Occupied by usual residents.${(() => {
        const isWpg = subject.level.startsWith('WPG_');
        if (!isWpg) return '';
        const nYears = years.filter(y => t[y]?.population != null).length;
        return nYears <= 1
          ? ' Shown for 2021 only — earlier censuses use different dissemination-area boundaries for this Winnipeg geography.'
          : ' Pre-2021 Winnipeg figures are from City of Winnipeg census profiles (custom tabulation); 2021 is from CensusMapper, so a 2016→2021 step can be partly a source difference.';
      })()}</p>`;

    const rows = TREND_ROWS.map(row => row.header
      ? { area: row.header, values: years.map(() => '') }
      : { area: row.label, values: years.map(y => cell(row, y)) });
    return { tableHtml, model: { title: `Population & Dwelling Trends — ${subject.name}`, columns: years.slice(), rows } };
  }

  // ---- Demographics comparison table --------------------------------------
  function renderDemographics(cols, period) {
    const val = (r, key) => demoFor(r, period)?.[key];
    const amt = (r, row) => fmtVal(val(r, row.key), row.fmt);
    const pct = (r, row) => {
      if (!row.denom) return '';                          // row has no % (e.g. averages) — leave blank
      const d = val(r, row.denom), v = val(r, row.key);
      return (d && v != null) ? fPct0(v / d) : '**';      // % row but no data for this area → "**"
    };

    // Income/shelter section headers carry the income reference year, which is
    // the census year minus one (2021→2020, 2016→2015, 2011→2010) — rewrite the
    // hardcoded "(2020)" so earlier periods aren't mislabelled.
    const refYear = { '2021': '2020', '2016': '2015', '2011': '2010' }[period] || period;
    // Drop any row with no Amount for this period across every chosen area, then
    // drop any section left with no rows.
    const rowHasData = (row) => cols.some(r => amt(r, row) !== '');
    const sections = DEMO_SECTIONS
      .map(sec => ({ header: sec.header.replace('(2020)', `(${refYear})`), rows: sec.rows.filter(rowHasData) }))
      .filter(sec => sec.rows.length);

    const nCols = 1 + cols.length * 2;
    let body = '';
    for (const sec of sections) {
      body += `<tr><td colspan="${nCols}" style="font-weight:600;background:#f3f4f6">${escapeHtml(sec.header)}</td></tr>`;
      for (const row of sec.rows) {
        body += `<tr><td>${escapeHtml(row.label)}</td>` +
          cols.map(r => `<td>${amt(r, row)}</td><td>${pct(r, row)}</td>`).join('') + '</tr>';
      }
    }
    const regionHead = cols.map(r => `<th colspan="2">${escapeHtml(r.name)}</th>`).join('');
    const subHead    = cols.map(() => '<th>Amount</th><th>%</th>').join('');
    // Areas with no demographics for the chosen period (e.g. a Winnipeg cluster
    // when 2016/2011 is selected, or any area before the data rebuild).
    const noData = cols.filter(r => !demoFor(r, period)).map(r => r.name);
    const note = (period !== '2021' || noData.length) ? `
      <p class="text-xs text-neutral-500 mt-1">Demographics shown for ${escapeHtml(period)}.${
        period !== '2021' ? ' 2016/2011 are best-effort — rows whose fields differ across censuses (period-of-construction, income) are omitted.' : ''}${
        noData.length ? ` No ${escapeHtml(period)} demographics for: ${escapeHtml(noData.join(', '))}.` : ''}</p>` : '';
    const tableHtml = sections.length
      ? `<table class="cmhc-table">
          <thead>
            <tr><th></th>${regionHead}</tr>
            <tr><th>Category</th>${subHead}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>`
      : `<p class="text-sm text-neutral-600">No demographics available for ${escapeHtml(period)} for the selected areas.</p>`;
    $tables.querySelector('#census-demo').innerHTML = `
      <div class="cmhc-table-title">Demographics (${escapeHtml(period)}) — ${cols.map(r => escapeHtml(r.name)).join(' vs ')}</div>
      ${tableHtml}${note}`;

    // Export model mirrors the visible table — omitted rows/sections excluded.
    const columns = cols.flatMap(r => [r.name, '%']);
    const rows = [];
    for (const sec of sections) {
      rows.push({ area: sec.header, values: columns.map(() => '') });
      for (const row of sec.rows)
        rows.push({ area: row.label, values: cols.flatMap(r => [amt(r, row), pct(r, row)]) });
    }
    return { title: `Demographics (${period}) — ${cols.map(r => r.name).join(' vs ')}`, columns, rows };
  }

  // ---- Charts -------------------------------------------------------------
  function renderCharts(subject, cols, period) {
    $charts.replaceChildren();
    const t = subject.trends || {};
    const regionNames = cols.map(r => r.name);
    // Time-series charts stop at the selected census period — picking 2016
    // shows 2006/2011/2016 but not 2021.
    const shownYears = years.filter(y => Number(y) <= Number(period));

    // 1. Population trend — one line per chosen area, up to the selected census.
    const popRows = [];
    for (const r of cols) {
      const tr = r.trends || {};
      for (const y of shownYears) if (tr[y]?.population != null)
        popRows.push({ region: r.name, year: +y, value: tr[y].population });
    }
    if (popRows.length) {
      // Fit the x-axis to the census years actually present across the selected
      // areas (within the period cap) — so an area that only has 2016+2021
      // (e.g. SK/AB) doesn't render an empty 2006–2011 stretch.
      const yrs = [...new Set(popRows.map(d => d.year))].sort((a, b) => a - b);
      const loY = Math.min(...yrs), hiY = Math.max(...yrs);
      const maxV = Math.max(...popRows.map(d => d.value));
      // Only legend the areas that actually have a trend line (SK/AB/BC
      // municipalities have no trends), but keep each area's colour aligned with
      // the demographic charts by indexing PALETTE off the full area order.
      const popRegions = regionNames.filter(n => popRows.some(d => d.region === n));
      const popRange = popRegions.map(n => PALETTE[regionNames.indexOf(n) % PALETTE.length]);
      const svg = Plot.plot(themed({
        height: 250,
        x: { domain: [loY - 0.5, hiY + 0.5], ticks: yrs, tickFormat: 'd' },
        y: { label: 'Population', tickFormat: v => Number(v).toLocaleString(), domain: [0, maxV * 1.12] },
        color: { domain: popRegions, range: popRange, legend: popRegions.length > 1 },
        marks: [
          ...gridMarks(),
          Plot.lineY(popRows, { x: 'year', y: 'value', stroke: 'region', strokeWidth: 1.8 }),
          Plot.dot(popRows,  { x: 'year', y: 'value', fill: 'region', r: 3 }),
          frameMark(),
        ],
      }));
      appendCard('Population trend', `${loY}–${hiY} — ${regionNames.join(' vs ')}`, svg);
    }

    // 2. Occupied dwellings by type — stacked bar by census year (Area 1), up
    //    to the selected census.
    const typeOrder = TYPE_SERIES.map(([, lbl]) => lbl);
    const barData = [];
    for (const y of shownYears) {
      const yr = t[y]; if (!yr) continue;
      for (const [key, lbl] of TYPE_SERIES) {
        if (yr[key] != null) barData.push({ year: y, type: lbl, value: yr[key] });
      }
    }
    if (barData.length) {
      const svg = Plot.plot(themed({
        height: 250, marginBottom: 30,
        x: { type: 'band', label: null },
        y: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString() },
        color: { domain: typeOrder, range: categorical(typeOrder.length), legend: true },
        marks: [
          Plot.barY(barData, { x: 'year', y: 'value', fill: 'type', order: typeOrder }),
          frameMark(),
        ],
      }));
      appendCard('Dwelling type mix', `${subject.name} — occupied dwellings by structural type`, svg);
    }

    // 3 & 4. Comparison grouped bars (% share) at the selected period.
    appendGroupedBar('Age structure', '% of population', cols, regionNames, [
      ['age_0_14', '0–14'], ['age_15_64', '15–64'], ['age_65_plus', '65+'],
    ], 'population', period);
    appendGroupedBar('Household size', '% of households', cols, regionNames, [
      ['hh_size_1', '1'], ['hh_size_2', '2'], ['hh_size_3', '3'],
      ['hh_size_4', '4'], ['hh_size_5plus', '5+'],
    ], 'hh_size_total', period);
  }

  function appendGroupedBar(title, yLabel, cols, regionNames, cats, denomKey, period) {
    const rows = [];
    for (const r of cols) {
      const demo = demoFor(r, period);
      const denom = demo?.[denomKey];
      if (!denom) continue;
      for (const [key, catLabel] of cats) {
        const v = demo?.[key];
        if (v != null) rows.push({ region: r.name, cat: catLabel, value: v / denom * 100 });
      }
    }
    if (!rows.length) return;
    const maxV = Math.max(...rows.map(d => d.value));
    const svg = Plot.plot(themed({
      height: 250, marginBottom: 34,
      // Pin the facet (category) order to the noted sequence and the within-group
      // bar order to regionNames so both match the legend — otherwise Plot sorts
      // each band domain alphabetically (e.g. Manitoba before Winnipeg (CMA)).
      fx: { label: null, domain: cats.map(([, lbl]) => lbl) },
      x: { axis: null, label: null, domain: regionNames },
      y: { label: yLabel, tickFormat: v => `${v}%`, domain: [0, maxV * 1.15] },
      color: { domain: regionNames, range: PALETTE, legend: true },
      marks: [
        Plot.barY(rows, { fx: 'cat', x: 'region', y: 'value', fill: 'region' }),
        frameMark(),
      ],
    }));
    appendCard(title, period + ' — ' + regionNames.join(' vs '), svg);
  }

  function appendCard(title, sub, svgNode) {
    const card = document.createElement('section');
    card.className = 'chart-card';
    card.innerHTML = `<header class="chart-title">${escapeHtml(title)}</header>
      <p class="chart-sub">${escapeHtml(sub)}</p>
      <div data-role="plot"></div>
      <div class="chart-caption"><span class="chart-caption-left"></span>
        <span class="chart-source">Source: StatsCan Census</span></div>
      <div class="chart-actions"><button type="button" data-role="dl-png">Download PNG</button></div>`;
    card.querySelector('[data-role="plot"]').appendChild(svgNode);
    const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fname = `census-${slug}-${new Date().toISOString().slice(0, 10)}.png`;
    card.querySelector('[data-role="dl-png"]').onclick = () => downloadCard(card, fname, 'png');
    $charts.appendChild(card);
  }

  // Changing a picker's province repopulates its area list (first item selected).
  $prov.forEach((psel, i) => psel.addEventListener('change', () => {
    fillArea($area[i], psel.value);
    render();
  }));
  $area.forEach(sel => sel.addEventListener('change', render));
  $period?.addEventListener('change', render);
  render();

  // ---- Exports (tables) ---------------------------------------------------
  document.getElementById('census-download-xlsx')?.addEventListener('click', async () => {
    const tables = [...lastTrendTables, lastDemoTable].filter(Boolean);
    if (!tables.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(
      tables.map(t => ({ ...t, dwellingSuffix: '' })),
      { filename: `Census_Profile_${new Date().toISOString().slice(0, 10)}.xlsx`,
        titleNote: '— Census of Population (StatsCan / CensusMapper)' });
  });
  document.getElementById('census-copy')?.addEventListener('click', () => {
    const tbl = (t) => !t ? '' :
      `<h4>${escapeHtml(t.title)}</h4>` +
      `<table border="1" cellspacing="0" cellpadding="3"><tr><th></th>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('') +
      '</table>';
    copyHtml([...lastTrendTables, lastDemoTable].map(tbl).join('<br>'));
  });
}

// A categorical palette that stays distinct for up to 8 dwelling types.
function categorical(n) {
  const base = ['#1e3a8a', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];
  return base.slice(0, n);
}

function copyHtml(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch { navigator.clipboard?.writeText(text); }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
