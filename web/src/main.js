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
import { initStarts } from './starts.js';
import { initIndicators } from './indicators.js';

const SERIES_PANELS = [
  'Median Rent',
  'Average Rent',
  'Vacancy Rate',
  'Average Rent Change',
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
  const promise = fetch(url).then(r => {
    if (!r.ok) throw new Error(`shard ${url}: HTTP ${r.status}`);
    return r.json();
  }).catch(err => {
    console.warn('[shard]', err);
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
    starts:     { btn: document.getElementById('tab-btn-starts'),     panel: document.getElementById('tab-panel-starts') },
    indicators: { btn: document.getElementById('tab-btn-indicators'), panel: document.getElementById('tab-panel-indicators') },
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
  const hashTab = window.location.hash.replace('#', '');
  const initialTab = ['charts', 'tables', 'starts', 'indicators'].includes(hashTab) ? hashTab : 'charts';
  setupTabs(initialTab);

  // Bootstrap the other views (idempotent — no DOM rendered until the
  // user lands on that tab and the filter state is non-empty).
  initTables({ geographies, manifest, loadShard });
  initStarts({ manifest });
  initIndicators().catch(err => console.error('[indicators bootstrap]', err));

  await renderAll(filters.getState());

  async function renderAll(state) {
    syncURL(state);
    if (!state.geoUid) { setEmptyState(true); cards.forEach(c => c.render(null, '')); return; }

    const shard = await loadShard(state.geoLevel, state.geoUid);
    if (!shard) { setEmptyState(true); cards.forEach(c => c.render(null, '')); return; }

    const yearFrom = state.yearFrom ?? Math.max((manifest.cmhcMaxYear ?? new Date().getFullYear()) - 10, 1990);
    const yearTo   = state.yearTo   ?? (manifest.cmhcMaxYear ?? new Date().getFullYear());

    let anyData = false;
    for (const card of cards) {
      const dims = capabilities?.series?.[card.series]?.dimensions || [];
      const dim  = dims.includes(state.breakdown) ? state.breakdown : dims[0];
      const hiddenForDim = new Set(state.hiddenCategories?.[dim] || []);
      const filtered = (shard.records || []).filter(r =>
        r.series === card.series &&
        r.dimension === dim &&
        r.dwellingType === state.dwellingType &&
        (r.season === state.season || !state.season) &&
        r.year >= yearFrom && r.year <= yearTo &&
        !hiddenForDim.has(r.category)
      );
      if (filtered.length) anyData = true;
      const levelLabel = LEVEL_LABEL[shard.geoLevel] || shard.geoLevel;
      const dwellingLabel = DWELLING_LABEL[state.dwellingType] || state.dwellingType;
      const sub = `${levelLabel}: ${shard.geoName} — ${dwellingLabel}, by ${dim}`;
      card.render(filtered, sub, CATEGORY_ORDER[dim] || [], { season: state.season });
    }
    setEmptyState(!anyData);
  }
}

bootstrap().catch(err => {
  console.error('[bootstrap]', err);
  const grid = document.getElementById('chart-grid');
  if (grid) grid.innerHTML = `<div class="text-red-700 text-sm">Failed to load data: ${err.message}</div>`;
});
