/*
 * Market Indicators tab orchestrator. Loads the per-group indicator
 * shards, populates the Current Snapshot KPI bar, renders chart panels
 * grouped by chartId, and wires the Excel-download button.
 *
 * Data layout (produced by r/14_build_indicators.R):
 *   web/public/data/indicators-manifest.json
 *     { groups: [{ group, file, seriesCount, recordCount, latestDate }], ... }
 *   web/public/data/indicators/{group}.json
 *     { group, series: [...], records: [{id, date, value}] }
 *
 * The catalog (r/lib/indicator_catalog.json, copied to
 * public/data/indicators/_catalog.json by r/14_build_indicators.R) is
 * fetched once at module init so chart metadata (titles, chartLabel,
 * snapshotPick) is available without round-tripping through R.
 */

import { buildIndicatorCard } from './indicator-chart.js';
import { escapeHtml } from './escape.js';

const PROVIDER_LABEL = {
  boc:      'Bank of Canada Valet',
  statscan: 'Statistics Canada (WDS)',
  cba:      'Canadian Bankers Association',
  osb:      'Office of the Superintendent of Bankruptcy (Open Government)',
  cmhc:     'CMHC Rental Market Survey',
  derived:  'computed from source series',
};

const FMT = {
  percent:           (v) => v == null ? '—' : `${Number(v).toFixed(2)}%`,
  dollar:            (v) => v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`,
  dollar_millions:   (v) => v == null ? '—' : `$${(Number(v) / 1e6).toFixed(1)}M`,
  index:             (v) => v == null ? '—' : Number(v).toFixed(1),
  units:             (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  persons:           (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  persons_thousands: (v) => v == null ? '—' : `${(Number(v) / 1e6).toFixed(1)}M`,
  ratio:             (v) => v == null ? '—' : Number(v).toFixed(2),
  balance_of_opinion:(v) => v == null ? '—' : `${Number(v).toFixed(0)}`,
};

async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

let initialised = false;
// Default range: a rolling 5-year window at month granularity, via the sidebar
// month pickers (type="month" → "YYYY-MM"). The "from" default tracks the "to":
// 5 years before the chosen "to" month, or 5 years before the current month
// when "to" is left blank — unless the user sets "from" explicitly (monthFromLocked).
function autoFromFor(toVal) {
  let y, mo;
  if (toVal && /^\d{4}-\d{2}$/.test(toVal)) {
    [y, mo] = toVal.split('-').map(Number);
  } else {
    const d = new Date();
    y = d.getFullYear();
    mo = d.getMonth() + 1;
  }
  return `${y - 5}-${String(mo).padStart(2, '0')}`;
}
const DEFAULT_MONTH_FROM = autoFromFor(null);
let state = {
  monthFrom: DEFAULT_MONTH_FROM,
  monthTo: null,
  monthFromLocked: false,   // true once the user edits "from" by hand
  sectionsHidden: new Set(),
  geosEnabled: new Set(['MB', 'Winnipeg-CMA']),   // Canada-only stats always render anyway (single-geo)
};
let lastRender = { cards: [], shards: {}, catalog: null };

export async function initIndicators() {
  if (initialised) return;
  initialised = true;

  const [catalog, manifest] = await Promise.all([
    loadJson('./data/indicators/_catalog.json').catch(() => null),
    loadJson('./data/indicators-manifest.json').catch(() => ({ groups: [] })),
  ]);
  if (!catalog) {
    document.getElementById('mi-chart-grid').innerHTML =
      '<p class="text-sm text-red-700">Indicator catalog not found. Re-run r/14_build_indicators.R.</p>';
    return;
  }
  const catalogResolved = catalog;

  // Load all group shards in parallel.
  const groupNames = (manifest.groups || []).map(g => g.group);
  const shardPairs = await Promise.all(groupNames.map(async (g) => {
    const data = await loadJson(`./data/indicators/${g}.json`).catch(() => null);
    return [g, data];
  }));
  const shards = Object.fromEntries(shardPairs.filter(([, d]) => d));

  lastRender.catalog = catalogResolved;
  lastRender.shards  = shards;

  buildSnapshot(catalogResolved, shards);
  buildChartSections(catalogResolved, shards);
  buildTimeAdjustmentTool(catalogResolved, shards);
  wireSidebar(catalogResolved, manifest);
  wireExcelDownload(catalogResolved, shards);
}

// --- Time-adjustment helper -------------------------------------------------
// Interactive form: user picks a sale date, effective date, an index, and
// (optionally) a sale price. Output is the multiplier (index at effective /
// index at sale) and the adjusted price. The chosen index's actual values
// + observation dates are surfaced for transparency.
function buildTimeAdjustmentTool(catalog, shards) {
  const $grid = document.getElementById('mi-chart-grid');
  if (!$grid) return;

  // Eligible source series — only indices and shelter inflation make sense
  // here. Drop bond yields, payments, employment counts, etc.
  const ELIGIBLE_IDS = [
    'statscan.nhpi.winnipeg',
    'statscan.nhpi.canada',
    'statscan.cpi_shelter.manitoba',
    'statscan.cpi_shelter.canada',
    'statscan.bcpi.residential.winnipeg',
    'statscan.bcpi.residential.canada',
    'statscan.bcpi.nonresidential.winnipeg',
    'statscan.bcpi.nonresidential.canada',
  ];

  // Collect available series from the shards, in eligible order.
  const allSeries = [];
  Object.values(shards).forEach(sh => (sh.series || []).forEach(s => allSeries.push(s)));
  const seriesById = Object.fromEntries(allSeries.map(s => [s.id, s]));
  const recordsById = {};
  Object.values(shards).forEach(sh => (sh.records || []).forEach(r => {
    if (!recordsById[r.id]) recordsById[r.id] = [];
    recordsById[r.id].push(r);
  }));
  // Sort each series's records by date ascending.
  Object.values(recordsById).forEach(arr => arr.sort((a, b) => a.date.localeCompare(b.date)));

  const choices = ELIGIBLE_IDS
    .filter(id => seriesById[id] && (recordsById[id]?.length || 0) > 0)
    .map(id => ({ id, title: seriesById[id].title || id, geo: seriesById[id].geo, base: seriesById[id].indexBase }));
  if (choices.length === 0) return;

  // Bracket the date range with the union of all eligible series.
  const allDates = ELIGIBLE_IDS.flatMap(id => recordsById[id] || []).map(r => r.date).sort();
  const minDate = allDates[0] || '2010-01-01';
  const maxDate = allDates[allDates.length - 1] || new Date().toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const section = document.createElement('section');
  section.className = 'cmhc-mi-section';
  section.dataset.group = 'tools';
  section.id = 'mi-section-tools';
  section.innerHTML = `
    <h2 class="cmhc-mi-section-title">Tools</h2>
    <section class="chart-card cmhc-time-adjust">
      <header class="chart-title">Time-adjustment helper</header>
      <p class="chart-sub">Index-based market-condition multiplier for use as appraisal input.</p>
      <div class="cmhc-time-adjust-disclaimer">
        <strong>Disclaimer:</strong> Market-condition adjustments require appraiser judgment beyond a single
        index. This helper computes the ratio of one index value to another and is intended as input to the
        appraiser's analysis, not a substitute for it. Local market segments routinely diverge from the
        index used; verify against transaction-level evidence.
      </div>
      <div class="cmhc-time-adjust-form">
        <label>Sale date<input type="date" id="ta-sale-date"
                              min="${minDate}" max="${maxDate}" /></label>
        <label>Effective date<input type="date" id="ta-eff-date"
                                    min="${minDate}" max="${todayIso}" value="${todayIso.slice(0, 7)}-01" /></label>
        <label>Index
          <select id="ta-index">
            ${choices.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}${c.base ? ` (${escapeHtml(c.base)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label>Sale price <span class="cmhc-time-adjust-optional">(optional)</span>
          <input type="number" id="ta-sale-price" min="0" step="1000" placeholder="e.g. 350000" /></label>
        <button type="button" id="ta-compute">Calculate</button>
      </div>
      <div id="ta-result" class="cmhc-time-adjust-result" hidden></div>
    </section>
  `;
  $grid.appendChild(section);

  const $sale  = section.querySelector('#ta-sale-date');
  const $eff   = section.querySelector('#ta-eff-date');
  const $idx   = section.querySelector('#ta-index');
  const $price = section.querySelector('#ta-sale-price');
  const $btn   = section.querySelector('#ta-compute');
  const $out   = section.querySelector('#ta-result');

  // Find the record at or before the target date.
  function lookupAtDate(seriesId, targetIso) {
    const recs = recordsById[seriesId];
    if (!recs || recs.length === 0 || !targetIso) return null;
    let prev = null;
    for (const r of recs) {
      if (r.date <= targetIso) prev = r;
      else break;
    }
    return prev || recs[0];
  }

  function compute() {
    $out.hidden = false;
    const saleIso = $sale.value, effIso = $eff.value, id = $idx.value;
    if (!saleIso || !effIso || !id) {
      $out.innerHTML = `<p class="cmhc-time-adjust-error">Pick a sale date, effective date, and an index.</p>`;
      return;
    }
    if (saleIso >= effIso) {
      $out.innerHTML = `<p class="cmhc-time-adjust-error">Effective date must be after sale date.</p>`;
      return;
    }
    const saleHit = lookupAtDate(id, saleIso);
    const effHit  = lookupAtDate(id, effIso);
    if (!saleHit || !effHit) {
      $out.innerHTML = `<p class="cmhc-time-adjust-error">Index has no observations near one of the dates.</p>`;
      return;
    }
    const meta = seriesById[id];
    const mult = effHit.value / saleHit.value;
    const pct  = (mult - 1) * 100;
    const saleVal = parseFloat($price.value);
    let priceLine = '';
    if (Number.isFinite(saleVal) && saleVal > 0) {
      const adj = saleVal * mult;
      priceLine = `<p>Adjusted price: <strong>$${Math.round(adj).toLocaleString()}</strong> (from $${Math.round(saleVal).toLocaleString()})</p>`;
    }
    $out.innerHTML = `
      <p><strong>Multiplier:</strong> ${mult.toFixed(4)} <span class="cmhc-time-adjust-pct">(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></p>
      ${priceLine}
      <p class="cmhc-time-adjust-detail">
        ${escapeHtml(meta.title)} (${escapeHtml(meta.geo)}) — sale-date index <strong>${saleHit.value.toFixed(1)}</strong> (${escapeHtml(saleHit.date)}),
        effective-date index <strong>${effHit.value.toFixed(1)}</strong> (${escapeHtml(effHit.date)}).
      </p>
    `;
  }

  $btn.addEventListener('click', compute);
  // Pre-fill sale date to one year before today so the helper has a sensible
  // default the user can hit Calculate against.
  const oneYearAgo = new Date();
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  $sale.value = oneYearAgo.toISOString().slice(0, 10);
}

// --- Current Snapshot KPI bar -----------------------------------------------
// Map a geo string to the id token(s) it appears as in series ids — so a
// snapshotPick can be grouped with its same-metric siblings across geographies.
const GEO_ID_TOKENS = {
  CA: ['canada'], MB: ['manitoba'], SK: ['saskatchewan', 'sk'], AB: ['alberta', 'ab'],
  BC: ['british_columbia', 'bc'], ON: ['ontario', 'on'], QC: ['quebec', 'qc'], NB: ['nb'], NS: ['ns'],
  PE: ['pe'], NL: ['nl'],
  'Winnipeg-CMA': ['winnipeg'], 'Calgary-CMA': ['calgary'], 'Edmonton-CMA': ['edmonton'],
  'Regina-CMA': ['regina'], 'Saskatoon-CMA': ['saskatoon'],
  'Vancouver-CMA': ['vancouver'], 'Victoria-CMA': ['victoria'],
};
// Display order for the per-geo tiles of one metric.
const GEO_ORDER = ['CA', 'MB', 'SK', 'AB', 'BC', 'ON', 'QC', 'NB', 'NS', 'PE', 'NL',
  'Winnipeg-CMA', 'Calgary-CMA', 'Edmonton-CMA', 'Regina-CMA', 'Saskatoon-CMA',
  'Vancouver-CMA', 'Victoria-CMA'];
// A series id with its geo segment removed, so the same metric across different
// geographies maps to one key (statscan.cpi_allitems.{manitoba|saskatchewan} ->
// statscan.cpi_allitems; derived.rent.winnipeg.yoy -> derived.rent.yoy). Keeps
// multi-metric charts (farm cash total/crop/livestock, rent-vs-wage, mortgage
// 5/3/1yr) from collapsing — only the snapshotPick's own metric is shown.
function geoStripId(id, geo) {
  const parts = String(id).split('.');
  for (const tok of (GEO_ID_TOKENS[geo] || [])) {
    const idx = parts.indexOf(tok);
    if (idx >= 0) { parts.splice(idx, 1); break; }
  }
  return parts.join('.');
}

// A city's tiles/lines only appear when its parent province is also selected —
// Jason doesn't typically mix cities across provinces. National + province geos
// pass through unchanged. Applied to both the snapshot and the charts.
const CITY_PROVINCE = {
  'Winnipeg-CMA': 'MB', 'Regina-CMA': 'SK', 'Saskatoon-CMA': 'SK',
  'Calgary-CMA': 'AB', 'Edmonton-CMA': 'AB', 'Vancouver-CMA': 'BC', 'Victoria-CMA': 'BC',
};
function effectiveGeos(enabled) {
  return new Set([...enabled].filter(g => {
    const prov = CITY_PROVINCE[g];
    return !prov || enabled.has(prov);
  }));
}
// Geography tier for a tile (drives the snapshot's section grouping).
function geoTier(geo) {
  if (geo && /-CMA$/.test(geo)) return 'urban';
  if (!geo || geo === 'CA') return 'national';
  return 'provincial';
}

function buildSnapshot(catalog, shards) {
  const $bar = document.getElementById('mi-snapshot');
  if (!$bar) return;
  $bar.replaceChildren();
  const eff = effectiveGeos(state.geosEnabled);
  const tiers = { national: [], provincial: [], urban: [] };
  Object.entries(catalog.charts || {}).forEach(([chartId, c]) => {
    if (!c.snapshotPick) return;
    const shard = shards[c.displayGroup];
    if (!shard) return;
    const pick = (shard.series || []).find(s => s.id === c.snapshotPick);
    if (!pick) return;
    // Geo-aware: one tile per enabled geography for the snapshotPick's metric —
    // its same-metric siblings (same chartId + same geo-stripped id). Single-geo
    // / national metrics always render; tiles bucket into geography tiers, in
    // catalog (logical) chart order within each tier.
    const key = geoStripId(pick.id, pick.geo);
    const sibs = (shard.series || [])
      .filter(s => s.chartId === chartId && geoStripId(s.id, s.geo) === key);
    const filterApplies = new Set(sibs.map(s => s.geo)).size > 1 && c.geoFilter !== false;
    sibs
      .filter(s => !filterApplies || eff.has(s.geo))
      .sort((a, b) => (GEO_ORDER.indexOf(a.geo) + 1 || 99) - (GEO_ORDER.indexOf(b.geo) + 1 || 99))
      .forEach(meta => tiers[geoTier(meta.geo)].push({ c, meta, shard }));
  });
  [['national', 'National'], ['provincial', 'Provincial'], ['urban', 'Urban Centre']]
    .forEach(([tier, title]) => {
      const items = tiers[tier];
      if (!items.length) return;
      const section = document.createElement('section');
      const h = document.createElement('h3');
      h.className = 'cmhc-snapshot-title';
      h.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'cmhc-snapshot-grid';
      items.forEach(({ c, meta, shard }) => renderSnapshotTile(c, meta, shard, grid));
      section.append(h, grid);
      $bar.appendChild(section);
    });
}

function renderSnapshotTile(c, meta, shard, $bar) {
  const tile = document.createElement('div');
  tile.className = 'cmhc-kpi';
  tile.innerHTML = `
    <div class="cmhc-kpi-label">${escapeHtml(c.title)}</div>
    <div class="cmhc-kpi-value"></div>
    <div class="cmhc-kpi-meta"></div>
    <div class="cmhc-kpi-deltas"></div>
    <div class="cmhc-kpi-source"></div>
  `;
  const fmtKey = (meta.units === 'dollar' && Math.abs(meta.latestValue ?? 0) >= 1e6)
    ? 'dollar_millions' : meta.units;
  tile.querySelector('.cmhc-kpi-value').textContent = (FMT[fmtKey] || ((v) => String(v)))(meta.latestValue);
  tile.querySelector('.cmhc-kpi-meta').textContent =
    `${meta.chartLabel || meta.id} • as of ${meta.latestDate}`;

  const records = (shard.records || []).filter(r => r.id === meta.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  const $deltas = tile.querySelector('.cmhc-kpi-deltas');
  const windows = [
    { label: '90d',  days: 90 },
    { label: '12mo', days: 365 },
    { label: '24mo', days: 730 },
  ];
  windows.forEach(w => {
    const d = computeDelta(records, w.days, meta.units);
    if (!d) return;
    let sentiment = 'flat';
    if (d.direction !== 'flat') {
      sentiment = (d.direction === c.goodDirection) ? 'favourable' : 'unfavourable';
    }
    const chip = document.createElement('span');
    chip.className = `cmhc-kpi-delta ${sentiment}`;
    chip.innerHTML = `<span class="cmhc-kpi-delta-window">${w.label}</span> ${d.arrow} ${d.label}`;
    $deltas.appendChild(chip);
  });

  // Source attribution per metric — provider name (linking to the source series
  // where available). Built with DOM nodes so the URL is never string-injected.
  const $src = tile.querySelector('.cmhc-kpi-source');
  const srcName = PROVIDER_LABEL[meta.provider] || meta.provider || 'Source';
  if (meta.sourceUrl) {
    const a = document.createElement('a');
    a.href = meta.sourceUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = srcName;
    $src.append('Source: ', a);
  } else {
    $src.textContent = `Source: ${srcName}`;
  }

  $bar.appendChild(tile);
}

/**
 * Compute the delta over a target lookback window from a date-sorted records
 * array. Returns { direction, arrow, label } or null when there's not enough
 * history. Direction semantics: 'up' / 'down' / 'flat'.
 *
 * For percent and balance_of_opinion series we report absolute change in pp.
 * For dollar / index / units series we report % change.
 */
function computeDelta(records, daysBack, units) {
  if (!records || records.length < 2) return null;
  const last = records[records.length - 1];
  const target = new Date(last.date);
  target.setUTCDate(target.getUTCDate() - daysBack);
  const targetIso = target.toISOString().slice(0, 10);

  // Find the record nearest to target (linear scan from the end, stop when
  // we cross the target). Records are date-sorted ascending.
  let prior = null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].date <= targetIso) { prior = records[i]; break; }
  }
  if (!prior || prior.date === last.date) return null;

  const latest = Number(last.value);
  const prev   = Number(prior.value);
  if (!Number.isFinite(latest) || !Number.isFinite(prev) || prev === 0) return null;

  let delta, label, threshold;
  if (units === 'percent' || units === 'balance_of_opinion') {
    delta = latest - prev;
    label = `${delta > 0 ? '+' : ''}${delta.toFixed(2)} pp`;
    threshold = units === 'balance_of_opinion' ? 2 : 0.1;
  } else {
    delta = (latest - prev) / Math.abs(prev) * 100;
    label = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
    threshold = 0.5;
  }
  const direction = Math.abs(delta) < threshold ? 'flat'
                  : delta > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '↑'
              : direction === 'down' ? '↓'
              : '→';
  return { direction, arrow, label };
}

