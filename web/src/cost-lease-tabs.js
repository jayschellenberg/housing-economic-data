/*
 * Construction Cost and Commercial Leasing tabs. Both used to be sections of
 * Market Indicators; their catalog groups are now tagged `tab: "construction"`
 * / `tab: "leasing"`, which keeps them off that tab (snapshot, sections, Excel)
 * and renders them here instead. Each tab is the group's catalog charts under
 * a geography + year sidebar, with an indexing tool on top:
 *
 *   Construction Cost — a build cost from a year (or quarter) indexed to the
 *     latest BCPI quarter, by building type, Winnipeg. Winnipeg BCPI starts
 *     2017Q1 (no StatsCan building-price index covers Winnipeg earlier), so
 *     older years chain onto a proxy: Winnipeg NHPI house-only for residential
 *     types, and the viewer's choice of 15-CMA composite / Calgary / Edmonton /
 *     their average for non-residential types.
 *   Commercial Leasing — a rent indexed by CRSPI and by CPI, side by side.
 *     Local CRSPI starts 2019Q1 and chains onto Canada CRSPI (2006+) before
 *     that; CPI runs from 1971 (Canada 1914).
 *
 * The renderer follows agriculture.js: the shared buildIndicatorCard over the
 * indicator shards, with this tab's own DOM ids (prefix cc- / cl-).
 */

import { buildIndicatorCard, readOpenPanels, aggregateDashedIds, geoQualifiedLabels } from './indicator-chart.js';
import { chartSources } from './indicator-sources.js';
import { getPref, setPref } from './prefs.js';
import { escapeHtml } from './escape.js';
import { toQuarterly, chain, averageSeries, indexToCurrent, fmtQuarter } from './index-tool-math.js';

const loadJson = (path) =>
  fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch(() => null);

const GEO_ORDER = ['Winnipeg-CMA', 'MB', 'CA', 'Calgary-CMA', 'Edmonton-CMA', 'Regina-CMA', 'Saskatoon-CMA',
  'Vancouver-CMA', 'Victoria-CMA', 'Prairies'];
