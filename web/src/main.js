/*
 * Entry point. Loads manifest + geographies + capabilities once, wires the
 * filter UI, then re-renders the 4 chart panels whenever filters change.
 *
 * Geography-shard JSONs are fetched lazily (one per active geography) and
 * cached in-memory for the session.
 */

import { initFilters } from './filters.js';
import { buildChartCard } from './chart.js';
import { decodeState, syncURL } from './state.js';
import { initTables } from './tables.js';
import { initCompare } from './compare.js';
import { initStarts } from './starts.js';
import { initSecondary } from './secondary.js';
import { initIndicators } from './indicators.js';
import { initHousing } from './housing.js';
import { initCensus } from './census.js';
import { initEconomicUpdate } from './economic-update.js';
import { initAffordability } from './affordability.js';
import { initRtb } from './rtb.js';
import { wireChartDocExports } from './doc-image-export.js';

const SERIES_PANELS = [
  'Median Rent',
  'Average Rent',
  'Vacancy Rate',
  'Average Rent Change',
  'Rental Universe',
];

// Human-readable label for the geo level. Mirrors filters.js LEVEL_LABEL —
// kept in this file so the chart subtitle reads cleanly when the same name
// is used at multiple levels (e.g. "Winnipeg" CMA vs "Winnipeg (CY)" CSD).
const LEVEL_LABEL = {
  province:      'Province',
  cma:           'CMA/CA',
  csd:           'Census Subdivision',
  zone:          'Survey Zone',
  neighbourhood: 'Neighbourhood',
};

// Subtitle phrasing for the dwelling-type filter.
const DWELLING_LABEL = {
  All:       'All Types',
  Apartment: 'Apartments Only',
  Row:       'Row Only',
};

// Canonical legend order per breakdown. "Total" is always last so the line
// for the aggregate sits at the bottom of the colour stack. Strings must
// match the actual CMHC label exactly (probed against the cma_605.json shard).
const CATEGORY_ORDER = {
  'Bedroom Type':         ['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom +', 'Total'],
  'Year of Construction': ['Before 1960', '1960 - 1979', '1980 - 1999', '2000 or Later', 'Total'],
  'Structure Size':       ['3-5 Units', '6-19 Units', '20-49 Units', '50-199 Units', '200+ Units', 'Total'],
  'Rent Ranges':          ['Less Than $750', '$750 - $999', '$1,000 - $1,249', '$1,250 - $1,499', '$1,500 +', 'Non-Market/Unknown', 'Total'],
};

const shardCache = new Map();
async function loadShard(level, uid) {
  const key = `${level}_${uid}`;
  if (shardCache.has(key)) return shardCache.get(key);
  const url = `./data/series/${key}.json`;
  // Cache the in-flight promise so concurrent callers share one request, but
  // evict on failure so a transient network blip doesn't poison the shard
  // forever (the user would otherwise have to reload the page to retry).
  const promise = fetch(url).then(r => {
    if (!r.ok) throw new Error(`shard ${url}: HTTP ${r.status}`);
    return r.json();
  }).catch(err => {
    console.warn('[shard]', err);
    shardCache.delete(key);
    return null;
  });
  shardCache.set(key, promise);
  return promise;
}

async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function setEmptyState(showing) {
  const el = document.getElementById('empty-state');
  if (!el) return;
  el.hidden = !showing;
  el.classList.toggle('hidden', !showing);
}

function setDataAsOf(text) {
  const el = document.getElementById('data-as-of');
  if (el) el.textContent = text;
}

function setupTabs(initial) {
  const tabs = {
    charts:     { btn: document.getElementById('tab-btn-charts'),     panel: document.getElementById('tab-panel-charts') },
    tables:     { btn: document.getElementById('tab-btn-tables'),     panel: document.getElementById('tab-panel-tables') },
    compare:    { btn: document.getElementById('tab-btn-compare'),    panel: document.getElementById('tab-panel-compare') },
    starts:     { btn: document.getElementById('tab-btn-starts'),     panel: document.getElementById('tab-panel-starts') },
    secondary:  { btn: document.getElementById('tab-btn-secondary'),  panel: document.getElementById('tab-panel-secondary') },
    housing:    { btn: document.getElementById('tab-btn-housing'),    panel: document.getElementById('tab-panel-housing') },
    census:     { btn: document.getElementById('tab-btn-census'),     panel: document.getElementById('tab-panel-census') },
    snapshot:   { btn: document.getElementById('tab-btn-snapshot'),   panel: document.getElementById('tab-panel-snapshot') },
    indicators: { btn: document.getElementById('tab-btn-indicators'), panel: document.getElementById('tab-panel-indicators') },
    economic:   { btn: document.getElementById('tab-btn-economic'),   panel: document.getElementById('tab-panel-economic') },
    affordability: { btn: document.getElementById('tab-btn-affordability'), panel: document.getElementById('tab-panel-affordability') },
    rtb:        { btn: document.getElementById('tab-btn-rtb'),        panel: document.getElementById('tab-panel-rtb') },
  };

  function activate(name) {
    for (const [key, t] of Object.entries(tabs)) {
      const isActive = key === name;
      t.btn?.classList.toggle('cmhc-tab-active', isActive);
      t.btn?.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (t.panel) t.panel.hidden = !isActive;
    }
    // URL fragment so the active tab is link-shareable.
    const hash = name === 'charts' ? '' : `#${name}`;
    if (window.location.hash !== hash) {
      const url = new URL(window.location.href);
      url.hash = hash;
      window.history.replaceState(null, '', url.toString());
    }
  }

  for (const [key, t] of Object.entries(tabs)) {
    t.btn?.addEventListener('click', () => activate(key));
  }
  activate(initial);
}

