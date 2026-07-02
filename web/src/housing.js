/*
 * Housing Stock view — the unified census housing-characteristics page.
 * Combines two StatsCan census datasets for one area + census-year view:
 *   - Structural type of dwelling (dwelling_types.json, r/10+10b/c/d) — chart + table
 *   - Period of construction (age) + dwelling condition (census_housing.json, r/07–09)
 * The two datasets cover different geographies — dwelling type is published at
 * Canada / province / CMA-CA level; age & condition at Canada / province /
 * municipality (CSD) level — so the area dropdown is the union of both and each
 * section renders only where the selected area has data. (The former standalone
 * "Dwelling Type" tab folded in here.)
 *
 * Views: a point-in-time profile for a single census year, or (default) a
 * comparison across census years.
 */

import * as Plot from '@observablehq/plot';
import { themed, frameMark, PALETTE } from './plot-theme.js';
import { downloadCard } from './chart.js';
import { mapCard, quantileChoropleth } from './map.js';
import { provinceGeo, hasProvinceGeo } from './geo.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { escapeHtml } from './escape.js';
import { miss, fInt as fmtN, fPct1 as fmtP } from './format.js';
import { PROV_LABEL } from './geography.js';
import { loadCensusProfile } from './census-profile.js';

// Common age buckets for the comparison view — each census's own bands rolled
// up to a shared set so the years line up despite different banding.
const COMMON_AGE = ['Pre-1961', '1961–1980', '1981–1990', '1991–2000', '2001–2010', '2011 or later'];
const ROLLUP = {
  '2021': [[0, 1, 2], [3, 4], [5], [6, 7], [8, 9], [10, 11]],  // 12 bands → 6
  '2016': [[0], [1], [2], [3], [4, 5], [6]],                   // 7 bands → 6
  '2011': [[0], [1], [2], [3], [4, 5], []],                    // 6 bands → 6 (no 2011+ band)
};
// 2006 has only a coarse before/after-1986 age split (no detailed bands), so it
// contributes to the comparable metrics (total dwellings, % major repairs) but
// is left out of the rolled-up age-mix comparison (no ROLLUP entry).
const ALL_YEARS = ['2006', '2011', '2016', '2021'];
// Winnipeg clusters/CAs carry the City's 8 age buckets (CITY_AGE_LABELS); this
// rolls them up to the same COMMON_AGE bands for the compare-across-years view.
const CLUSTER_ROLLUP = [[0], [1], [2], [3], [4, 5], [6, 7]];