const GEO_LABEL = {
  'Winnipeg-CMA': 'Winnipeg', MB: 'Manitoba', CA: 'Canada', 'Calgary-CMA': 'Calgary', 'Edmonton-CMA': 'Edmonton',
  'Regina-CMA': 'Regina', 'Saskatoon-CMA': 'Saskatoon', 'Vancouver-CMA': 'Vancouver', 'Victoria-CMA': 'Victoria',
  Prairies: 'Prairie Region',
};
const geoRank = (g) => (GEO_ORDER.indexOf(g) + 1) || 99;
const money = (v) => `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Per-tab wiring. `groups` are the catalog displayGroups the tab renders.
const TABS = {
  construction: {
    prefix: 'cc', groups: ['construction_cost'], fileBase: 'ConstructionCost',
    heading: 'Construction Cost', buildTool: buildConstructionTool,
  },
  leasing: {
    prefix: 'cl', groups: ['commercial_leasing'], fileBase: 'CommercialLeasing',
    heading: 'Commercial Leasing', buildTool: buildLeaseTool,
  },
};

export const initConstruction = () => initCostLeaseTab('construction');
export const initLeasing = () => initCostLeaseTab('leasing');

/**
 * The checked geographies, in tab order — never empty. A saved selection is
 * kept to geographies the tab actually has; with nothing usable saved, the
 * defaults (Winnipeg + Canada) that are present, else the first available.
 *
 * @param {string[]|null} saved
 * @param {string[]} available
 * @returns {string[]}
 */
export function resolveGeos(saved, available) {
  const pick = (want) => available.filter((g) => want.includes(g));
  const fromSaved = Array.isArray(saved) ? pick(saved) : [];
  if (fromSaved.length) return fromSaved;
  const defaults = pick(['Winnipeg-CMA', 'CA']);
  return defaults.length ? defaults : available.slice(0, 1);
}

const done = new Set();

async function initCostLeaseTab(key) {
  if (done.has(key)) return;
  done.add(key);
  const cfg = TABS[key];
  const $ = (id) => document.getElementById(`${cfg.prefix}-${id}`);
  const $grid = $('chart-grid');
  if (!$grid) return;

  const [catalog, manifest] = await Promise.all([
    loadJson('./data/indicators/_catalog.json'),
    loadJson('./data/indicators-manifest.json'),
  ]);
  if (!catalog) {
    $grid.innerHTML = '<p class="text-sm text-red-700">Indicator catalog not found. Re-run r/14_build_indicators.R.</p>';
    return;
  }
  // Every shard: the tools borrow series from other groups (NHPI house-only
  // from prices, CPI from economy).
  const groups = (manifest?.groups || []).map((g) => g.group);
  const shards = Object.fromEntries((await Promise.all(
    groups.map(async (g) => [g, await loadJson(`./data/indicators/${g}.json`)]))).filter(([, d]) => d));
  const seriesById = {};
  const recordsById = {};
  for (const sh of Object.values(shards)) {
    for (const s of sh.series || []) seriesById[s.id] = s;
    for (const r of sh.records || []) (recordsById[r.id] ||= []).push(r);
  }
  for (const arr of Object.values(recordsById)) arr.sort((a, b) => a.date.localeCompare(b.date));

  cfg.buildTool($('tool'), { seriesById, recordsById });

  // Charts: the tab's catalog groups, in group then chart order.
  const charts = Object.entries(catalog.charts || {})
    .filter(([, c]) => cfg.groups.includes(c.displayGroup))
    .sort((a, b) => (cfg.groups.indexOf(a[1].displayGroup) - cfg.groups.indexOf(b[1].displayGroup))
      || ((a[1].order || 99) - (b[1].order || 99)))
    .map(([chartId, c]) => ({ chartId, cfg: c, meta: Object.values(seriesById).filter((s) => s.chartId === chartId) }))
    .filter((c) => c.meta.some((s) => recordsById[s.id]?.length));

  // Geography checkboxes: the geographies the multi-geography charts carry.
  // A single-geography chart always draws (see renderCharts), so its geography
  // (the Prairie Region building-type split) would be a box that does nothing.
  const geosOf = (list) => [...new Set(list.flatMap((c) => c.meta.map((s) => s.geo)))];
  const multiGeo = charts.filter((c) => new Set(c.meta.map((s) => s.geo)).size > 1);
  const available = (multiGeo.length ? geosOf(multiGeo) : geosOf(charts)).sort((a, b) => geoRank(a) - geoRank(b));
  const prefKey = `${cfg.prefix}Geos`;
  let selected = resolveGeos(getPref(prefKey), available);
  const $geos = $('geo-toggles');
  $geos?.replaceChildren(...available.map((g) => {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = g;
    box.checked = selected.includes(g);
    box.addEventListener('change', () => {
      const checked = [...$geos.querySelectorAll('input:checked')].map((b) => b.value);
      if (!checked.length) { box.checked = true; return; }   // never empty
      selected = resolveGeos(checked, available);
      setPref(prefKey, selected);
      renderCharts();
    });
    const text = document.createElement('span');
    text.textContent = GEO_LABEL[g] || g;
    label.append(box, text);
    return label;
  }));

  // Year range — default the last ten years; "All" reaches 1981 for the
  // non-residential composite and 2006 for national CRSPI.
  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const c of charts) for (const s of c.meta) for (const r of recordsById[s.id] || []) {
    const y = +r.date.slice(0, 4);
    if (y < minYear) minYear = y;
    if (y > maxYear) maxYear = y;
  }
  const $from = $('year-from');
  const $to = $('year-to');
  if ($from && $to && Number.isFinite(minYear)) {
    const opts = ['<option value="">All</option>'];
    for (let y = maxYear; y >= minYear; y--) opts.push(`<option value="${y}">${y}</option>`);
    $from.innerHTML = opts.join('');
    $to.innerHTML = opts.join('');
    $from.value = String(Math.max(minYear, maxYear - 10));
    $from.addEventListener('change', renderCharts);
    $to.addEventListener('change', renderCharts);
  }

  // Excel (data): every chart as drawn.
  let exportCharts = [];
  const $xlsx = $('download-xlsx');
  $xlsx?.addEventListener('click', async () => {
    if (!exportCharts.length) return;
    const original = $xlsx.textContent;
    $xlsx.disabled = true;
    $xlsx.textContent = 'Preparing…';
    try {
      const { exportChartDataToExcel } = await import('./excel-export.js');
      await exportChartDataToExcel(exportCharts, {
        filename: `${cfg.fileBase}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        heading: cfg.heading,
      });
      $xlsx.textContent = original;
    } catch (err) {
      console.error(`[${key} excel]`, err);
      $xlsx.textContent = 'Export failed';
      setTimeout(() => { $xlsx.textContent = original; }, 2000);
    } finally {
      $xlsx.disabled = false;
    }
  });

  renderCharts();

  function renderCharts() {
    const monthFrom = $from?.value ? `${$from.value}-01` : null;
    const monthTo = $to?.value ? `${$to.value}-12` : null;
    const inRange = (d) => (!monthFrom || d.slice(0, 7) >= monthFrom) && (!monthTo || d.slice(0, 7) <= monthTo);
    // Cards rebuild on every control change; keep open tables/explainers.
    const openPanels = new Map([...$grid.querySelectorAll('.cmhc-indicator-card')]
      .map((c) => [c.dataset.chartId, readOpenPanels(c)]).filter(([, p]) => p.length));
    $grid.replaceChildren();
    exportCharts = [];
    const section = document.createElement('div');
    section.className = 'cmhc-mi-section-grid grid md:grid-cols-2 gap-4';
    $grid.appendChild(section);   // attached first: cards measure their width
    const geos = new Set(selected);
    for (const c of charts) {
      // Single-geography charts (building type splits, Winnipeg / Canada
      // only) always draw; multi-geography ones follow the checkboxes.
      const chartGeos = new Set(c.meta.map((s) => s.geo));
      const meta = (chartGeos.size > 1 ? c.meta.filter((s) => geos.has(s.geo)) : c.meta.slice())
        .sort((a, b) => geoRank(a.geo) - geoRank(b.geo));
      if (!meta.length) continue;
      const records = meta.flatMap((s) => recordsById[s.id] || []);
      if (!records.length) continue;
      const ids = new Set(meta.map((s) => s.id));
      const refs = chartSources(catalog, c.chartId, ids);
      const card = buildIndicatorCard(section, {
        chartId: c.chartId,
        title: c.cfg.title,
        sourceLabel: refs.short || 'Statistics Canada',
        sources: refs.items,
        description: c.cfg.description,
        table: true,
        sourceInCaption: true, signed: false, captionPt: 10,
        mirrorY: false,
      });
      const geoLabel = [...new Set(meta.map((s) => GEO_LABEL[s.geo] || s.geo))];
      const subtitle = `${chartGeos.size > 1 ? `${geoLabel.join(' + ')} • ` : ''}quarterly`;
      card.render(records, meta, {
        subtitle, monthFrom, monthTo,
        dashedIds: aggregateDashedIds(meta),
        singleSeriesInSubtitle: true,
        annualized: meta.every((s) => s.units !== 'percent'),
      });
      const panels = openPanels.get(c.chartId);
      if (panels) card.setOpenPanels(panels);
      const shown = records.filter((r) => inRange(r.date));
      if (shown.length) {
        exportCharts.push({ title: c.cfg.title, subtitle, source: refs.short || 'Statistics Canada',
          sources: refs.items, series: geoQualifiedLabels(meta), records: shown });
      }
    }
    if (!section.childElementCount) {
      $grid.innerHTML = '<p class="text-sm text-neutral-600">No series for the checked geographies.</p>';
    }
  }
}