async function bootstrap() {
  const [manifest, geographies, capabilities] = await Promise.all([
    loadJson('./data/manifest.json').catch(() => ({ shards: [], lastUpdated: null, cmhcMaxYear: null })),
    loadJson('./data/geographies.json').catch(() => ({ levels: {} })),
    loadJson('./data/capabilities.json').catch(() => ({ series: {} })),
  ]);

  // Footer "Data as of …"
  if (manifest.lastUpdated) {
    const d = new Date(manifest.lastUpdated);
    const asOf = manifest.cmhcMaxYear
      ? `${manifest.cmhcMaxYear} (refreshed ${d.toISOString().slice(0,10)})`
      : d.toISOString().slice(0,10);
    setDataAsOf(asOf);
    // Sitewide footer citation date — "Month Year" of the latest refresh.
    const citeEl = document.getElementById('site-citation-date');
    if (citeEl) {
      citeEl.textContent = d.toLocaleDateString('en-CA',
        { year: 'numeric', month: 'long' });
    }
    // Sitewide footer "Data last refreshed" — ISO date plus relative age.
    const lastEl = document.getElementById('site-last-refreshed');
    if (lastEl) {
      const iso = d.toISOString().slice(0, 10);
      const ageDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
      const rel = ageDays < 1   ? 'today'
              : ageDays === 1 ? '1 day ago'
              : ageDays < 30  ? `${ageDays} days ago`
                              : `${Math.round(ageDays / 7)} weeks ago`;
      lastEl.textContent = `${iso} (${rel})`;
    }
  }

  // Build chart cards once; render() will be called per filter change.
  const grid = document.getElementById('chart-grid');
  grid.replaceChildren();
  const cards = SERIES_PANELS.map(series =>
    ({ series, ...buildChartCard(grid, { series }) })
  );

  const initialState = decodeState(window.location.search);

  const filters = initFilters({
    geographies,
    capabilities,
    categoryOrder: CATEGORY_ORDER,
    initialState,
    onChange: renderAll,
  });

  // Copy-link button
  document.getElementById('copy-link')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(window.location.href);
  });

  // ── Tab switching ──
  // Resolve initial tab from the URL hash. Section-anchor hashes
  // (#mi-section-<group>) belong to the Market Indicators tab; treat them
  // as a synonym for the bare #indicators hash so deep links from the
  // sidebar TOC work after a hard refresh.
  const rawHash = window.location.hash.replace('#', '');
  let initialTab = 'charts';
  if (['charts', 'tables', 'compare', 'starts', 'secondary', 'housing', 'census', 'affordability', 'rtb', 'snapshot', 'indicators', 'economic'].includes(rawHash)) {
    initialTab = rawHash;
  } else if (rawHash.startsWith('mi-section-')) {
    initialTab = 'indicators';
    // Defer the scroll until after initIndicators has rendered the section.
    setTimeout(() => {
      document.getElementById(rawHash)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 1000);
  }
  setupTabs(initialTab);

  // Bootstrap the other views eagerly at page load. (Task 2.1 in the audit
  // plan: convert to lazy first-activation initialisation so first paint
  // doesn't fetch 7MB of JSON the user may never look at.)
  initTables({ geographies, manifest, loadShard });
  initCompare({ geographies, capabilities, manifest, categoryOrder: CATEGORY_ORDER, loadShard });
  initStarts({ manifest });
  initSecondary({ manifest }).catch(err => console.error('[secondary bootstrap]', err));
  initIndicators().catch(err => console.error('[indicators bootstrap]', err));
  initHousing().catch(err => console.error('[housing bootstrap]', err));
  initCensus().catch(err => console.error('[census bootstrap]', err));
  initEconomicUpdate().catch(err => console.error('[economic bootstrap]', err));
  initAffordability().catch(err => console.error('[affordability bootstrap]', err));
  initRtb().catch(err => console.error('[rtb bootstrap]', err));

  // Per-tab "Download Word/Excel (charts)" exports — every rendered chart in
  // the active tab captured as a PNG and embedded one per page / worksheet.
  // The Tables tab keeps its own table-based exports.
  const hasPlot = (n) =>
    (n.querySelector('[data-role="plot"]')?.childElementCount ?? 0) > 0;
  wireChartDocExports({
    docxBtnId: 'charts-download-docx',
    xlsxBtnId: 'charts-download-xlsx',
    baseName:  'RentalCharts',
    getNodes:  () => [...document.querySelectorAll('#chart-grid .chart-card')].filter(hasPlot),
  });
  wireChartDocExports({
    docxBtnId: 'hs-download-docx-charts',
    xlsxBtnId: 'hs-download-xlsx-charts',
    baseName:  'HousingStarts',
    getNodes:  () => [...document.querySelectorAll('#hs-chart-grid .chart-card')].filter(hasPlot),
  });
  wireChartDocExports({
    docxBtnId: 'hsk-download-docx-charts',
    xlsxBtnId: 'hsk-download-xlsx-charts',
    baseName:  'HousingStock',
    getNodes:  () => [...document.querySelectorAll('#hsk-chart-grid .chart-card')].filter(hasPlot),
  });
  wireChartDocExports({
    docxBtnId: 'sr-download-docx-charts',
    xlsxBtnId: 'sr-download-xlsx-charts',
    baseName:  'SecondaryRental',
    getNodes:  () => [...document.querySelectorAll('#sr-chart-grid .chart-card')].filter(hasPlot),
  });
  wireChartDocExports({
    docxBtnId: 'mi-download-docx-charts',
    xlsxBtnId: 'mi-download-xlsx-charts',
    baseName:  'MarketIndicators',
    getNodes:  () => [...document.querySelectorAll('#mi-chart-grid .chart-card')].filter(hasPlot),
  });
  wireChartDocExports({
    docxBtnId: 'census-download-docx-charts',
    xlsxBtnId: 'census-download-xlsx-charts',
    baseName:  'CensusProfile',
    getNodes:  () => [...document.querySelectorAll('#census-chart-grid .chart-card')].filter(hasPlot),
  });
  // Snapshot is a 22-tile KPI grid, not a chart grid — capture each tile
  // individually so the export stays under a few MB and Excel gets one
  // sheet per KPI. Lower pixel ratio because each tile is text-heavy and
  // doesn't benefit from print-grade rasterisation.
  wireChartDocExports({
    docxBtnId:  'snap-download-docx',
    xlsxBtnId:  'snap-download-xlsx',
    baseName:   'CurrentSnapshot',
    pixelRatio: 2,
    getNodes:   () => [...document.querySelectorAll('#mi-snapshot .cmhc-kpi')],
  });

  await renderAll(filters.getState());

  async function renderAll(state) {
    syncURL(state);
    if (!state.geoUid) { setEmptyState(true); cards.forEach(c => c.render(null, '')); return; }

    const shard = await loadShard(state.geoLevel, state.geoUid);
    if (!shard) { setEmptyState(true); cards.forEach(c => c.render(null, '')); return; }

    const yearFrom = state.yearFrom ?? Math.max((manifest.cmhcMaxYear ?? new Date().getFullYear()) - 5, 1990);
    const yearTo   = state.yearTo   ?? (manifest.cmhcMaxYear ?? new Date().getFullYear());

    let anyData = false;
    for (const card of cards) {
      // Use the selected breakdown directly. A series that doesn't publish it
      // (e.g. Median Rent has no "Rent Ranges") simply has no matching records,
      // so the panel renders "No data" for that breakdown — rather than silently
      // falling back to a different dimension, which read as "not updating".
      const dim = state.breakdown;
      const hiddenForDim = new Set(state.hiddenCategories?.[dim] || []);
      const filtered = (shard.records || []).filter(r =>
        r.series === card.series &&
        r.dimension === dim &&
        r.dwellingType === state.dwellingType &&
        // CMHC RMS for these geographies is published only for the October
        // snapshot — the season control was removed, so filter to October
        // explicitly (guards against any stray April rows a future refresh
        // might introduce).
        r.season === 'October' &&
        r.year >= yearFrom && r.year <= yearTo &&
        !hiddenForDim.has(r.category)
      );
      if (filtered.length) anyData = true;
      const levelLabel = LEVEL_LABEL[shard.geoLevel] || shard.geoLevel;
      const dwellingLabel = DWELLING_LABEL[state.dwellingType] || state.dwellingType;
      const sub = `${levelLabel}: ${shard.geoName} — ${dwellingLabel}, by ${dim}`;
      // Season is fixed to October (the only RMS snapshot CMHC publishes for
      // these areas); kept in the caption so the survey vintage stays visible.
      card.render(filtered, sub, CATEGORY_ORDER[dim] || [], { season: 'October' });
    }
    setEmptyState(!anyData);
  }
}

bootstrap().catch(err => {
  console.error('[bootstrap]', err);
  const grid = document.getElementById('chart-grid');
  if (grid) grid.innerHTML = `<div class="text-red-700 text-sm">Failed to load data: ${err.message}</div>`;
});
