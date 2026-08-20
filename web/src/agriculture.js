/*
 * Agricultural tab — a curated view of the agricultural indicators an appraiser
 * uses for farm and farmland work: farm cash receipts, farmland value per acre,
 * crop / livestock / supply-managed (poultry, egg, milk) prices, and the Farm
 * Input Price Index. A province dropdown (BC / AB / SK / MB) scopes every chart
 * except farmland, which stays a cross-province comparison.
 *
 * It is NOT a second copy of the Market Indicators renderer (which is coupled to
 * its own `mi-` DOM and sidebar). Instead it reuses the shared chart component
 * (buildIndicatorCard) over an explicit chart spec, pulling series from the same
 * indicator shards. Farm cash receipts is referenced from the existing "economy"
 * shard (it lives in both tabs — a genuine economic *and* agricultural series);
 * the other families are catalog groups tagged `tab: "agriculture"`, which keeps
 * them off the Market Indicators tab.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { initAgMap } from './ag-map.js';

const loadJson = (path) =>
  fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch(() => null);

// Only modern history is useful for appraisal context; older data compresses the
// axis without adding signal. All ag series comfortably cover this window.
// The four covered provinces, keyed by SGC code (what prefs.js stores as the
// shared "home province"), mapped to the series `geo` abbreviation and a label.
const PROVS = [
  { sgc: '46', abbr: 'MB', name: 'Manitoba' },
  { sgc: '47', abbr: 'SK', name: 'Saskatchewan' },
  { sgc: '48', abbr: 'AB', name: 'Alberta' },
  { sgc: '59', abbr: 'BC', name: 'British Columbia' },
];

// Curated charts, in display order. `chartId` names a catalog chart; `scope`
// 'prov' filters series to the selected province, 'all' shows every geography
// (farmland is inherently a cross-province comparison). `title`/`subtitle` are
// functions of the selected province; `desc` optionally overrides the catalog
// description (used for farm cash, whose catalog copy is Manitoba-specific).
const AG_CHARTS = [
  { chartId: 'farm_cash', scope: 'prov',
    title: (p) => `Farm cash receipts — ${p.name}`,
    subtitle: (p) => `${p.name} • annual, by receipt type`,
    desc: 'Annual farm cash receipts (StatsCan table 32-10-0045), split into total, crop, and livestock. Agriculture is a pillar of the prairie economy; crop and livestock receipts swing with commodity prices and trade access (e.g. canola tariffs).' },
  { chartId: 'farmland_value', scope: 'all',
    title: () => 'Farmland value per acre',
    subtitle: () => 'Value per acre by province • annual (comparison)' },
  { chartId: 'farmland_yoy', scope: 'all',
    title: () => 'Farmland value — year-over-year % change',
    subtitle: () => 'Annual % change by province • official analogue of the FCC report' },
  { chartId: 'crop_prices', scope: 'prov',
    title: (p) => `Crop prices — ${p.name}`,
    subtitle: (p) => `${p.name} • monthly • $/tonne` },
  { chartId: 'livestock_prices', scope: 'prov',
    title: (p) => `Livestock prices — ${p.name}`,
    subtitle: (p) => `${p.name} • monthly • $/cwt` },
  { chartId: 'poultry_prices', scope: 'prov',
    title: (p) => `Poultry meat prices — ${p.name}`,
    subtitle: (p) => `${p.name} • monthly • $/kg (supply-managed)` },
  { chartId: 'egg_price', scope: 'prov',
    title: (p) => `Egg prices — ${p.name}`,
    subtitle: (p) => `${p.name} • monthly • $/dozen (supply-managed)` },
  { chartId: 'milk_price', scope: 'prov',
    title: (p) => `Milk price — ${p.name}`,
    subtitle: (p) => `${p.name} • monthly • $/kL, ÷10 = $/hL (supply-managed)` },
  { chartId: 'farm_input_index', scope: 'prov',
    title: (p) => `Farm Input Price Index — ${p.name}`,
    subtitle: (p) => `${p.name} • quarterly • rebased index` },
  // Farm-structure charts run on Census-of-Agriculture data (5-year steps back
  // to 1921). Range is controlled by the tab's global year selectors.
  { chartId: 'farm_count', scope: 'prov',
    title: (p) => `Number of farms — ${p.name}`,
    subtitle: (p) => `${p.name} • Census of Agriculture, every 5 years since 1921` },
  { chartId: 'farm_size', scope: 'prov',
    title: (p) => `Average farm size — ${p.name}`,
    subtitle: (p) => `${p.name} • acres per farm • Census of Agriculture since 1921` },
  { chartId: 'operator_age', scope: 'prov',
    title: (p) => `Average operator age — ${p.name}`,
    subtitle: (p) => `${p.name} • years • Census of Agriculture, 1991–2021` },
  { chartId: 'farms_by_type', scope: 'prov',
    title: (p) => `Farms by type — ${p.name}`,
    subtitle: (p) => `${p.name} • number of farms by NAICS type • 2001–2021` },
  // Farm Financial Survey (StatsCan 32-10-0102), average per farm, annual.
  { chartId: 'farm_income', scope: 'prov',
    title: (p) => `Farm income & expenses — ${p.name}`,
    subtitle: (p) => `${p.name} • avg per farm • annual, 2009–2023` },
  { chartId: 'farm_balance', scope: 'prov',
    title: (p) => `Farm balance sheet — ${p.name}`,
    subtitle: (p) => `${p.name} • avg per farm • annual, 2009–2023` },
];

// Section grouping + display order for the charts, with a matching jump-link
// bar. The map is a fixed section (rendered separately) appended at the end.
const SECTIONS = [
  { key: 'land',      label: 'Farmland values',     charts: ['farmland_value', 'farmland_yoy'] },
  { key: 'prices',    label: 'Commodity prices',    charts: ['crop_prices', 'livestock_prices', 'poultry_prices', 'egg_price', 'milk_price'] },
  { key: 'finances',  label: 'Receipts & finances', charts: ['farm_cash', 'farm_income', 'farm_balance'] },
  { key: 'inputs',    label: 'Input costs',         charts: ['farm_input_index'] },
  { key: 'structure', label: 'Farm structure',      charts: ['farm_count', 'farm_size', 'operator_age', 'farms_by_type'] },
];
const SPEC_BY_ID = Object.fromEntries(AG_CHARTS.map((s) => [s.chartId, s]));

let done = false;

export async function initAgriculture() {
  if (done) return;
  done = true;

  const $grid = document.getElementById('ag-chart-grid');
  const $prov = document.getElementById('ag-prov');
  if (!$grid) return;

  const [catalog, manifest] = await Promise.all([
    loadJson('./data/indicators/_catalog.json'),
    loadJson('./data/indicators-manifest.json'),
  ]);
  if (!catalog) {
    $grid.innerHTML = '<p class="text-sm text-red-700">Indicator catalog not found. Re-run r/14_build_indicators.R.</p>';
    return;
  }

  // Load every indicator shard, then index series metadata + records by id. The
  // shard series carry the computed latestValue/latestDate the card chip needs,
  // so use those (not catalog.series). catalog.series is used only for ordering.
  const groups = (manifest?.groups || []).map((g) => g.group);
  const shardPairs = await Promise.all(groups.map(async (g) => [g, await loadJson(`./data/indicators/${g}.json`)]));
  const shards = Object.fromEntries(shardPairs.filter(([, d]) => d));

  const seriesById = {};
  const recordsById = {};
  for (const sh of Object.values(shards)) {
    for (const s of sh.series || []) seriesById[s.id] = s;
    for (const r of sh.records || []) (recordsById[r.id] ||= []).push(r);
  }
  const orderOf = new Map((catalog.series || []).map((s, i) => [s.id, i]));

  // Within-province Census-of-Agriculture choropleth (below the charts).
  const agMap = initAgMap({ host: 'ag-map' });

  // Global year-range control — applies to every chart, default "all data" (no
  // bounds). Options span the actual data range across all ag series.
  const $yearFrom = document.getElementById('ag-year-from');
  const $yearTo = document.getElementById('ag-year-to');
  // Year bounds from the ag charts' own series (not every indicator shard).
  // Track min/max in a loop — the record set is large, so spreading it into
  // Math.min/max would blow the call stack.
  const agChartIds = new Set(AG_CHARTS.map((s) => s.chartId));
  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const s of Object.values(seriesById)) {
    if (!agChartIds.has(s.chartId)) continue;
    for (const r of recordsById[s.id] || []) {
      const y = +String(r.date).slice(0, 4);
      if (Number.isFinite(y)) { if (y < minYear) minYear = y; if (y > maxYear) maxYear = y; }
    }
  }
  if (!Number.isFinite(minYear)) { minYear = 1990; maxYear = new Date().getFullYear(); }
  const yearOpts = ['<option value="">All</option>'];
  for (let y = maxYear; y >= minYear; y--) yearOpts.push(`<option value="${y}">${y}</option>`);
  if ($yearFrom && $yearTo) {
    $yearFrom.innerHTML = yearOpts.join('');
    $yearTo.innerHTML = yearOpts.join('');
    // Re-render on change; the map is a 2021 snapshot, so year changes only touch
    // the charts (renderCharts), not the choropleth.
    $yearFrom.addEventListener('change', renderCharts);
    $yearTo.addEventListener('change', renderCharts);
  }

  // Jump-to-section bar (built once; section ids are stable across re-renders).
  const $jump = document.getElementById('ag-jump');
  if ($jump) {
    const links = SECTIONS.map((s) => `<a href="#ag-sec-${s.key}" data-jump="ag-sec-${s.key}" class="text-accent-600 hover:text-accent-700 hover:underline">${s.label}</a>`);
    links.push('<a href="#ag-sec-map" data-jump="ag-sec-map" class="text-accent-600 hover:text-accent-700 hover:underline">Within-province map</a>');
    $jump.innerHTML = '<span class="text-neutral-500 font-medium mr-1">Jump to:</span>' + links.join('');
    $jump.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  // Province dropdown — shares the site-wide "home province" (SGC code) so the
  // choice carries across tabs. Only the four ag-covered provinces are offered.
  const provOptions = PROVS.map((p) => p.sgc);
  if ($prov) {
    $prov.innerHTML = PROVS.map((p) => `<option value="${p.sgc}">${p.name}</option>`).join('');
    $prov.value = resolveProvince(provOptions, '46');
    $prov.addEventListener('change', () => { rememberProvince($prov.value); render($prov.value); });
  }
  let currentProv = PROVS.find((p) => p.sgc === ($prov ? $prov.value : '46')) || PROVS[0];
  render(currentProv.sgc);

  // Province change redraws both the choropleth and the charts.
  function render(sgc) {
    currentProv = PROVS.find((p) => p.sgc === sgc) || PROVS[0];
    agMap.render(sgc);
    renderCharts();
  }

  // Charts only — re-run on a year-range change (the map is a fixed 2021 snapshot).
  function renderCharts() {
    const prov = currentProv;
    // Global year range; empty selectors ⇒ all data (no bound).
    const monthFrom = $yearFrom && $yearFrom.value ? `${$yearFrom.value}-01` : null;
    const monthTo   = $yearTo && $yearTo.value ? `${$yearTo.value}-12` : null;
    // Cards are rebuilt from scratch on every control change, which would
    // otherwise snap shut whatever the user had open — the data table they
    // just opened to read, or the explainer beneath it. Carry both across the
    // rebuild, keyed by chart.
    const openPanels = new Map(
      [...$grid.querySelectorAll('.cmhc-indicator-card')]
        .map((c) => [c.dataset.chartId, readOpenPanels(c)])
        .filter(([, panels]) => panels.length),
    );
    $grid.replaceChildren();
    let total = 0;
    // One <section> per group (header + 2-col grid), matching the jump bar.
    for (const sec of SECTIONS) {
      const section = document.createElement('section');
      section.id = `ag-sec-${sec.key}`;
      section.className = 'scroll-mt-16';
      section.innerHTML =
        `<h2 class="cmhc-mi-section-title">${sec.label}</h2>` +
        '<div class="cmhc-mi-section-grid grid md:grid-cols-2 gap-4"></div>';
      const $secGrid = section.querySelector('.cmhc-mi-section-grid');
      let n = 0;
      for (const chartId of sec.charts) {
        const spec = SPEC_BY_ID[chartId];
        const cfg = (catalog.charts || {})[chartId];
        if (!spec || !cfg) continue;

        let meta = Object.values(seriesById).filter((s) => s.chartId === chartId);
        if (spec.scope === 'prov') meta = meta.filter((s) => s.geo === prov.abbr);
        meta.sort((a, b) => (orderOf.get(a.id) ?? 1e9) - (orderOf.get(b.id) ?? 1e9));
        if (!meta.length) continue;

        const records = meta.flatMap((s) => recordsById[s.id] || []);
        if (!records.length) continue;

        const card = buildIndicatorCard($secGrid, {
          chartId,
          title: spec.title(prov),
          sourceLabel: 'Statistics Canada',
          description: spec.desc || cfg.description,
          // Every ag chart carries a data table (the hover tooltip comes with
          // buildIndicatorCard). AG_CHARTS is this tab's curated spec, so the
          // decision lives here rather than in each catalog chart def. The
          // table builds on open, which matters here: the year range defaults
          // to the full history — monthly crop prices back to 1985, farm
          // structure to 1921.
          table: true,
        });
        card.render(records, meta, { subtitle: spec.subtitle(prov), monthFrom, monthTo });
        const panels = openPanels.get(chartId);
        if (panels) card.setOpenPanels(panels);
        n += 1; total += 1;
      }
      if (n > 0) $grid.appendChild(section);   // skip a section with no data
    }

    if (!total) {
      $grid.innerHTML =
        '<p class="text-sm text-neutral-600">Agricultural series have not been built yet. They populate on the next data refresh (r/11 + r/14).</p>';
    }
  }
}