// --- Shared tool helpers ------------------------------------------------------

/** Year + optional quarter + amount inputs; returns their elements. */
function periodInputs(prefix, { minYear, maxYear, amountLabel, amountPlaceholder }) {
  const years = [];
  for (let y = maxYear; y >= minYear; y--) years.push(`<option value="${y}">${y}</option>`);
  return `
    <label>Year<select id="${prefix}-year">${years.join('')}</select></label>
    <label>Period<select id="${prefix}-quarter">
      <option value="">Annual average</option>
      <option value="1">Q1</option><option value="2">Q2</option><option value="3">Q3</option><option value="4">Q4</option>
    </select></label>
    <label><span>${escapeHtml(amountLabel)}</span>
      <input type="number" id="${prefix}-amount" min="0" step="any" placeholder="${escapeHtml(amountPlaceholder)}" /></label>`;
}

/**
 * One indexing result as HTML. `name` labels the index, `linkNote` explains
 * the splice when the base period fell before the local series began.
 */
function resultHtml(r, amount, { name, linkNote, amountFmt = money }) {
  const basePeriod = r.base.quarters.length === 1 ? fmtQuarter(r.base.quarters[0])
    : `${r.base.quarters[0].slice(0, 4)} average${r.base.partial ? ` (${r.base.quarters.length} of 4 quarters)` : ''}`;
  const warn = [];
  if (r.base.spliced && linkNote) warn.push(linkNote);
  if (r.base.partial) warn.push(`${basePeriod.slice(0, 4)} is averaged over the quarters published so far, not a full year.`);
  return `
    <p><strong>${Number.isFinite(r.indexed) ? amountFmt(r.indexed) : `× ${r.factor.toFixed(4)}`}</strong>
      ${Number.isFinite(r.indexed) ? `<span class="cmhc-time-adjust-pct">from ${amountFmt(amount)}</span>` : ''}</p>
    <p>Factor <strong>${r.factor.toFixed(4)}</strong>
      <span class="cmhc-time-adjust-pct">(${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}%${r.cagr != null ? `; ${r.cagr.toFixed(2)}%/yr compound` : ''})</span></p>
    ${warn.map((w) => `<p class="cmhc-time-adjust-warn">${escapeHtml(w)}</p>`).join('')}
    <p class="cmhc-time-adjust-detail">${escapeHtml(name)}: ${escapeHtml(basePeriod)} index
      <strong>${r.base.value.toFixed(1)}</strong>${r.base.spliced ? ' (spliced)' : ''} → ${escapeHtml(fmtQuarter(r.current.q))} index
      <strong>${r.current.value.toFixed(1)}</strong> (latest published).</p>`;
}