// --- Chart sections ---------------------------------------------------------
function buildChartSections(catalog, shards) {
  const $grid = document.getElementById('mi-chart-grid');
  if (!$grid) return;
  $grid.replaceChildren();
  lastRender.cards = [];

  const groupsInOrder = Object.entries(catalog.displayGroups || {})
    .sort((a, b) => (a[1].order || 99) - (b[1].order || 99))
    .map(([id, g]) => ({ id, ...g }));

  groupsInOrder.forEach(g => {
    const shard = shards[g.id];
    if (!shard) return;

    const section = document.createElement('section');
    section.className = 'cmhc-mi-section';
    section.dataset.group = g.id;
    section.id = `mi-section-${g.id}`;
    section.innerHTML = `<h2 class="cmhc-mi-section-title">${escapeHtml(g.title)}</h2><div class="cmhc-mi-section-grid grid md:grid-cols-2 gap-4"></div>`;
    const $sectionGrid = section.querySelector('.cmhc-mi-section-grid');

    // Iterate chartIds that belong to this group, ordered by chart.order.
    const chartsInGroup = Object.entries(catalog.charts || {})
      .filter(([, c]) => c.displayGroup === g.id)
      .sort((a, b) => (a[1].order || 99) - (b[1].order || 99));

    chartsInGroup.forEach(([chartId, chartCfg]) => {
      const seriesMetaAll = (shard.series || []).filter(s => s.chartId === chartId);
      if (seriesMetaAll.length === 0) return;
      // Skip charts with no records (e.g. arrears, disabled).
      const idsAll = new Set(seriesMetaAll.map(s => s.id));
      const recordsAll = (shard.records || []).filter(r => idsAll.has(r.id));
      if (recordsAll.length === 0) return;

      const sourceLabel = uniqueProviderLabel(seriesMetaAll);
      const card = buildIndicatorCard($sectionGrid, {
        chartId,
        title: chartCfg.title,
        sourceLabel,
        description: chartCfg.description,
      });
      // Only apply the geo filter on charts that have more than one
      // geography available. Charts where every series is the same geo
      // (national-only — mortgage rates, bond yields, SLOS, CORRA, policy)
      // are always rendered regardless of the geography toggles. Charts with
      // geoFilter:false (population / immigration, which span every province)
      // also bypass the CA/MB/Winnipeg toggle so all their lines stay visible.
      const chartGeos = new Set(seriesMetaAll.map(s => s.geo));
      const filterApplies = chartGeos.size > 1 && chartCfg.geoFilter !== false;
      const eff = effectiveGeos(state.geosEnabled);
      const seriesMeta = filterApplies
        ? seriesMetaAll.filter(s => eff.has(s.geo))
        : seriesMetaAll;
      const ids = new Set(seriesMeta.map(s => s.id));
      const records = recordsAll.filter(r => ids.has(r.id));
      card.render(records, seriesMeta, {
        subtitle: subtitleFor(seriesMeta),
        monthFrom: state.monthFrom,
        monthTo:   state.monthTo,
      });
      // Stash the unfiltered set so rerenderCards() can re-apply the filter
      // without having to re-walk the shard each time.
      lastRender.cards.push({
        chartId, group: g.id, card,
        seriesMetaAll, recordsAll,
        chartCfg,
      });
    });

    if ($sectionGrid.childElementCount > 0) $grid.appendChild(section);
  });
}

