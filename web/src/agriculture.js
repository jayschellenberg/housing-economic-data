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

import { buildIndicatorCard } from './indicator-chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';

const loadJson = (path) =>
  fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch(() => null);

// Only modern history is useful for appraisal context; older data compresses the
// axis without adding signal. All ag series comfortably cover this window.
const MONTH_FROM = '2005-01';

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
  // to 1921); `from: null` shows their full history rather than the 2005 default.
  { chartId: 'farm_count', scope: 'prov', from: null,
    title: (p) => `Number of farms — ${p.name}`,
    subtitle: (p) => `${p.name} • Census of Agriculture, every 5 years since 1921` },
  { chartId: 'farm_size', scope: 'prov', from: null,
    title: (p) => `Average farm size — ${p.name}`,
    subtitle: (p) => `${p.name} • acres per farm • Census of Agriculture since 1921` },
  { chartId: 'operator_age', scope: 'prov', from: null,
    title: (p) => `Average operator age — ${p.name}`,
    subtitle: (p) => `${p.name} • years • Census of Agriculture, 1991–2021` },
  { chartId: 'farms_by_type', scope: 'prov', from: null,
    title: (p) => `Farms by type — ${p.name}`,
    subtitle: (p) => `${p.name} • number of farms by NAICS type • 2001–2021` },
];

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

  // Province dropdown — shares the site-wide "home province" (SGC code) so the
  // choice carries across tabs. Only the four ag-covered provinces are offered.
  const provOptions = PROVS.map((p) => p.sgc);
  if ($prov) {
    $prov.innerHTML = PROVS.map((p) => `<option value="${p.sgc}">${p.name}</option>`).join('');
    $prov.value = resolveProvince(provOptions, '46');
    $prov.addEventListener('change', () => { rememberProvince($prov.value); render($prov.value); });
  }
  render($prov ? $prov.value : '46');

  function render(sgc) {
    const prov = PROVS.find((p) => p.sgc === sgc) || PROVS[0];
    $grid.replaceChildren();
    let rendered = 0;
    for (const spec of AG_CHARTS) {
      const cfg = (catalog.charts || {})[spec.chartId];
      if (!cfg) continue;

      let meta = Object.values(seriesById).filter((s) => s.chartId === spec.chartId);
      if (spec.scope === 'prov') meta = meta.filter((s) => s.geo === prov.abbr);
      meta.sort((a, b) => (orderOf.get(a.id) ?? 1e9) - (orderOf.get(b.id) ?? 1e9));
      if (!meta.length) continue;

      const records = meta.flatMap((s) => recordsById[s.id] || []);
      if (!records.length) continue;

      const card = buildIndicatorCard($grid, {
        chartId: spec.chartId,
        title: spec.title(prov),
        sourceLabel: 'Statistics Canada',
        description: spec.desc || cfg.description,
      });
      // Structure charts opt into full history via `from: null`; the rest use
      // the modern-window default.
      const monthFrom = spec.from === undefined ? MONTH_FROM : spec.from;
      card.render(records, meta, { subtitle: spec.subtitle(prov), monthFrom });
      rendered += 1;
    }

    if (!rendered) {
      $grid.innerHTML =
        '<p class="text-sm text-neutral-600">Agricultural series have not been built yet. They populate on the next data refresh (r/11 + r/14).</p>';
    }
  }
}