const quarterly = (recordsById, id) => toQuarterly(recordsById[id] || []);

// --- Construction cost tool ----------------------------------------------------

// Building types, in StatsCan's order. `id` is the Winnipeg series; `slug`
// names the non-residential proxies (statscan.bcpi.type.<slug>.<geo>).
const BUILDING_TYPES = [
  { group: 'Residential', label: 'Residential buildings (composite)', id: 'statscan.bcpi.residential.winnipeg', res: true },
  { group: 'Residential', label: 'Apartment buildings', id: 'statscan.bcpi.type.apartment.winnipeg', res: true },
  { group: 'Residential', label: 'High-rise apartment (5+ storeys)', id: 'statscan.bcpi.type.apt_highrise.winnipeg', res: true },
  { group: 'Residential', label: 'Low-rise apartment (<5 storeys)', id: 'statscan.bcpi.type.apt_lowrise.winnipeg', res: true },
  { group: 'Residential', label: 'Single-detached house', id: 'statscan.bcpi.type.sfd.winnipeg', res: true },
  { group: 'Residential', label: 'Townhouse', id: 'statscan.bcpi.type.townhouse.winnipeg', res: true },
  { group: 'Non-residential', label: 'Non-residential buildings (composite)', id: 'statscan.bcpi.nonresidential.winnipeg',
    proxy: (g) => `statscan.bcpi.nonresidential.${g}` },
  ...[['commercial', 'Commercial buildings'], ['office', 'Office building'], ['warehouse', 'Warehouse'],
    ['shopping_centre', 'Shopping centre'], ['industrial', 'Industrial buildings'], ['factory', 'Factory'],
    ['bus_depot', 'Bus depot (no pre-2017 proxy)'], ['institutional', 'Institutional buildings'], ['school', 'School']]
    .map(([slug, label]) => ({ group: 'Non-residential', label, id: `statscan.bcpi.type.${slug}.winnipeg`,
      proxy: slug === 'bus_depot' ? null : (g) => `statscan.bcpi.type.${slug}.${g}` })),
];
const NONRES_PROXIES = [
  { key: 'canada', label: '15-CMA composite (national)' },
  { key: 'calgary', label: 'Calgary' },
  { key: 'edmonton', label: 'Edmonton' },
  { key: 'prairie', label: 'Prairie average (Calgary + Edmonton)' },
];
const NHPI_HOUSE = 'statscan.nhpi_house.winnipeg';