function uniqueProviderLabel(seriesMeta) {
  const provs = [...new Set(seriesMeta.map(s => PROVIDER_LABEL[s.provider] || s.provider))];
  return provs.join(' / ');
}

function subtitleFor(seriesMeta) {
  const geos = [...new Set(seriesMeta.map(s => s.geo))];
  const freqs = [...new Set(seriesMeta.map(s => s.frequency))];
  // Collapse the geo list once it gets long (population / immigration span
  // every province) so the subtitle stays readable.
  const geoLabel = geos.length > 4 ? `${geos.length} geographies` : geos.join(' + ');
  return `${geoLabel} • ${freqs.join(' / ')}`;
}

// --- Sidebar wiring ---------------------------------------------------------
function wireSidebar(catalog, manifest) {
  const $yFrom = document.getElementById('mi-month-from');
  const $yTo   = document.getElementById('mi-month-to');
  const $sectionsBox = document.getElementById('mi-section-toggles');
  const $asOf  = document.getElementById('mi-data-as-of');

  if ($asOf) $asOf.textContent =
    `${manifest.totalSeries || '?'} series, latest ${
      (manifest.groups || []).map(g => g.latestDate).sort().slice(-1)[0] || '—'}`;

  // Pre-fill the month-range inputs with the default 5-year window so the
  // user sees the value the charts are filtering to.
  if ($yFrom && state.monthFrom) $yFrom.value = state.monthFrom;
  if ($yTo   && state.monthTo)   $yTo.value   = state.monthTo;

  if ($sectionsBox) {
    $sectionsBox.innerHTML = '';
    // Only list sections that actually have rendered content (a section's
    // <section> DOM node carries data-group). A group the catalog declares
    // but the pipeline hasn't populated (no shard / no records) renders no
    // section and is skipped here.
    const renderedGroups = new Set(
      [...document.querySelectorAll('.cmhc-mi-section')].map(s => s.dataset.group)
    );
    Object.entries(catalog.displayGroups || {})
      .filter(([id]) => renderedGroups.has(id))
      .sort((a, b) => (a[1].order || 99) - (b[1].order || 99))
      .forEach(([id, g]) => {
        const lbl = document.createElement('label');
        lbl.className = 'flex items-center gap-1';
        lbl.innerHTML =
          `<input type="checkbox" data-section="${escapeHtml(id)}" checked /> ${escapeHtml(g.title)}`;
        $sectionsBox.appendChild(lbl);
      });
    $sectionsBox.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.sectionsHidden.delete(cb.dataset.section);
        else state.sectionsHidden.add(cb.dataset.section);
        applySectionVisibility();
      });
    });
  }

  // "Jump to section" list — anchor links into each rendered section.
  const $jumpList = document.getElementById('mi-jump-list');
  if ($jumpList) {
    $jumpList.innerHTML = '';
    const renderedGroups = new Set(
      [...document.querySelectorAll('.cmhc-mi-section')].map(s => s.dataset.group)
    );
    // Synthetic "Top" entry first so the user can hop back up.
    const topLi = document.createElement('li');
    topLi.innerHTML = `<a href="#" data-jump="top" class="cmhc-mi-jump-link">↑ Current Snapshot</a>`;
    $jumpList.appendChild(topLi);

    Object.entries(catalog.displayGroups || {})
      .filter(([id]) => renderedGroups.has(id))
      .sort((a, b) => (a[1].order || 99) - (b[1].order || 99))
      .forEach(([id, g]) => {
        const li = document.createElement('li');
        li.innerHTML =
          `<a href="#mi-section-${encodeURIComponent(id)}" data-jump="${escapeHtml(id)}" class="cmhc-mi-jump-link">${escapeHtml(g.title)}</a>`;
        $jumpList.appendChild(li);
      });

    // Smooth-scroll + skip-default-anchor-jump so the existing tab hash
    // routing (#tables, #starts, #indicators) doesn't break.
    $jumpList.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const key = a.dataset.jump;
        if (key === 'top') {
          document.getElementById('tab-panel-indicators')?.scrollTo({ top: 0, behavior: 'smooth' });
          // Fallback for browsers / layouts that scroll the document instead.
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          document.getElementById(`mi-section-${key}`)?.scrollIntoView({
            behavior: 'smooth', block: 'start',
          });
        }
      });
    });
  }

  let pending = null;
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; rerenderCards(); }, 120);
  };
  $yFrom?.addEventListener('change', () => {
    if ($yFrom.value) {
      state.monthFrom = $yFrom.value;        // explicit choice — stop auto-tracking
      state.monthFromLocked = true;
    } else {
      state.monthFromLocked = false;         // cleared — resume the smart default
      state.monthFrom = autoFromFor(state.monthTo);
      $yFrom.value = state.monthFrom;
    }
    schedule();
  });
  $yTo?.addEventListener('change', () => {
    state.monthTo = $yTo.value || null;
    if (!state.monthFromLocked) {            // "from" is auto → flip to 5y before "to"
      state.monthFrom = autoFromFor(state.monthTo);
      if ($yFrom) $yFrom.value = state.monthFrom;
    }
    schedule();
  });

  // Geography selectors (multi-select: Province/national + CMA) — live-update
  // charts + KPI tiles. The enabled set is the union of both dropdowns' selections.
  const geoSelects = ['mi-geo-prov', 'mi-geo-cma']
    .map(id => document.getElementById(id)).filter(Boolean);
  const readGeos = () => new Set(
    geoSelects.flatMap(sel => [...sel.selectedOptions].map(o => o.value)));
  if (geoSelects.length) state.geosEnabled = readGeos();   // seed from the dropdowns
  geoSelects.forEach(sel => sel.addEventListener('change', () => {
    state.geosEnabled = readGeos();
    schedule();
  }));

  // Snapshot-tab geography picker — a Province (BC/AB/SK/MB) + an Urban centre
  // (the province's CMAs), driving the same shared geosEnabled and kept in sync
  // with the Market Indicators multi-selects so the two controls never diverge.
  const PROV_CMAS = {
    MB: [['Winnipeg-CMA', 'Winnipeg']],
    SK: [['Regina-CMA', 'Regina'], ['Saskatoon-CMA', 'Saskatoon']],
    AB: [['Calgary-CMA', 'Calgary'], ['Edmonton-CMA', 'Edmonton']],
    BC: [['Vancouver-CMA', 'Vancouver'], ['Victoria-CMA', 'Victoria']],
  };
  const $snapProv = document.getElementById('snap-geo-prov');
  const $snapCma  = document.getElementById('snap-geo-cma');
  if ($snapProv && $snapCma) {
    const fillCma = (prov, want) => {
      const cmas = PROV_CMAS[prov] || [];
      $snapCma.innerHTML = '<option value="">(province only)</option>' +
        cmas.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      if (want && cmas.some(([v]) => v === want)) $snapCma.value = want;
    };
    const syncMi = (geos) => ['mi-geo-prov', 'mi-geo-cma'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) for (const o of sel.options) o.selected = geos.has(o.value);
    });
    const apply = () => {
      // Province + (optional) one urban centre. Province always included so its
      // tiles show alongside the city's; "Canada"/national tiles render regardless.
      state.geosEnabled = new Set([$snapProv.value, $snapCma.value].filter(Boolean));
      syncMi(state.geosEnabled);
      schedule();
    };
    // Seed the picker from whatever geo state is already active.
    const curProv = [...state.geosEnabled].find(g => PROV_CMAS[g]) || 'MB';
    const curCma  = [...state.geosEnabled].find(g => /-CMA$/.test(g)) || '';
    $snapProv.value = PROV_CMAS[curProv] ? curProv : 'MB';
    fillCma($snapProv.value, curCma);
    $snapProv.addEventListener('change', () => { fillCma($snapProv.value); apply(); });
    $snapCma.addEventListener('change', apply);
  }
}

