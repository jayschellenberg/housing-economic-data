/*
 * Agricultural tab — a curated, Manitoba-focused view of the agricultural
 * indicators an appraiser uses for farm and farmland work: farm cash receipts,
 * farmland value per acre (vs the prairie provinces), crop and livestock prices,
 * and the Farm Input Price Index.
 *
 * It is NOT a second copy of the Market Indicators renderer (which is coupled to
 * its own `mi-` DOM and sidebar). Instead it reuses the shared chart component
 * (buildIndicatorCard) over an explicit chart spec, pulling series from the same
 * indicator shards. Farm cash receipts is referenced from the existing "economy"
 * shard (it lives in both tabs — a genuine economic *and* agricultural series);
 * the other families are new catalog groups tagged `tab: "agriculture"`, which
 * keeps them off the Market Indicators tab.
 */

import { buildIndicatorCard } from './indicator-chart.js';

const loadJson = (path) =>
  fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch(() => null);

// Only modern history is useful for appraisal context; older data compresses the
// axis without adding signal. All ag series comfortably cover this window.
const MONTH_FROM = '2005-01';

// Curated charts, in display order. `chartId` names a catalog chart; `geos`
// (when present) restricts the drawn lines — farm cash / prices / inputs are
// Manitoba-scoped, farmland compares provinces. `subtitle` overrides the card's
// default (the shared component's auto-subtitle assumes the Market Indicators
// geo filter, which this tab doesn't have).
const AG_CHARTS = [
  { chartId: 'farm_cash',        geos: ['MB'], title: 'Farm cash receipts — Manitoba',
    subtitle: 'Manitoba • annual, by receipt type' },
  { chartId: 'farmland_value',   subtitle: 'Value per acre by province • annual' },
  { chartId: 'crop_prices',      subtitle: 'Manitoba • monthly • $/tonne' },
  { chartId: 'livestock_prices', subtitle: 'Manitoba • monthly • $/cwt' },
  { chartId: 'farm_input_index', subtitle: 'Manitoba • quarterly • rebased index' },
];

let done = false;

export async function initAgriculture() {
  if (done) return;
  done = true;

  const $grid = document.getElementById('ag-chart-grid');
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

  let rendered = 0;
  for (const spec of AG_CHARTS) {
    const cfg = (catalog.charts || {})[spec.chartId];
    if (!cfg) continue;

    let meta = Object.values(seriesById).filter((s) => s.chartId === spec.chartId);
    if (spec.geos) meta = meta.filter((s) => spec.geos.includes(s.geo));
    meta.sort((a, b) => (orderOf.get(a.id) ?? 1e9) - (orderOf.get(b.id) ?? 1e9));
    if (!meta.length) continue;

    const records = meta.flatMap((s) => recordsById[s.id] || []);
    if (!records.length) continue;

    const card = buildIndicatorCard($grid, {
      chartId: spec.chartId,
      title: spec.title || cfg.title,
      sourceLabel: 'Statistics Canada',
      description: cfg.description,
    });
    card.render(records, meta, { subtitle: spec.subtitle, monthFrom: MONTH_FROM });
    rendered += 1;
  }

  if (!rendered) {
    $grid.innerHTML =
      '<p class="text-sm text-neutral-600">Agricultural series have not been built yet. They populate on the next data refresh (r/11 + r/14).</p>';
  }
}
