/*
 * Housing Starts view — Scss data (Starts / Completions / Under Construction)
 * for one geography at a time, switchable between Annual and Quarterly
 * frequency and between Dwelling Type and Intended Market breakdowns.
 *
 * Layout:
 *   - Top: 3 chart cards (one per series) reusing the same Observable Plot
 *     card builder as the Rental Charts tab.
 *   - Below: 3 data tables (rows = period, columns = category) styled with
 *     the same dark-red header treatment as the Rental Tables tab.
 *   - Excel download exports every visible table to a single .xlsx.
 *
 * Data source: web/public/data/starts/{level}_{uid}.json shards emitted by
 * r/03_build_data_files.R after r/05_scrape_starts.R writes the Scss CSV.
 */

import { buildChartCard } from './chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { escapeHtml } from './escape.js';

const SERIES = ['Starts', 'Completions', 'Under Construction',
                'Absorbed Units', 'Unabsorbed Inventory'];

// Canonical legend order per dimension. "All" is always last so it sits at
// the bottom of the colour stack (same convention as the Rental tabs).
const CATEGORY_ORDER = {
  'Dwelling Type':    ['Single', 'Semi-Detached', 'Row', 'Apartment', 'All'],
  'Intended Market':  ['Homeowner', 'Rental', 'Condo', 'Co-Op', 'Unknown', 'All'],
};

const LEVEL_LABEL = {
  province:      'Province',
  cma:           'CMA/CA',
  csd:           'Census Subdivision',
  zone:          'Survey Zone',
  neighbourhood: 'Neighbourhood',
};

// In-memory shard cache for the session. Evicts failed fetches so a transient
// blip doesn't permanently blank a geography (mirrors main.js loadShard).
const shardCache = new Map();
async function loadStartsShard(level, uid) {
  const key = `${level}_${uid}`;
  if (shardCache.has(key)) return shardCache.get(key);
  const promise = fetch(`./data/starts/${key}.json`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).catch(err => {
    console.warn('[starts shard]', err);
    shardCache.delete(key);
    return null;
  });
  shardCache.set(key, promise);
  return promise;
}