function buildConstructionTool($host, { recordsById }) {
  if (!$host) return;
  const types = BUILDING_TYPES.filter((t) => recordsById[t.id]?.length);
  if (!types.length) return;
  const latestYear = +(recordsById[types[0].id].at(-1).date.slice(0, 4));
  const groups = [...new Set(types.map((t) => t.group))];
  $host.innerHTML = `
    <section class="chart-card cmhc-time-adjust">
      <header class="chart-title">Construction cost indexing — Winnipeg</header>
      <p class="chart-sub">Index a historical build cost to the latest Building Construction Price Index quarter.</p>
      <div class="cmhc-time-adjust-disclaimer">
        <strong>Note:</strong> Winnipeg BCPI starts in Q1 2017; no Statistics Canada building-price index covers
        Winnipeg before that. Earlier years are chained onto a proxy at Q1 2017 (the proxy supplies the movement,
        Winnipeg the level) and are flagged as spliced. Indexed cost is input to the cost approach, not a
        substitute for a current cost estimate.
      </div>
      <div class="cmhc-time-adjust-form">
        <label class="cmhc-time-adjust-wide">Building type
          <select id="cct-type">${groups.map((g) => `<optgroup label="${g}">${types.filter((t) => t.group === g)
            .map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('')}</optgroup>`).join('')}</select>
        </label>
        <label class="cmhc-time-adjust-wide">Before 2017, link to
          <select id="cct-proxy"></select>
        </label>
        ${periodInputs('cct', { minYear: 1981, maxYear: latestYear, amountLabel: 'Cost ($)', amountPlaceholder: 'e.g. 2500000' })}
        <button type="button" id="cct-compute" class="cmhc-time-adjust-inline-btn">Calculate</button>
      </div>
      <div id="cct-result" class="cmhc-time-adjust-result" hidden></div>
    </section>`;
  const $type = $host.querySelector('#cct-type');
  const $proxy = $host.querySelector('#cct-proxy');
  const $year = $host.querySelector('#cct-year');
  const $q = $host.querySelector('#cct-quarter');
  const $amt = $host.querySelector('#cct-amount');
  const $out = $host.querySelector('#cct-result');
  $year.value = '2010';

  // The proxy list follows the type: residential types have one fixed link
  // (NHPI house-only), non-residential ones the four choices, bus depot none.
  function syncProxy() {
    const t = types.find((x) => x.id === $type.value);
    const keep = $proxy.value;
    if (t.res) {
      $proxy.innerHTML = '<option value="nhpi">Winnipeg NHPI — house only (1981+)</option>';
    } else if (t.proxy) {
      $proxy.innerHTML = NONRES_PROXIES.map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('');
      if (NONRES_PROXIES.some((p) => p.key === keep)) $proxy.value = keep;
    } else {
      $proxy.innerHTML = '<option value="">None — Winnipeg from 2017 only</option>';
    }
    $proxy.disabled = $proxy.options.length < 2;
  }

  function series() {
    const t = types.find((x) => x.id === $type.value);
    const primary = quarterly(recordsById, t.id);
    let proxy = null;
    let proxyName = '';
    if (t.res) {
      proxy = quarterly(recordsById, NHPI_HOUSE);
      proxyName = 'Winnipeg New Housing Price Index, house only';
    } else if (t.proxy) {
      const p = $proxy.value;
      proxy = p === 'prairie'
        ? averageSeries(quarterly(recordsById, t.proxy('calgary')), quarterly(recordsById, t.proxy('edmonton')))
        : quarterly(recordsById, t.proxy(p));
      proxyName = `${NONRES_PROXIES.find((x) => x.key === p).label} BCPI, same building type`;
    }
    return { t, primary, proxyName, ...chain(primary, proxy) };
  }

  function compute() {
    $out.hidden = false;
    const { t, primary, series: s, linkQ, proxyName } = series();
    const year = +$year.value;
    const quarter = $q.value ? +$q.value : null;
    const amount = parseFloat($amt.value);
    const r = indexToCurrent(s, amount, year, quarter);
    if (!r) {
      const start = (linkQ ? s[0] : primary[0])?.q;
      $out.innerHTML = `<p class="cmhc-time-adjust-error">${escapeHtml(t.label)} has no index for that period${start
        ? `; the ${linkQ ? 'linked series' : 'series'} starts ${escapeHtml(fmtQuarter(start))}` : ''}.</p>`;
      return;
    }
    $out.innerHTML = resultHtml(r, amount, {
      name: `Winnipeg BCPI, ${t.label}`,
      linkNote: linkQ ? `Base period is before Winnipeg BCPI began (${fmtQuarter(linkQ)}): spliced onto the ${proxyName}, linked at ${fmtQuarter(linkQ)}.` : '',
    });
  }

  syncProxy();
  $type.addEventListener('change', () => { syncProxy(); if (!$out.hidden) compute(); });
  $proxy.addEventListener('change', () => { if (!$out.hidden) compute(); });
  $host.querySelector('#cct-compute').addEventListener('click', compute);
}