// ---- Map (choropleth) config ----------------------------------------------
const HOUSING_MAP_METRICS = [
  { key: 'major',    label: 'Needing major repairs',   kind: 'pct' },
  { key: 'pre1961',  label: 'Built 1960 or before',    kind: 'pct' },
  { key: 'post2000', label: 'Built 2001 or later',     kind: 'pct' },
  { key: 'total',    label: 'Total private dwellings',  kind: 'int' },
];
// Compute a map metric from one census year's { total, age[], condition[ok,major] }.
// Exported (with housingMetricLatest) for unit testing — both are pure.
export function housingMetric(key, yd, year) {
  if (key === 'total') return Number.isFinite(Number(yd.total)) ? Number(yd.total) : null;
  if (key === 'major') {
    const c = yd.condition || [];
    const ok = Number(c[0] || 0), major = Number(c[c.length - 1] || 0), t = ok + major;
    return t > 0 ? (major / t) * 100 : null;                 // last condition category = major
  }
  const age = yd.age, spec = ROLLUP[year];                   // pre1961 / post2000 via the year's rollup
  if (!Array.isArray(age) || !age.length || !spec) return null;
  const total = age.reduce((s, v) => s + (Number(v) || 0), 0);
  if (!(total > 0)) return null;
  const idxs = key === 'pre1961' ? (spec[0] || []) : [...(spec[4] || []), ...(spec[5] || [])];
  return idxs.reduce((s, i) => s + (Number(age[i]) || 0), 0) / total * 100;
}
// Newest census year (of ALL_YEARS) for which the metric is computable, so every
// municipality shows its most recent figure (MB has 2006–2021; western CSDs 2016+).
export function housingMetricLatest(area, key) {
  for (let i = ALL_YEARS.length - 1; i >= 0; i--) {
    const yd = area.census?.[ALL_YEARS[i]];
    if (!yd) continue;
    const v = housingMetric(key, yd, ALL_YEARS[i]);
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}
const hMapLabel = (kind, v) => !Number.isFinite(v) ? 'No data'
  : kind === 'pct' ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString();
const hMapCompact = (kind, v) => !Number.isFinite(v) ? '**'
  : kind === 'pct' ? `${Math.round(v)}%`
  : (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

// Short labels for the 8 structural types (index-aligned across census years;
// 2006 leaves the last two null — see dwelling_types notes2006).
const DT_SHORT = ['Single-detached', 'Semi-detached', 'Row', 'Duplex',
                  'Apt <5', 'Apt 5+', 'Other attached', 'Movable'];

export async function initHousing() {
  const $province = document.getElementById('hsk-province');
  const $province2 = document.getElementById('hsk-province2');
  const $area = document.getElementById('hsk-area');
  const $area2 = document.getElementById('hsk-area2');
  const $compareSection = document.getElementById('hsk-compare-section');
  const $tables = document.getElementById('hsk-tables');
  const $headline = document.getElementById('hsk-headline');
  const $charts = document.getElementById('hsk-chart-grid');
  const $view = document.querySelectorAll('input[name="hskView"]');
  if (!$area || !$tables) return;

  const [housing, dwelling] = await Promise.all([
    fetch('./data/housing/census_housing.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/housing/dwelling_types.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!housing || !Array.isArray(housing.areas)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census housing data not found. Run r/07_scrape_census_housing.R.</p>';
    return;
  }

  const hByUid = new Map(housing.areas.map(a => [a.uid, a]));
  const dByUid = new Map((dwelling?.areas || []).map(a => [a.uid, a]));

  // --- Winnipeg clusters & community areas (from census_profile.json) ---------
  // Synthesised from the City-of-Winnipeg cluster/CA data (r/12 + r/12b): dwelling
  // type comes from `trends`, age + condition from `demo`. They carry their own
  // age/condition labels because the City banding differs from census_housing's.
  const profile = await loadCensusProfile();
  const DT_FROM_TREND = ['single_detached', 'semi_detached', 'row_house', 'apt_duplex',
                         'apt_lt5', 'apt_ge5', 'other_attached', 'movable'];  // → DT_SHORT order
  const AGE_KEYS = ['built_1960', 'built_1961_1980', 'built_1981_1990', 'built_1991_2000',
                    'built_2001_2005', 'built_2006_2010', 'built_2011_2015', 'built_2016_2021'];
  const CITY_AGE_LABELS = ['1960 or before', '1961 to 1980', '1981 to 1990', '1991 to 2000',
                           '2001 to 2005', '2006 to 2010', '2011 to 2015', '2016 to 2021'];
  const COND_LABELS = ['Regular maintenance or minor repairs needed', 'Major repairs needed'];
  const wpgAreas = [];
  for (const r of (profile?.regions || [])) {
    if (r.level !== 'WPG_Cluster' && r.level !== 'WPG_CA') continue;
    // dwelling-type area (from trends)
    const dCensus = {};
    for (const [y, t] of Object.entries(r.trends || {})) {
      const types = DT_FROM_TREND.map(k => t[k] ?? null);
      if (types.some(v => v != null)) dCensus[y] = { total: t.households ?? null, types };
    }
    if (Object.keys(dCensus).length) dByUid.set(r.uid, { uid: r.uid, name: r.name, level: r.level, census: dCensus });
    // housing area (age + condition, from demo)
    const hCensus = {}, periodLabels = {}, conditionLabels = {};
    for (const [y, d] of Object.entries(r.demo || {})) {
      const ageFull = AGE_KEYS.map(k => d[k] ?? null);
      let n = ageFull.length; while (n > 0 && ageFull[n - 1] == null) n--;
      const age = n ? ageFull.slice(0, n) : null;
      const condition = (d.condition_ok != null || d.condition_major != null)
        ? [d.condition_ok ?? 0, d.condition_major ?? 0] : null;
      if (age || condition) {
        hCensus[y] = { total: d.households ?? null, age: age || [], condition: condition || [] };
        if (age) periodLabels[y] = CITY_AGE_LABELS.slice(0, n);
        if (condition) conditionLabels[y] = COND_LABELS;
      }
    }
    if (Object.keys(hCensus).length) hByUid.set(r.uid, { uid: r.uid, name: r.name, level: r.level, census: hCensus, periodLabels, conditionLabels });
    if (Object.keys(dCensus).length || Object.keys(hCensus).length) wpgAreas.push({ uid: r.uid, name: r.name, level: r.level });
  }

  const nameByUid = new Map([...dByUid].map(([u, a]) => [u, a.name]).concat(
    [...hByUid].map(([u, a]) => [u, a.name])));   // census_housing / cluster names win on overlap

  // fmtN/fmtP/miss come from ./format.js; fmtP takes an already-computed percent.
  const major = (yd) => yd?.condition?.[yd.condition.length - 1];   // last condition cat = major
  const rollAge = (spec, age) => spec.map(ix => ix.reduce((s, i) => s + (age?.[i] || 0), 0));
  const dwellingYearsAsc = (dd) => ALL_YEARS.filter(y => dd.census?.[y]);

  // --- Province → Area cascade ----------------------------------------------
  // The flat union of both datasets is ~1,100 areas, so the picker is a
  // Province/region dropdown first, then an area dropdown scoped to it. Every
  // selectable area is tagged with a `region`: 'CA' for Canada, the province
  // uid for a province total, and the parent province uid for CMAs/CAs, CSDs
  // and Winnipeg sub-areas.
  const byName = (a, b) => a.name.localeCompare(b.name);
  const REGION_CANADA = 'CA';
  const allAreas = [];
  for (const a of housing.areas.filter(a => a.level === 'country'))
    allAreas.push({ uid: a.uid, name: a.name, level: 'country', region: REGION_CANADA });
  for (const a of housing.areas.filter(a => a.level === 'province'))
    allAreas.push({ uid: a.uid, name: a.name, level: 'province', region: a.uid });
  for (const a of (dwelling?.areas || []).filter(a => a.level === 'cma'))
    allAreas.push({ uid: a.uid, name: a.name, level: 'cma', region: a.prov });
  for (const a of housing.areas.filter(a => a.level === 'csd'))
    allAreas.push({ uid: a.uid, name: a.name, level: 'csd', region: a.prov });
  for (const a of wpgAreas)
    allAreas.push({ uid: a.uid, name: a.name, level: a.level, region: '46' });

  // Region picker = Canada + every province/territory (in the housing dataset).
  const regionOpts = [{ uid: REGION_CANADA, name: 'Canada' }].concat(
    housing.areas.filter(a => a.level === 'province').sort(byName)
      .map(a => ({ uid: a.uid, name: a.name })));
  // Honour the shared "home" province if the housing dataset carries it, else
  // Manitoba (or Canada if MB is absent). 'CA' stays a valid manual choice.
  const provinceCodes = regionOpts.map(r => r.uid).filter(u => /^\d{2}$/.test(u));
  const defaultRegion = resolveProvince(provinceCodes,
    regionOpts.some(r => r.uid === '46') ? '46' : (regionOpts[1]?.uid || REGION_CANADA));
  // The province total each region defaults to ('CA' → Canada).
  const regionDefaultArea = (region) =>
    region === REGION_CANADA ? (allAreas.find(a => a.region === REGION_CANADA)?.uid || '') : region;

  // Build the area <select>'s option HTML for one region, grouped so the CMA/CA,
  // Municipality and Winnipeg splits stay visible.
  const AREA_GROUPS = [
    ['Province total', 'province'], ['CMAs / CAs', 'cma'], ['Municipalities', 'csd'],
    ['Winnipeg — Community Areas', 'WPG_CA'], ['Winnipeg — Clusters', 'WPG_Cluster'],
  ];
  function buildAreaOptions(region, { includeNone = false } = {}) {
    const opt = (a) => `<option value="${escapeHtml(a.uid)}">${escapeHtml(a.name)}</option>`;
    const inRegion = allAreas.filter(a => a.region === region);
    let html;
    if (region === REGION_CANADA) {
      html = inRegion.filter(a => a.level === 'country').map(opt).join('');
    } else {
      html = AREA_GROUPS.map(([label, level]) => {
        const arr = inRegion.filter(a => a.level === level).sort(byName);
        return arr.length ? `<optgroup label="${escapeHtml(label)}">${arr.map(opt).join('')}</optgroup>` : '';
      }).join('');
    }
    return (includeNone ? '<option value="">— none —</option>' : '') + html;
  }

  // Populate region pickers and the initial area lists. Default to Manitoba —
  // it carries both datasets, so the default compare view shows dwelling type +
  // age + condition together.
  const regionOptsHtml = regionOpts.map(r => `<option value="${escapeHtml(r.uid)}">${escapeHtml(r.name)}</option>`).join('');
  $province.innerHTML = regionOptsHtml;
  $province.value = defaultRegion;
  $area.innerHTML = buildAreaOptions(defaultRegion);
  $area.value = hByUid.has(regionDefaultArea(defaultRegion)) ? regionDefaultArea(defaultRegion) : ($area.options[0]?.value || '');
  if ($province2) {
    $province2.innerHTML = regionOptsHtml;
    $province2.value = defaultRegion;
    $area2.innerHTML = buildAreaOptions(defaultRegion, { includeNone: true });
    $area2.value = '';
  }

  // ---- Map: province municipality choropleth that drives the Area picker ----
  const $mapHost = document.getElementById('hsk-map');
  let housingMap = null, $mapMetric = null, housingMapToken = 0;
  if ($mapHost) {
    const controls = document.createElement('div');
    controls.className = 'census-map-controls';
    controls.innerHTML = `<label for="hsk-map-metric" class="text-sm text-neutral-600">Map metric:</label>
      <select id="hsk-map-metric" class="border border-neutral-300 rounded px-2 py-1 text-sm">
        ${HOUSING_MAP_METRICS.map(m => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
      </select>`;
    $mapHost.appendChild(controls);
    $mapMetric = controls.querySelector('#hsk-map-metric');
    housingMap = mapCard($mapHost);
    $mapMetric.addEventListener('change', renderHousingMap);
  }

  // Municipalities in the selected region's province, shaded by the chosen housing
  // metric (newest census). Shown only when the region is a province (not Canada).
  async function renderHousingMap() {
    if (!housingMap) return;
    const prov = $province.value;
    if (!hasProvinceGeo(prov)) { housingMap.card.style.display = 'none'; return; }   // 'CA' → hide
    const token = ++housingMapToken;
    const geojson = await provinceGeo(prov, 'csd');
    if (token !== housingMapToken) return;
    if (!geojson) { housingMap.card.style.display = 'none'; return; }
    housingMap.card.style.display = '';
    const metric = HOUSING_MAP_METRICS.find(m => m.key === $mapMetric.value) || HOUSING_MAP_METRICS[0];
    const provName = PROV_LABEL[prov] || '';
    const entries = [];
    for (const a of hByUid.values()) {
      if (a.level !== 'csd' || String(a.uid).slice(0, 2) !== prov) continue;
      entries.push({ uid: a.uid, name: a.name, value: housingMetricLatest(a, metric.key) });
    }
    const { values, legend } = quantileChoropleth(entries, {
      label:   (v) => hMapLabel(metric.kind, v),
      compact: (v) => hMapCompact(metric.kind, v),
    });
    const selId = hByUid.get($area.value)?.level === 'csd' ? $area.value : null;
    housingMap.render({
      geojson, values, selectedId: selId,
      onSelect: (id) => {
        if (!hByUid.has(id)) return;
        $area.value = id;
        render();
      },
      title: `${provName} municipalities — ${metric.label.toLowerCase()}`,
      sub: 'Newest census · click a municipality to select it.',
      source: 'Boundaries: Statistics Canada 2021 (OGL–Canada) · Data: StatsCan Census',
      legend,
      filename: `housing_map_${provName}_${metric.key}.png`.replace(/\s+/g, '-'),
    });
  }

  const viewVal = () => [...$view].find(r => r.checked)?.value || 'compare';
  let lastTables = [];

  // ===========================================================================
  // Dwelling type (structural type) — chart + table, where the area has data
  // ===========================================================================
  function dwellCompare(dd, name) {
    const ys = dwellingYearsAsc(dd);
    if (!ys.length) return;
    // Chart: stacked bar of structural types across census years.
    const data = [];
    for (const y of ys) {
      const c = dd.census[y];
      DT_SHORT.forEach((lbl, i) => { if (c.types?.[i] != null) data.push({ year: y, type: lbl, value: c.types[i] }); });
    }
    if (data.length) {
      const svg = Plot.plot(themed({
        height: 250, marginBottom: 30,
        x: { type: 'band', label: null },
        y: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString() },
        color: { domain: DT_SHORT, range: PALETTE, legend: true },
        marks: [Plot.barY(data, { x: 'year', y: 'value', fill: 'type', order: DT_SHORT }), frameMark()],
      }));
      appendCard('Dwelling type mix', `${name} — occupied dwellings by structural type`, svg);
    }
    // Table: types × census years (counts), with % share of the latest year.
    const last = ys[ys.length - 1];
    const totL = dd.census[last]?.total || 0;
    const rows = DT_SHORT.map((lbl, i) => ({
      area: lbl,
      values: [...ys.map(y => fmtN(dd.census[y]?.types?.[i])),
               fmtP(totL > 0 && dd.census[last]?.types?.[i] != null ? dd.census[last].types[i] / totL * 100 : null)],
    }));
    rows.push({ area: 'Total', values: [...ys.map(y => fmtN(dd.census[y]?.total)), '100.0%'] });
    const cols = [...ys, `${last} share`];
    const note = dwelling?.notes2006 && ys.includes('2006')
      ? `<p class="text-xs text-neutral-500 mt-2">${escapeHtml(dwelling.notes2006)}</p>` : '';
    appendBlock(`Structural type of dwelling — ${ys.join(' / ')}`,
      compareTable(['Structural type', ...cols], rows) + note);
    lastTables.push({ title: `${name} — dwelling type ${ys.join('/')}`, columns: cols, rows });
  }

  function dwellYear(dd, name, year) {
    const c = dd.census?.[year];
    if (!c) return;
    const total = c.total || 0;
    const share = (v) => (total > 0 && v != null) ? v / total * 100 : null;
    // Chart: horizontal bar of structural types for the year.
    const data = DT_SHORT.map((lbl, i) => ({ type: lbl, value: c.types?.[i] })).filter(d => d.value != null);
    if (data.length) {
      const svg = Plot.plot(themed({
        height: 250, marginLeft: 110, marginBottom: 28,
        x: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString(), inset: 0 },
        y: { label: null },
        color: { legend: false },
        marks: [
          Plot.gridX({ stroke: '#d4d4d8', strokeDasharray: '3,3' }),
          Plot.barX(data, { x: 'value', y: 'type', fill: PALETTE[0], sort: { y: '-x' } }),
          frameMark(),
        ],
      }));
      appendCard('Dwelling type mix', `${name} — structural type (${year} Census)`, svg);
    }
    const rows = DT_SHORT.map((lbl, i) => ({ area: lbl, values: [fmtN(c.types?.[i]), fmtP(share(c.types?.[i]))] }));
    rows.push({ area: 'Total', values: [fmtN(total), '100.0%'] });
    const note = (c.types?.some(v => v == null) && dwelling?.notes2006)
      ? `<p class="text-xs text-neutral-500 mt-2">${escapeHtml(dwelling.notes2006)}</p>` : '';
    appendBlock(`Structural type of dwelling — ${year}`,
      summaryTable(['Structural type', 'Dwellings', 'Share'], rows) + note);
    lastTables.push({ title: `${name} — dwelling type (${year})`, columns: ['Dwellings', 'Share'], rows });
  }

  // ===========================================================================
  // Age (period of construction) + condition — tables, where the area has data
  // ===========================================================================
  function housingYear(hd, name, year) {
    const yd = hd.census?.[year];
    if (!yd) {
      appendBlock('Housing stock', `<p class="text-sm text-neutral-600">No ${year} age/condition data for this area (boundary change or suppressed).</p>`);
      return;
    }
    const total = yd.total || 0;
    const share = (v) => (total > 0 && v != null) ? (v / total * 100) : null;
    const periodLabels = hd.periodLabels?.[year] || housing.periodLabels[year];
    const condLabels   = hd.conditionLabels?.[year] || housing.conditionLabels[year];
    const ageRows  = periodLabels.map((lbl, i) => ({ area: lbl, values: [fmtN(yd.age?.[i]),       fmtP(share(yd.age?.[i]))] }));
    const condRows = condLabels.map((lbl, i)   => ({ area: lbl, values: [fmtN(yd.condition?.[i]), fmtP(share(yd.condition?.[i]))] }));
    const withTotal = (rows) => rows.concat([{ area: 'Total', values: [fmtN(total), '100.0%'] }]);
    appendBlock(`Age — period of construction (${year})`, summaryTable(['Category', 'Dwellings', 'Share'], withTotal(ageRows)));
    appendBlock(`Condition — repairs needed (${year})`, summaryTable(['Category', 'Dwellings', 'Share'], withTotal(condRows)));
    lastTables.push(
      { title: `${name} — period of construction (${year})`, columns: ['Dwellings', 'Share'], rows: withTotal(ageRows) },
      { title: `${name} — dwelling condition (${year})`,      columns: ['Dwellings', 'Share'], rows: withTotal(condRows) });
  }

  function housingCompare(hd, name) {
    const years = ALL_YEARS.filter(y => hd.census?.[y]);   // ascending
    if (years.length < 2) {
      appendBlock('Housing stock',
        `<p class="text-sm text-neutral-600">Age/condition comparison needs at least two census years; this area has ${years.join(', ') || 'none'}.</p>`);
      if (years.length === 1) housingYear(hd, name, years[0]);
      return;
    }
    const yd = (y) => hd.census[y];
    const tot = (y) => yd(y).total || 0;
    const majPct = (y) => { const t = tot(y), m = major(yd(y)); return (t > 0 && m != null) ? m / t * 100 : null; };
    const first = years[0], last = years[years.length - 1];
    const totChg = tot(first) > 0 ? (tot(last) - tot(first)) / tot(first) * 100 : null;
    const ppChg  = (majPct(last) != null && majPct(first) != null) ? majPct(last) - majPct(first) : null;
    const fmtDeltaPct = (v) => miss(v) ? '**' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
    const fmtDeltaPP  = (v) => miss(v) ? '**' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)} pp`;

    const headRows = [
      { area: 'Total private dwellings', values: [...years.map(y => fmtN(tot(y))), fmtDeltaPct(totChg)] },
      { area: 'Needing major repairs',   values: [...years.map(y => `${fmtN(major(yd(y)))} (${fmtP(majPct(y))})`), fmtDeltaPP(ppChg)] },
    ];
    const chgCol = `Δ ${first}→${last}`;
    appendBlock(`Housing stock — ${years.join(' / ')}`, compareTable(['', ...years, chgCol], headRows));
    lastTables.push({ title: `${name} — housing stock ${years.join('/')}`, columns: [...years, chgCol], rows: headRows });

    const isWpg = String(hd.level || '').startsWith('WPG_');
    const ageYears = years.filter(y => isWpg ? hd.census[y]?.age?.length : ROLLUP[y]);
    if (ageYears.length >= 2) {
      const aFirst = ageYears[0], aLast = ageYears[ageYears.length - 1];
      const rolled = Object.fromEntries(ageYears.map(y => [y, rollAge(isWpg ? CLUSTER_ROLLUP : ROLLUP[y], yd(y).age)]));
      // Chart: stacked bar of age bands (counts) across census years — mirrors the
      // dwelling type mix chart so the two sit side by side in the chart grid.
      const ageData = [];
      for (const y of ageYears) COMMON_AGE.forEach((lbl, i) => ageData.push({ year: y, band: lbl, value: rolled[y][i] }));
      const ageChart = Plot.plot(themed({
        height: 250, marginBottom: 30,
        x: { type: 'band', label: null },
        y: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString() },
        color: { domain: COMMON_AGE, range: PALETTE, legend: true },
        marks: [Plot.barY(ageData, { x: 'year', y: 'value', fill: 'band', order: COMMON_AGE }), frameMark()],
      }));
      appendCard('Age mix', `${name} — occupied dwellings by period of construction`, ageChart);
      const ageRows = COMMON_AGE.map((lbl, i) => {
        const sh = (y) => tot(y) > 0 ? rolled[y][i] / tot(y) * 100 : null;
        return { area: lbl, values: [...ageYears.map(y => fmtP(sh(y))), fmtDeltaPP(sh(aLast) != null && sh(aFirst) != null ? sh(aLast) - sh(aFirst) : null)] };
      });
      const ageChg = `Δ ${aFirst}→${aLast}`;
      appendBlock('Age mix (share of dwellings)', compareTable(['Period of construction', ...ageYears, ageChg], ageRows));
      lastTables.push({ title: `${name} — age mix ${ageYears.join('/')}`, columns: [...ageYears, ageChg], rows: ageRows });
    }
  }

  // --- Headline --------------------------------------------------------------
  function renderHeadline(name, hd, dd, v) {
    if (hd) {
      if (v === 'compare') {
        const years = ALL_YEARS.filter(y => hd.census?.[y]);
        if (years.length >= 2) {
          const tot = (y) => hd.census[y].total || 0;
          const majP = (y) => { const t = tot(y), m = major(hd.census[y]); return (t > 0 && m != null) ? m / t * 100 : null; };
          const f = years[0], l = years[years.length - 1];
          const d = tot(f) > 0 ? (tot(l) - tot(f)) / tot(f) * 100 : null;
          $headline.innerHTML = `
            <div class="cmhc-hsk-title">${escapeHtml(name)} — housing stock <span>(${f} → ${l})</span></div>
            <div class="cmhc-hsk-stats">
              <span>Dwellings <strong>${fmtN(tot(f))} → ${fmtN(tot(l))}</strong> (${d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'})</span>
              <span>Major repairs <strong>${fmtP(majP(f))} → ${fmtP(majP(l))}</strong></span>
            </div>`;
          return;
        }
      } else {
        const yd = hd.census?.[v];
        if (yd) {
          const total = yd.total || 0, share = (x) => (total > 0 && x != null) ? x / total * 100 : null;
          const since = yd.age?.[yd.age.length - 1];
          const pLabels = hd.periodLabels?.[v] || housing.periodLabels[v];
          $headline.innerHTML = `
            <div class="cmhc-hsk-title">${escapeHtml(name)} — housing stock <span>(${v} Census)</span></div>
            <div class="cmhc-hsk-stats">
              <span><strong>${fmtN(total)}</strong> private dwellings</span>
              <span><strong>${fmtP(share(major(yd)))}</strong> need major repairs</span>
              <span><strong>${fmtP(share(since))}</strong> built ${escapeHtml(pLabels.slice(-1)[0] || 'recently')}</span>
            </div>`;
          return;
        }
      }
    }
    if (dd) {
      const ys = dwellingYearsAsc(dd), ly = ys[ys.length - 1], c = dd.census[ly], total = c.total || 0;
      const apt = (c.types?.[3] || 0) + (c.types?.[4] || 0) + (c.types?.[5] || 0);  // duplex + apt<5 + apt5+
      $headline.innerHTML = `
        <div class="cmhc-hsk-title">${escapeHtml(name)} — dwellings by type <span>(${ly} Census)</span></div>
        <div class="cmhc-hsk-stats">
          <span><strong>${fmtN(total)}</strong> private dwellings</span>
          <span><strong>${fmtP(total ? c.types?.[0] / total * 100 : null)}</strong> single-detached</span>
          <span><strong>${fmtP(total ? apt / total * 100 : null)}</strong> apartments</span>
        </div>`;
      return;
    }
    $headline.innerHTML = `<div class="cmhc-hsk-title">${escapeHtml(name)}</div>`;
  }

  // --- HTML builders ---------------------------------------------------------
  function appendBlock(title, innerHtml) {
    $tables.insertAdjacentHTML('beforeend',
      `<section class="cmhc-table-block"><div class="cmhc-table-title">${escapeHtml(title)}</div>${innerHtml}</section>`);
  }
  function summaryTable(headers, rows) {
    const body = rows.map(r => {
      const cls = r.area === 'Total' ? ' class="cmhc-table-summary cmhc-table-summary-top"' : '';
      return `<tr${cls}><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="cmhc-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }
  function compareTable(headers, rows) {
    const body = rows.map(r => {
      const cls = r.area === 'Total' ? ' class="cmhc-table-summary cmhc-table-summary-top"' : '';
      return `<tr${cls}><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="cmhc-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
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
    const fname = `housing-stock-${slug}-${new Date().toISOString().slice(0, 10)}.png`;
    card.querySelector('[data-role="dl-png"]').onclick = () => downloadCard(card, fname, 'png');
    $charts?.appendChild(card);
  }

  // ===========================================================================
  // Two-area comparison (single-census point-in-time view only). Uses universal
  // bases so any two areas line up: the 8 DT types, COMMON_AGE-rolled age, and
  // condition collapsed to regular/minor vs major.
  // ===========================================================================
  function shareChart(title, sub, catLabels, areas) {       // areas: [{name, shares:[pct|null]}]
    const data = [];
    areas.forEach(a => catLabels.forEach((lbl, i) => {
      if (a.shares[i] != null) data.push({ area: a.name, cat: lbl, value: a.shares[i] });
    }));
    if (!data.length) return;
    const maxV = Math.max(...data.map(d => d.value));
    const svg = Plot.plot(themed({
      height: 260, marginBottom: 42,
      fx: { label: null }, x: { axis: null, label: null },
      y: { label: '% of dwellings', tickFormat: v => `${v}%`, domain: [0, maxV * 1.15] },
      color: { domain: areas.map(a => a.name), range: PALETTE, legend: true },
      marks: [Plot.barY(data, { fx: 'cat', x: 'area', y: 'value', fill: 'area' }), frameMark()],
    }));
    appendCard(title, sub, svg);
  }
  function twoAreaTable(title, catLabels, areas) {           // areas: [{name, counts:[...], total}]
    const headers = ['', ...areas.flatMap(a => [a.name, '%'])];
    const sh = (a, i) => (a.total > 0 && a.counts[i] != null) ? a.counts[i] / a.total * 100 : null;
    const rows = catLabels.map((lbl, i) => ({ area: lbl, values: areas.flatMap(a => [fmtN(a.counts[i]), fmtP(sh(a, i))]) }));
    rows.push({ area: 'Total', values: areas.flatMap(a => [fmtN(a.total), '100.0%']) });
    appendBlock(title, compareTable(headers, rows));
    lastTables.push({ title, columns: headers.slice(1), rows });
  }

  function dwellYearCompare(d1, d2, n1, n2, year) {
    const c1 = d1?.census?.[year], c2 = d2?.census?.[year];
    if (!c1 && !c2) return;
    const mk = (nm, c) => c ? { name: nm, shares: DT_SHORT.map((_, i) => (c.total > 0 && c.types?.[i] != null) ? c.types[i] / c.total * 100 : null) } : null;
    shareChart('Dwelling type mix', `${n1} vs ${n2} — structural type (${year} Census)`, DT_SHORT, [mk(n1, c1), mk(n2, c2)].filter(Boolean));
    twoAreaTable(`Structural type of dwelling — ${year}`, DT_SHORT,
      [c1 && { name: n1, counts: c1.types || [], total: c1.total || 0 }, c2 && { name: n2, counts: c2.types || [], total: c2.total || 0 }].filter(Boolean));
  }

  function housingYearCompare(h1, h2, n1, n2, year) {
    const y1 = h1?.census?.[year], y2 = h2?.census?.[year];
    if (!y1 && !y2) return;
    const rollFor = (h, yd) => {
      if (!yd) return null;
      const spec = String(h.level || '').startsWith('WPG_') ? CLUSTER_ROLLUP : ROLLUP[year];
      return spec ? rollAge(spec, yd.age) : null;
    };
    const r1 = rollFor(h1, y1), r2 = rollFor(h2, y2);
    const ageShare = (nm, yd, rolled) => (rolled && yd) ? { name: nm, shares: rolled.map(v => yd.total > 0 ? v / yd.total * 100 : null) } : null;
    if (r1 || r2) {
      shareChart('Age mix', `${n1} vs ${n2} — period of construction (${year}, common bands)`, COMMON_AGE,
        [ageShare(n1, y1, r1), ageShare(n2, y2, r2)].filter(Boolean));
      twoAreaTable(`Age — period of construction (${year}, common bands)`, COMMON_AGE,
        [r1 && { name: n1, counts: r1, total: y1.total || 0 }, r2 && { name: n2, counts: r2, total: y2.total || 0 }].filter(Boolean));
    } else {
      appendBlock('Age — period of construction', `<p class="text-sm text-neutral-600">No comparable age bands for ${escapeHtml(year)} (2006 is a coarse split).</p>`);
    }
    // condition collapsed to regular/minor vs major (handles 2- and 3-category years)
    const cond2 = (yd) => { const c = yd?.condition; if (!c || !c.length) return null; return c.length >= 3 ? [c[0] + c[1], c[c.length - 1]] : [c[0] ?? 0, c[c.length - 1] ?? 0]; };
    const k1 = cond2(y1), k2 = cond2(y2), COND2 = ['Regular / minor repairs', 'Major repairs'];
    const condShare = (nm, yd, k) => k ? { name: nm, shares: k.map(v => yd.total > 0 ? v / yd.total * 100 : null) } : null;
    if (k1 || k2) {
      shareChart('Dwelling condition', `${n1} vs ${n2} — repairs needed (${year})`, COND2,
        [condShare(n1, y1, k1), condShare(n2, y2, k2)].filter(Boolean));
      twoAreaTable(`Condition — repairs needed (${year})`, COND2,
        [k1 && { name: n1, counts: k1, total: y1.total || 0 }, k2 && { name: n2, counts: k2, total: y2.total || 0 }].filter(Boolean));
    }
  }

  // --- Orchestration ---------------------------------------------------------
  function render() {
    renderHousingMap();
    const uid = $area.value;
    const name = nameByUid.get(uid) || uid;
    const hd = hByUid.get(uid), dd = dByUid.get(uid);
    const v = viewVal();
    const compareMode = v !== 'compare';
    // The second-area picker is a point-in-time option only.
    if ($compareSection) $compareSection.hidden = !compareMode;
    const uid2 = compareMode && $area2 ? $area2.value : '';
    const name2 = uid2 ? (nameByUid.get(uid2) || uid2) : '';
    const hd2 = uid2 ? hByUid.get(uid2) : null, dd2 = uid2 ? dByUid.get(uid2) : null;

    $charts?.replaceChildren();
    $tables.innerHTML = '';
    lastTables = [];

    renderHeadline(name, hd, dd, v);

    if (uid2) {                                   // two-area point-in-time comparison
      if (dd || dd2) dwellYearCompare(dd, dd2, name, name2, v);
      if (hd || hd2) housingYearCompare(hd, hd2, name, name2, v);
      if (!dd && !dd2 && !hd && !hd2)
        $tables.innerHTML = '<p class="text-sm text-neutral-600">No census data for either area.</p>';
      return;
    }

    if (dd) { v === 'compare' ? dwellCompare(dd, name) : dwellYear(dd, name, v); }
    if (hd) { v === 'compare' ? housingCompare(hd, name) : housingYear(hd, name, v); }

    if (!dd && !hd) {
      $tables.innerHTML = '<p class="text-sm text-neutral-600">No census data for this area.</p>';
    } else if (!hd && dd) {
      $tables.insertAdjacentHTML('beforeend',
        '<p class="text-xs text-neutral-500">Age &amp; condition are published at the municipality level (plus Winnipeg clusters/CAs) — pick one of those to see them.</p>');
    } else if (hd && !dd) {
      $tables.insertAdjacentHTML('beforeend',
        '<p class="text-xs text-neutral-500">Structural type is published at the CMA/CA, province &amp; Canada level — pick a CMA or province to see the dwelling-type breakdown.</p>');
    }
  }

  // Province change → rescope (and reset to the province total) the area list.
  $province.addEventListener('change', () => {
    const region = $province.value;
    rememberProvince(region);                       // shared home province ('CA' is ignored)
    const def = regionDefaultArea(region);
    $area.innerHTML = buildAreaOptions(region);
    $area.value = def || $area.options[0]?.value || '';
    render();
  });
  $area.addEventListener('change', render);

  $province2?.addEventListener('change', () => {
    $area2.innerHTML = buildAreaOptions($province2.value, { includeNone: true });
    $area2.value = '';
    render();
  });
  $area2?.addEventListener('change', render);
  $view.forEach(r => r.addEventListener('change', render));
  render();

  // --- Exports ---------------------------------------------------------------
  document.getElementById('hsk-download-xlsx')?.addEventListener('click', async () => {
    if (!lastTables.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(
      lastTables.map(t => ({ ...t, dwellingSuffix: '' })),
      { filename: `Census_HousingStock_${new Date().toISOString().slice(0, 10)}.xlsx`,
        maxYear: 2021, titleNote: '— Census of Population (StatsCan)' });
  });
  document.getElementById('hsk-copy')?.addEventListener('click', () => {
    const html = lastTables.map(t =>
      `<h4>${escapeHtml(t.title)}</h4>` +
      `<table border="1" cellspacing="0" cellpadding="3"><tr><th></th>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('') +
      '</table>').join('<br>');
    copyHtml(html);
  });
}

function copyHtml(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch {
    navigator.clipboard?.writeText(text);
  }
}