function applySectionVisibility() {
  document.querySelectorAll('.cmhc-mi-section').forEach(sec => {
    const hidden = state.sectionsHidden.has(sec.dataset.group);
    sec.hidden = hidden;
    sec.classList.toggle('hidden', hidden);
  });
}

function rerenderCards() {
  lastRender.cards.forEach(({ card, seriesMetaAll, recordsAll, chartCfg }) => {
    // Same conditional filter as the initial render — single-geo charts
    // (and geoFilter:false charts) always show their lines.
    const chartGeos = new Set(seriesMetaAll.map(s => s.geo));
    const filterApplies = chartGeos.size > 1 && chartCfg?.geoFilter !== false;
    const eff = effectiveGeos(state.geosEnabled);
    const seriesMeta = filterApplies
      ? seriesMetaAll.filter(s => eff.has(s.geo))
      : seriesMetaAll;
    const ids = new Set(seriesMeta.map(s => s.id));
    const records = recordsAll.filter(r => ids.has(r.id));
    card.render(records, seriesMeta, {
      subtitle: subtitleFor(seriesMeta),
      monthFrom: state.monthFrom,
      monthTo:   state.monthTo,
    });
  });
  // Re-render the KPI bar too — geo filter affects which tiles are visible.
  if (lastRender.catalog && lastRender.shards) {
    buildSnapshot(lastRender.catalog, lastRender.shards);
  }
}

// --- Excel export -----------------------------------------------------------
function wireExcelDownload(catalog, shards) {
  const $dl = document.getElementById('mi-download-xlsx');
  if (!$dl) return;
  $dl.addEventListener('click', async () => {
    const { exportIndicatorsToExcel } = await import('./excel-export.js');
    await exportIndicatorsToExcel({ catalog, shards });
  });
}