// --- Lease indexing tool ---------------------------------------------------------

// CRSPI geographies with a matching CPI all-items series.
const LEASE_GEOS = [
  { slug: 'winnipeg', label: 'Winnipeg' },
  { slug: 'manitoba', label: 'Manitoba' },
  { slug: 'calgary', label: 'Calgary' },
  { slug: 'edmonton', label: 'Edmonton' },
  { slug: 'saskatoon', label: 'Saskatoon' },
  { slug: 'vancouver', label: 'Vancouver' },
  { slug: 'canada', label: 'Canada' },
];
const CRSPI_CANADA = 'statscan.crspi.canada.total';
// StatsCan splits CRSPI by building type for Canada and its regions only, from
// Q1 2019. A prairie city (or Manitoba) takes the Prairie Region split, anything
// else the national one; earlier years chain onto the Canada all-types total.
const LEASE_TYPES = [
  { slug: 'total', label: 'All building types' },
  { slug: 'office', label: 'Office' },
  { slug: 'retail', label: 'Retail' },
  { slug: 'industrial', label: 'Industrial & warehouse' },
];
const PRAIRIE_SLUGS = new Set(['winnipeg', 'manitoba', 'calgary', 'edmonton', 'saskatoon', 'regina']);

/**
 * Which CRSPI series a lease lookup uses: the geography's own total, or for a
 * building type the regional (Prairie) or national split.
 *
 * @param {string} geoSlug  'winnipeg', 'canada', …
 * @param {string} typeSlug 'total' | 'office' | 'retail' | 'industrial'
 * @returns {{ id:string, region:'local'|'prairie'|'canada' }}
 */
export function leaseCrspiSeries(geoSlug, typeSlug) {
  if (typeSlug === 'total') return { id: `statscan.crspi.${geoSlug}.total`, region: 'local' };
  const region = PRAIRIE_SLUGS.has(geoSlug) ? 'prairie' : 'canada';
  return { id: `statscan.crspi.${region}.${typeSlug}`, region };
}

