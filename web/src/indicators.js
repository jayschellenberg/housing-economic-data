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
 * The catalog (r/lib/indicator_catalog.json) is read from the dev server
 * once on tab activation so this module can find chart metadata
 * (titles, chartLabel, snapshotPick) without round-tripping through R.
 */

import { buildIndicatorCard } from './indicator-chart.js';

const PROVIDER_LABEL = {
  boc:      'Bank of Canada Valet',
  statscan: 'Statistics Canada (WDS)',
  cba:      'Canadian Bankers Association',
};

const FMT = {
  percent:           (v) => v == null ? '—' : `${Number(v).toFixed(2)}%`,
  dollar:            (v) => v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`,
  dollar_millions:   (v) => v == null ? '—' : `$${(Number(v) / 1e6).toFixed(1)}M`,
  index:             (v) => v == null ? '—' : Number(v).toFixed(1),
  units:             (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  persons:           (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  ratio:             (v) => v == null ? '—' : Number(v).toFixed(2),
  balance_of_opinion:(v) => v == null ? '—' : `${Number(v).toFixed(0)}`,
};

async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

let initialised = false;
let state = { yearFrom: null, yearTo: null, sectionsHidden: new Set() };
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
  wireSidebar(catalogResolved, manifest);
  wireExcelDownload(catalogResolved, shards);
}

// --- Current Snapshot KPI bar -----------------------------------------------
function buildSnapshot(catalog, shards) {
  const $bar = document.getElementById('mi-snapshot');
  if (!$bar) return;
  $bar.replaceChildren();
  // For each chart with a snapshotPick, build a KPI tile.
  Object.entries(catalog.charts || {}).forEach(([chartId, c]) => {
    if (!c.snapshotPick) return;
    const sid = c.snapshotPick;
    const shard = shards[c.displayGroup];
    if (!shard) return;
    const meta = (shard.series || []).find(s => s.id === sid);
    if (!meta) return;
    const tile = document.createElement('div');
    tile.className = 'cmhc-kpi';
    tile.innerHTML = `
      <div class="cmhc-kpi-label">${c.title}</div>
      <div class="cmhc-kpi-value"></div>
      <div class="cmhc-kpi-meta"></div>
    `;
    // Auto-promote dollar values ≥ $1M to dollar_millions for KPI readability.
    const fmtKey = (meta.units === 'dollar' && Math.abs(meta.latestValue ?? 0) >= 1e6)
      ? 'dollar_millions' : meta.units;
    tile.querySelector('.cmhc-kpi-value').textContent = (FMT[fmtKey] || ((v) => String(v)))(meta.latestValue);
    tile.querySelector('.cmhc-kpi-meta').textContent =
      `${meta.chartLabel || meta.id} • as of ${meta.latestDate}`;
    $bar.appendChild(tile);
  });
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
    section.innerHTML = `<h2 class="cmhc-mi-section-title">${g.title}</h2><div class="cmhc-mi-section-grid grid md:grid-cols-2 gap-4"></div>`;
    const $sectionGrid = section.querySelector('.cmhc-mi-section-grid');

    // Iterate chartIds that belong to this group, ordered by chart.order.
    const chartsInGroup = Object.entries(catalog.charts || {})
      .filter(([, c]) => c.displayGroup === g.id)
      .sort((a, b) => (a[1].order || 99) - (b[1].order || 99));

    chartsInGroup.forEach(([chartId, chartCfg]) => {
      const seriesMeta = (shard.series || []).filter(s => s.chartId === chartId);
      if (seriesMeta.length === 0) return;
      // Skip charts with no records (e.g. arrears, disabled).
      const ids = new Set(seriesMeta.map(s => s.id));
      const records = (shard.records || []).filter(r => ids.has(r.id));
      if (records.length === 0) return;

      const sourceLabel = uniqueProviderLabel(seriesMeta);
      const card = buildIndicatorCard($sectionGrid, {
        chartId,
        title: chartCfg.title,
        sourceLabel,
      });
      card.render(records, seriesMeta, {
        subtitle: subtitleFor(seriesMeta),
        yearFrom: state.yearFrom,
        yearTo:   state.yearTo,
      });
      lastRender.cards.push({ chartId, group: g.id, card, seriesMeta, records, chartCfg });
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
  return `${geos.join(' + ')} • ${freqs.join(' / ')}`;
}

// --- Sidebar wiring ---------------------------------------------------------
function wireSidebar(catalog, manifest) {
  const $yFrom = document.getElementById('mi-year-from');
  const $yTo   = document.getElementById('mi-year-to');
  const $sectionsBox = document.getElementById('mi-section-toggles');
  const $asOf  = document.getElementById('mi-data-as-of');

  if ($asOf) $asOf.textContent =
    `${manifest.totalSeries || '?'} series, latest ${
      (manifest.groups || []).map(g => g.latestDate).sort().slice(-1)[0] || '—'}`;

  if ($sectionsBox) {
    $sectionsBox.innerHTML = '';
    // Only list sections that actually have rendered content (a section's
    // <section> DOM node carries data-group). Skips Phase-2 groups
    // (Demand, Construction Cost, Derived) that the catalog declares
    // but the current data pipeline doesn't yet populate.
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
          `<input type="checkbox" data-section="${id}" checked /> ${g.title}`;
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

  let pending = null;
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; rerenderCards(); }, 120);
  };
  $yFrom?.addEventListener('change', () => {
    const v = parseInt($yFrom.value, 10);
    state.yearFrom = Number.isFinite(v) ? v : null;
    schedule();
  });
  $yTo?.addEventListener('change', () => {
    const v = parseInt($yTo.value, 10);
    state.yearTo = Number.isFinite(v) ? v : null;
    schedule();
  });
}

function applySectionVisibility() {
  document.querySelectorAll('.cmhc-mi-section').forEach(sec => {
    const hidden = state.sectionsHidden.has(sec.dataset.group);
    sec.hidden = hidden;
    sec.classList.toggle('hidden', hidden);
  });
}

function rerenderCards() {
  lastRender.cards.forEach(({ card, records, seriesMeta }) => {
    card.render(records, seriesMeta, {
      subtitle: subtitleFor(seriesMeta),
      yearFrom: state.yearFrom,
      yearTo:   state.yearTo,
    });
  });
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