export async function initStarts({ manifest }) {
  // Geographies for the housing tab come from the dedicated index produced by
  // 03_build_data_files.R — Scss coverage differs slightly from Rms (more
  // zones, sometimes different CSDs).
  const geos = await fetch('./data/starts-geographies.json')
    .then(r => r.ok ? r.json() : { levels: {} })
    .catch(() => ({ levels: {} }));

  const $level   = document.getElementById('hs-geo-level');
  const $name    = document.getElementById('hs-geo-name');
  const $freq    = document.querySelectorAll('input[name="hsFrequency"]');
  const $bd      = document.querySelectorAll('input[name="hsBreakdown"]');
  const $yFrom   = document.getElementById('hs-year-from');
  const $yTo     = document.getElementById('hs-year-to');
  const $catBox  = document.getElementById('hs-category-toggles');
  const $banner  = document.getElementById('hs-zone-banner');
  const $empty   = document.getElementById('hs-empty-state');
  const $charts  = document.getElementById('hs-chart-grid');
  const $tables  = document.getElementById('hs-table-grid');
  const $dl      = document.getElementById('hs-download-xlsx');
  const $asOf    = document.getElementById('hs-data-as-of');

  // Level dropdown — only levels that have items.
  const levels = geos.levels || {};
  const levelOrder = ['province', 'cma', 'csd', 'zone', 'neighbourhood'];
  const availableLevels = levelOrder.filter(l => Array.isArray(levels[l]) && levels[l].length > 0);
  $level.innerHTML = availableLevels
    .map(l => `<option value="${l}">${LEVEL_LABEL[l] ?? l}</option>`)
    .join('');

  // Open on the shared "home" province (default Manitoba, uid 46) when provinces
  // are the first level; otherwise fall back to the first item in that level.
  const defaultLevel = availableLevels[0] || 'province';
  const defaultList  = levels[defaultLevel] || [];
  const defaultItem  = (defaultLevel === 'province'
      && (defaultList.find(it => String(it.uid) === resolveProvince(defaultList.map(it => String(it.uid))))
          || defaultList.find(it => it.uid === '46' || it.name === 'Manitoba')))
    || defaultList[0];

  const state = {
    geoLevel: defaultLevel,
    geoUid:   defaultItem?.uid || '',
    frequency: 'Annual',
    breakdown: 'Dwelling Type',
    yearFrom:  null,
    yearTo:    null,
    hiddenCategories: {},
  };

  function populateNames() {
    const items = levels[state.geoLevel] || [];
    $name.disabled = items.length === 0;
    $name.innerHTML = items.map(it => {
      const label = it.parentName && state.geoLevel !== 'cma' && state.geoLevel !== 'province' && state.geoLevel !== 'csd'
        ? `${it.name} — ${it.parentName}` : it.name;
      return `<option value="${it.uid}">${escapeHtml(label)}</option>`;
    }).join('') || '<option>&nbsp;</option>';
  }

  function updateZoneBanner() {
    const show = (state.geoLevel === 'zone' || state.geoLevel === 'neighbourhood');
    $banner.hidden = !show;
    $banner.classList.toggle('hidden', !show);
  }

  function renderCategoryToggles(categories) {
    const cats = categories || CATEGORY_ORDER[state.breakdown] || [];
    const hidden = new Set(state.hiddenCategories[state.breakdown] || []);
    if (cats.length === 0) { $catBox.innerHTML = ''; return; }
    $catBox.innerHTML = cats.map(cat => `
      <label class="flex items-center gap-1">
        <input type="checkbox" data-cat="${escapeHtml(cat)}" ${hidden.has(cat) ? '' : 'checked'} />
        <span>${escapeHtml(cat)}</span>
      </label>
    `).join('');
    $catBox.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cat = cb.dataset.cat;
        const list = new Set(state.hiddenCategories[state.breakdown] || []);
        if (cb.checked) list.delete(cat); else list.add(cat);
        state.hiddenCategories[state.breakdown] = [...list];
        scheduleRender();
      });
    });
  }

  // ----- Build chart cards once; render() will refresh them per filter ----
  $charts.replaceChildren();
  const cards = SERIES.map(s => ({ series: s, ...buildChartCard($charts, { series: s }) }));

  // Manifest "as of" line.
  if (manifest?.lastUpdated && $asOf) {
    const d = new Date(manifest.lastUpdated);
    $asOf.textContent = manifest.cmhcMaxYear
      ? `${manifest.cmhcMaxYear} (refreshed ${d.toISOString().slice(0,10)})`
      : d.toISOString().slice(0,10);
  }

  // ----- Render --------------------------------------------------------------
  let pendingRender = null;
  function scheduleRender() {
    if (pendingRender) clearTimeout(pendingRender);
    pendingRender = setTimeout(() => { pendingRender = null; render(); }, 120);
  }

  // Holds the last successful render's tables for the Excel exporter.
  let lastExport = null;

  async function render() {
    $tables.replaceChildren();
    if (!state.geoUid) {
      $empty.hidden = false; $empty.classList.remove('hidden');
      cards.forEach(c => c.render(null, ''));
      lastExport = null;
      return;
    }

    const shard = await loadStartsShard(state.geoLevel, state.geoUid);
    if (!shard) {
      $empty.hidden = false; $empty.classList.remove('hidden');
      cards.forEach(c => c.render(null, ''));
      lastExport = null;
      return;
    }

    const yearFrom = state.yearFrom ?? Math.max((manifest?.cmhcMaxYear ?? new Date().getFullYear()) - 5, 1990);
    const yearTo   = state.yearTo   ?? (manifest?.cmhcMaxYear ?? new Date().getFullYear());
    const hidden   = new Set(state.hiddenCategories[state.breakdown] || []);

    const builtTables = [];
    let anyData = false;

    for (const card of cards) {
      const matching = (shard.records || []).filter(r =>
        r.series === card.series &&
        r.dimension === state.breakdown &&
        r.frequency === state.frequency &&
        r.year >= yearFrom && r.year <= yearTo &&
        !hidden.has(r.category)
      );
      if (matching.length) anyData = true;

      // For quarterly view, encode (year + quarter) as a fractional year so
      // the x-axis spreads quarters evenly along the year-tick range.
      // chart.js's summariseCaption floors fractional years, so the caption
      // still reads as integer years.
      const enriched = matching.map(r => {
        const q = r.quarter ? Number(r.quarter) : null;
        const xYear = state.frequency === 'Quarterly' && q
          ? Number(r.year) + (q - 1) / 4
          : Number(r.year);
        return { ...r, year: xYear };
      });
      const sub = `${LEVEL_LABEL[shard.geoLevel] || shard.geoLevel}: ${shard.geoName} — ${state.frequency}, by ${state.breakdown}`;

      // Caption: Median / Average of the aggregate ("All") line over the
      // displayed periods. Computed from `matching` so it tracks the active
      // year range and respects the category toggles (blank when "All" is
      // hidden or absent), matching the per-column summary rows in the table.
      const aggVals = matching
        .filter(r => r.category === 'All')
        .map(r => Number(r.value))
        .filter(Number.isFinite);
      const med = median(aggVals), avg = average(aggVals);
      const captionLeft = (med != null && avg != null)
        ? `Median ${Math.round(med).toLocaleString()} · Average ${Math.round(avg).toLocaleString()} (All)`
        : '';
      card.render(enriched, sub, CATEGORY_ORDER[state.breakdown] || [], { season: '', captionLeft });

      // Build a data table for this series: rows = periods, cols = categories.
      builtTables.push(buildSeriesTable(card.series, matching, state.breakdown, state.frequency));
    }

    builtTables.forEach(t => renderTable(t, $tables));

    $empty.hidden = anyData; $empty.classList.toggle('hidden', anyData);
    lastExport = builtTables;

    // Refresh category toggles with the categories actually present.
    const presentCats = new Set();
    (shard.records || [])
      .filter(r => r.dimension === state.breakdown && r.frequency === state.frequency)
      .forEach(r => presentCats.add(r.category));
    const canonical = CATEGORY_ORDER[state.breakdown] || [];
    const ordered = canonical.filter(c => presentCats.has(c))
      .concat([...presentCats].filter(c => !canonical.includes(c)));
    renderCategoryToggles(ordered);

    updateZoneBanner();
  }

  // Pivot: build a flat table {title, columns, rows[{period, values[]}]}
  function buildSeriesTable(seriesName, rows, dim, freq) {
    const canonical = CATEGORY_ORDER[dim] || [];
    const present = [...new Set(rows.map(r => r.category))];
    const cols = canonical.filter(c => present.includes(c))
      .concat(present.filter(c => !canonical.includes(c)));

    // Period rows: sort descending so the most recent year/quarter is first.
    // Period keys are fixed-width ("YYYY" / "YYYY Qn"), so a reverse string
    // sort orders them correctly newest-to-oldest.
    const periods = [...new Set(rows.map(r => periodKey(r, freq)))]
      .sort((a, b) => b.localeCompare(a));
    const matrix = new Map();
    rows.forEach(r => {
      const p = periodKey(r, freq);
      if (!matrix.has(p)) matrix.set(p, new Map());
      matrix.get(p).set(r.category, r.value);
    });

    const tableRows = periods.map(p => ({
      period: p,
      kind: 'data',
      values: cols.map(c => matrix.get(p)?.get(c) ?? null),
    }));

    // Summary rows after the years: per-column Median and Average over the
    // displayed periods (counts → rounded to whole units).
    const summarise = (fn) => cols.map((_, ci) => {
      const vals = tableRows.map(r => r.values[ci]).map(Number).filter(Number.isFinite);
      const out = fn(vals);
      return out == null ? null : Math.round(out);
    });
    const medianRow  = { period: 'Median',  kind: 'summary', summaryFirst: true, values: summarise(median) };
    const averageRow = { period: 'Average', kind: 'summary', values: summarise(average) };

    return { title: seriesName, columns: cols, rows: [...tableRows, medianRow, averageRow] };
  }

  function periodKey(r, freq) {
    if (freq === 'Quarterly' && r.quarter) return `${r.year} Q${r.quarter}`;
    return String(r.year);
  }

  function renderTable(table, container) {
    const block = document.createElement('section');
    block.className = 'cmhc-table-block';
    const title = document.createElement('div');
    title.className = 'cmhc-table-title';
    title.textContent = table.title;
    block.appendChild(title);

    const tbl = document.createElement('table');
    tbl.className = 'cmhc-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const blank = document.createElement('th'); blank.textContent = 'Period';
    trh.appendChild(blank);
    table.columns.forEach(c => {
      const th = document.createElement('th'); th.textContent = c; trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.rows.forEach(r => {
      const tr = document.createElement('tr');
      if (r.kind === 'summary') {
        tr.classList.add('cmhc-table-summary');
        if (r.summaryFirst) tr.classList.add('cmhc-table-summary-top');
      }
      const td0 = document.createElement('td'); td0.textContent = r.period;
      tr.appendChild(td0);
      r.values.forEach(v => {
        const td = document.createElement('td');
        if (v == null || !Number.isFinite(Number(v))) { td.textContent = '**'; td.classList.add('cmhc-table-na'); }
        else td.textContent = Number(v).toLocaleString();
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    block.appendChild(tbl);
    container.appendChild(block);
  }

  // ----- Excel export --------------------------------------------------------
  $dl.addEventListener('click', async () => {
    if (!lastExport || lastExport.length === 0) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    const stamped = lastExport.map(t => ({
      ...t,
      // The excel-export helper expects each row to have {area, values}.
      // Adapt by re-mapping period → area.
      rows: t.rows.map(r => ({ area: r.period, values: r.values.map(v => v == null ? null : Number(v).toLocaleString()) })),
      dwellingSuffix: ` — ${state.frequency}, ${state.breakdown}`,
    }));
    const filename = `CMHC_HousingStarts_${state.frequency}_${new Date().toISOString().slice(0,10)}.xlsx`;
    await exportTablesToExcel(stamped, { filename, maxYear: manifest?.cmhcMaxYear ?? new Date().getFullYear() });
  });

  // ----- Event wiring --------------------------------------------------------
  $level.addEventListener('change', () => {
    state.geoLevel = $level.value;
    populateNames();
    state.geoUid = $name.value;
    if (state.geoLevel === 'province') rememberProvince(state.geoUid);
    scheduleRender();
  });
  $name.addEventListener('change',  () => {
    state.geoUid = $name.value;
    if (state.geoLevel === 'province') rememberProvince(state.geoUid);
    scheduleRender();
  });
  $freq.forEach(n => n.addEventListener('change', () => { if (n.checked) { state.frequency = n.value; scheduleRender(); } }));
  $bd  .forEach(n => n.addEventListener('change', () => { if (n.checked) { state.breakdown = n.value; renderCategoryToggles(); scheduleRender(); } }));
  $yFrom.addEventListener('change', () => { const v = parseInt($yFrom.value, 10); state.yearFrom = Number.isFinite(v) ? v : null; scheduleRender(); });
  $yTo  .addEventListener('change', () => { const v = parseInt($yTo.value, 10);   state.yearTo   = Number.isFinite(v) ? v : null; scheduleRender(); });

  // Initial setup
  populateNames();
  if (state.geoUid) $name.value = state.geoUid;   // reflect the Manitoba default in the dropdown
  renderCategoryToggles();
  render();
}

// --- Summary stats (used by the chart caption + table summary rows) ---------
function median(nums) {
  const a = nums.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function average(nums) {
  const a = nums.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}