function buildLeaseTool($host, { recordsById }) {
  if (!$host) return;
  const geos = LEASE_GEOS.filter((g) => recordsById[`statscan.crspi.${g.slug}.total`]?.length
    && recordsById[`statscan.cpi_allitems.${g.slug}`]?.length);
  if (!geos.length) return;
  // A building type is offered once both of its splits are in the shards.
  const types = LEASE_TYPES.filter((t) => t.slug === 'total'
    || ['prairie', 'canada'].every((r) => recordsById[`statscan.crspi.${r}.${t.slug}`]?.length));
  const latestYear = +(recordsById[CRSPI_CANADA]?.at(-1)?.date.slice(0, 4) || new Date().getFullYear());
  const rentFmt = (v) => `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $host.innerHTML = `
    <section class="chart-card cmhc-time-adjust">
      <header class="chart-title">Lease rent indexing</header>
      <p class="chart-sub">Index a historical rent to today by market commercial rents (CRSPI) and by inflation (CPI).</p>
      <div class="cmhc-time-adjust-disclaimer">
        <strong>Note:</strong> CRSPI tracks net effective rents for occupied office, retail and industrial space;
        CPI all-items is the usual basis of a lease escalation clause. Local CRSPI starts in Q1 2019 and is chained
        onto Canada CRSPI (from 2006) before that; for years before 2006 only the CPI result is available.
        Statistics Canada splits CRSPI by building type only for Canada and its regions (from Q1 2019), so a
        building type uses the Prairie Region index for a prairie geography and the national one otherwise.
      </div>
      <div class="cmhc-time-adjust-form">
        <label class="cmhc-time-adjust-wide">Geography
          <select id="clt-geo">${geos.map((g) => `<option value="${g.slug}">${escapeHtml(g.label)}</option>`).join('')}</select>
        </label>
        <label class="cmhc-time-adjust-wide">Building type (CRSPI)
          <select id="clt-type">${types.map((t) => `<option value="${t.slug}">${escapeHtml(t.label)}</option>`).join('')}</select>
        </label>
        ${periodInputs('clt', { minYear: 1971, maxYear: latestYear, amountLabel: 'Rent ($/sf or $/yr)', amountPlaceholder: 'e.g. 14.50' })}
        <button type="button" id="clt-compute" class="cmhc-time-adjust-inline-btn">Calculate</button>
      </div>
      <div id="clt-result" class="cmhc-time-adjust-result cmhc-index-pair" hidden></div>
    </section>`;
  const $geo = $host.querySelector('#clt-geo');
  const $type = $host.querySelector('#clt-type');
  const $year = $host.querySelector('#clt-year');
  const $q = $host.querySelector('#clt-quarter');
  const $amt = $host.querySelector('#clt-amount');
  const $out = $host.querySelector('#clt-result');
  $year.value = '2019';

  function compute() {
    $out.hidden = false;
    const g = geos.find((x) => x.slug === $geo.value);
    const year = +$year.value;
    const quarter = $q.value ? +$q.value : null;
    const amount = parseFloat($amt.value);

    const t = types.find((x) => x.slug === $type.value) || types[0];
    const pick = leaseCrspiSeries(g.slug, t.slug);
    const local = quarterly(recordsById, pick.id);
    const { series: crspi, linkQ } = pick.id === CRSPI_CANADA
      ? { series: local, linkQ: null }
      : chain(local, quarterly(recordsById, CRSPI_CANADA));
    const typeName = t.label.toLowerCase();
    const indexName = t.slug === 'total' ? g.label
      : `${pick.region === 'prairie' ? 'Prairie Region' : 'Canada'}, ${typeName}`;
    // Say so whenever the index is not the geography's own.
    const regionNote = pick.region === 'prairie'
      ? `No ${typeName} CRSPI is published for ${g.label}; this uses the Prairie Region (MB + SK + AB) index.`
      : pick.region === 'canada' && g.slug !== 'canada'
        ? `No ${typeName} CRSPI is published for ${g.label}; this uses the national index.` : '';
    const linkNote = !linkQ ? ''
      : t.slug === 'total'
        ? `${g.label} CRSPI starts ${fmtQuarter(linkQ)}: the base period is spliced onto Canada CRSPI, linked at ${fmtQuarter(linkQ)}.`
        : `Building-type CRSPI starts ${fmtQuarter(linkQ)}: the base period is spliced onto the Canada all-types CRSPI, linked at ${fmtQuarter(linkQ)}.`;
    const cpi = quarterly(recordsById, `statscan.cpi_allitems.${g.slug}`);

    const col = (title, r, opts, missing, note = '') => `<div><h3 class="cmhc-index-pair-title">${escapeHtml(title)}</h3>${
      note ? `<p class="cmhc-time-adjust-warn">${escapeHtml(note)}</p>` : ''}${r
      ? resultHtml(r, amount, { amountFmt: rentFmt, ...opts })
      : `<p class="cmhc-time-adjust-error">${escapeHtml(missing)}</p>`}</div>`;
    $out.innerHTML =
      col('Market rents — CRSPI', indexToCurrent(crspi, amount, year, quarter), {
        name: `CRSPI, ${indexName}`,
        linkNote,
      }, `CRSPI starts ${crspi[0] ? fmtQuarter(crspi[0].q) : '2006'}; no market-rent index for that period.`, regionNote)
      + col('Inflation — CPI all-items', indexToCurrent(cpi, amount, year, quarter), {
        name: `CPI all-items, ${g.label} (quarterly average of monthly)`,
      }, `CPI for ${g.label} starts ${cpi[0] ? fmtQuarter(cpi[0].q) : '—'}.`);
  }

  $geo.addEventListener('change', () => { if (!$out.hidden) compute(); });
  $type.addEventListener('change', () => { if (!$out.hidden) compute(); });
  $host.querySelector('#clt-compute').addEventListener('click', compute);
}
