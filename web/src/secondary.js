/*
 * Secondary Rental Market view — Srms (condo + other secondary rental) data
 * loaded from web/public/data/secondary.json. CMHC only publishes Srms for the
 * larger centres — currently Winnipeg (MB) plus Regina + Saskatoon (SK) — so
 * the sidebar has a Province → Centre picker (default Manitoba / Winnipeg) that
 * filters the records, then year range + per-dimension category toggles.
 *
 * Layout mirrors Housing Starts:
 *   - 5 chart cards (one per series) reusing buildChartCard from chart.js
 *   - 5 data tables below (rows = year, cols = category)
 *   - Excel (data) button + Word/Excel (charts) buttons wired from main.js
 */

import { buildChartCard } from './chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { escapeHtml } from './escape.js';

// Series we show, grouped by which dimension CMHC publishes them under.
// Two of them — Condo Vacancy Rate and Condo Average Rent — are commonly
// pulled into appraisal reports; the others are listed for context.
const SERIES_DEFS = [
  { name: 'Condo Vacancy Rate',              dim: 'Structure Size' },
  { name: 'Condo Average Rent',              dim: 'Bedroom Type'   },
  { name: 'Percentage Condo used as Rental', dim: 'Structure Size' },
  { name: 'Rental Condo Universe',           dim: 'Structure Size' },
  { name: 'Condo Universe',                  dim: 'Structure Size' },
];

const CATEGORY_ORDER = {
  'Bedroom Type':   ['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom +', 'Total'],
  // Srms uses "3-19 Units" instead of the Rms "3-5"+"6-19" split, so this
  // list is intentionally Srms-specific.
  'Structure Size': ['3-19 Units', '20-49 Units', '50-99 Units', '100+ Units', 'Total'],
};

const FMT = {
  'Condo Vacancy Rate':              (v) => `${Number(v).toFixed(1)}%`,
  'Condo Average Rent':              (v) => `$${Math.round(Number(v)).toLocaleString()}`,
  'Percentage Condo used as Rental': (v) => `${Number(v).toFixed(1)}%`,
  'Rental Condo Universe':           (v) => Number(v).toLocaleString(),
  'Condo Universe':                  (v) => Number(v).toLocaleString(),
};

export async function initSecondary({ manifest }) {
  const payload = await fetch('./data/secondary.json')
    .then(r => r.ok ? r.json() : { records: [] })
    .catch(() => ({ records: [] }));
  const records = Array.isArray(payload.records) ? payload.records : [];

  const $yFrom    = document.getElementById('sr-year-from');
  const $yTo      = document.getElementById('sr-year-to');
  const $catBed   = document.getElementById('sr-cat-bedroom');
  const $catSize  = document.getElementById('sr-cat-size');
  const $empty    = document.getElementById('sr-empty');
  const $charts   = document.getElementById('sr-chart-grid');
  const $tables   = document.getElementById('sr-table-grid');
  const $dl       = document.getElementById('sr-download-xlsx');
  const $asOf     = document.getElementById('sr-data-as-of');
  const $province = document.getElementById('sr-province');
  const $centre   = document.getElementById('sr-centre');

  if (!records.length) {
    if ($empty) {
      $empty.hidden = false;
      $empty.classList.remove('hidden');
      $empty.textContent = 'No Secondary Rental Market data available.';
    }
    return;
  }

  // --- Province → Centre geography index, built from whatever the Srms scrape
  // returned (currently Winnipeg in MB; Regina + Saskatoon in SK). prov/provName
  // are carried on every record by r/06; new centres appear here automatically.
  const MB_UID         = '46';                          // Manitoba — pinned first / default
  const DEFAULT_CENTRE = { '46': '602', '47': '725' };  // Winnipeg / Saskatoon
  // Province persistence is shared across tabs via prefs.js (falls back to MB).
  const provNames      = new Map();
  const centresByProv  = new Map();                     // prov uid → Map(geoUid → name)
  for (const r of records) {
    if (r.geoLevel === 'province') continue;            // skip any province-level aggregate
    const p = String(r.prov ?? '46');
    provNames.set(p, r.provName || p);
    if (!centresByProv.has(p)) centresByProv.set(p, new Map());
    centresByProv.get(p).set(String(r.geoUid), r.geoName);
  }
  // Provinces with Srms data, listed alphabetically by name (Manitoba is merely
  // the pre-selected default below, not pinned to the top of the list).
  const provs = [...centresByProv.keys()]
    .sort((a, b) => (provNames.get(a) || a).localeCompare(provNames.get(b) || b));
  const centresFor = (p) => [...(centresByProv.get(p)?.entries() || [])]
    .map(([uid, name]) => ({ uid, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pickDefaultCentre = (p) => {
    const list = centresFor(p), pref = DEFAULT_CENTRE[p];
    return (pref && list.some(c => c.uid === pref) ? pref : list[0]?.uid) || '';
  };

  // Year range — start with the last 10 years by default.
  const years = records.map(r => Number(r.year)).filter(Number.isFinite);
  const yMin = Math.min(...years), yMax = Math.max(...years);

  const state = {
    prov:     resolveProvince(provs, provs.includes(MB_UID) ? MB_UID : provs[0]),
    centre:   '',
    yearFrom: Math.max(yMin, yMax - 9),
    yearTo:   yMax,
    hidden: { 'Bedroom Type': new Set(), 'Structure Size': new Set() },
  };
  state.centre = pickDefaultCentre(state.prov);

  function populateProvinces() {
    $province.innerHTML = provs.map(p =>
      `<option value="${escapeHtml(p)}">${escapeHtml(provNames.get(p) || p)}</option>`).join('');
    $province.value = state.prov;
  }
  function populateCentres() {
    $centre.innerHTML = centresFor(state.prov).map(c =>
      `<option value="${escapeHtml(c.uid)}">${escapeHtml(c.name)}</option>`).join('');
    $centre.value = state.centre;
  }
  populateProvinces();
  populateCentres();
  $yFrom.min = yMin; $yFrom.max = yMax; $yFrom.value = state.yearFrom;
  $yTo  .min = yMin; $yTo  .max = yMax; $yTo  .value = state.yearTo;

  // Footer "as of" — Srms is annual, refresh date comes from manifest.
  if ($asOf && manifest?.lastUpdated) {
    const d = new Date(manifest.lastUpdated);
    $asOf.textContent = `${yMax} (refreshed ${d.toISOString().slice(0,10)})`;
  }

  // Category toggle groups — one per dimension because Bedroom Type and
  // Structure Size don't share categories.
  function renderCatToggles($box, dim, presentCats) {
    const ordered = orderedCategories(dim, presentCats);
    $box.innerHTML = ordered.map(cat => `
      <label class="flex items-center gap-1">
        <input type="checkbox" data-cat="${escapeHtml(cat)}" checked />
        <span>${escapeHtml(cat)}</span>
      </label>
    `).join('');
    $box.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cat = cb.dataset.cat;
        if (cb.checked) state.hidden[dim].delete(cat);
        else            state.hidden[dim].add(cat);
        scheduleRender();
      });
    });
  }

  // Pre-compute the categories actually present per dimension so the toggle
  // box doesn't show options that have no data.
  const presentBedroom = new Set(
    records.filter(r => r.dimension === 'Bedroom Type').map(r => r.category));
  const presentSize = new Set(
    records.filter(r => r.dimension === 'Structure Size').map(r => r.category));
  renderCatToggles($catBed,  'Bedroom Type',   presentBedroom);
  renderCatToggles($catSize, 'Structure Size', presentSize);

  // Build chart cards once.
  $charts.replaceChildren();
  const cards = SERIES_DEFS.map(def =>
    ({ ...def, ...buildChartCard($charts, { series: def.name }) }));

  let pendingRender = null;
  function scheduleRender() {
    if (pendingRender) clearTimeout(pendingRender);
    pendingRender = setTimeout(() => { pendingRender = null; render(); }, 120);
  }

  let lastExport = null;

  function render() {
    $tables.replaceChildren();
    let anyData = false;
    const built = [];
    const geoLabel = centresByProv.get(state.prov)?.get(state.centre) || 'Selected centre';

    for (const card of cards) {
      const hiddenSet = state.hidden[card.dim];
      const matching = records.filter(r =>
        String(r.geoUid) === state.centre &&
        r.series === card.name &&
        r.dimension === card.dim &&
        Number(r.year) >= state.yearFrom &&
        Number(r.year) <= state.yearTo &&
        !hiddenSet.has(r.category));
      if (matching.length) anyData = true;

      const sub = `${geoLabel} — Annual, by ${card.dim}`;
      // chart.js's `dwellingType` isn't present on Srms rows; the renderer
      // doesn't read it, so passing the records as-is is fine.
      card.render(matching, sub, CATEGORY_ORDER[card.dim] || [], {});

      built.push(buildSeriesTable(card.name, card.dim, matching));
    }
    built.forEach(t => renderTable(t, $tables));
    $empty.hidden = anyData;
    $empty.classList.toggle('hidden', anyData);
    lastExport = built;
  }

  function buildSeriesTable(seriesName, dim, rows) {
    const present = [...new Set(rows.map(r => r.category))];
    const cols = orderedCategories(dim, new Set(present));
    const periods = [...new Set(rows.map(r => Number(r.year)))].sort((a, b) => a - b);
    const matrix = new Map();
    rows.forEach(r => {
      const y = Number(r.year);
      if (!matrix.has(y)) matrix.set(y, new Map());
      matrix.get(y).set(r.category, r.value);
    });
    const fmt = FMT[seriesName] || ((v) => String(v));
    return {
      title: seriesName,
      dimension: dim,
      columns: cols,
      rows: periods.map(p => ({
        period: p,
        rawValues: cols.map(c => matrix.get(p)?.get(c) ?? null),
        values:    cols.map(c => {
          const v = matrix.get(p)?.get(c);
          return (v == null || !Number.isFinite(Number(v))) ? null : fmt(v);   // null/NaN → "**" downstream
        }),
      })),
    };
  }

  function renderTable(table, container) {
    const block = document.createElement('section');
    block.className = 'cmhc-table-block';
    const title = document.createElement('div');
    title.className = 'cmhc-table-title';
    title.textContent = `${table.title} — by ${table.dimension}`;
    block.appendChild(title);

    const tbl = document.createElement('table');
    tbl.className = 'cmhc-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const blank = document.createElement('th'); blank.textContent = 'Year';
    trh.appendChild(blank);
    table.columns.forEach(c => {
      const th = document.createElement('th'); th.textContent = c; trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.rows.forEach(r => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = r.period;
      tr.appendChild(td0);
      r.values.forEach(v => {
        const td = document.createElement('td');
        if (v == null) { td.textContent = '**'; td.classList.add('cmhc-table-na'); }
        else td.textContent = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    block.appendChild(tbl);
    container.appendChild(block);
  }

  // ----- Excel export (data) -------------------------------------------------
  $dl.addEventListener('click', async () => {
    if (!lastExport || lastExport.length === 0) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    // exportTablesToExcel expects rows shaped {area, values}; adapt period→area.
    const stamped = lastExport.map(t => ({
      ...t,
      rows: t.rows.map(r => ({ area: String(r.period), values: r.values })),
      dwellingSuffix: ` — by ${t.dimension}`,
    }));
    const centreTag = (centresByProv.get(state.prov)?.get(state.centre) || 'Centre').replace(/\s+/g, '');
    const filename = `CMHC_SecondaryRental_${centreTag}_${new Date().toISOString().slice(0,10)}.xlsx`;
    await exportTablesToExcel(stamped, {
      filename, maxYear: manifest?.cmhcMaxYear ?? new Date().getFullYear(),
    });
  });

  // ----- Event wiring --------------------------------------------------------
  $province.addEventListener('change', () => {
    state.prov = $province.value;
    rememberProvince(state.prov);                   // remember for next visit (shared across tabs)
    state.centre = pickDefaultCentre(state.prov);   // default centre per province
    populateCentres();
    scheduleRender();
  });
  $centre.addEventListener('change', () => {
    state.centre = $centre.value;
    scheduleRender();
  });
  $yFrom.addEventListener('change', () => {
    const v = parseInt($yFrom.value, 10);
    if (Number.isFinite(v)) { state.yearFrom = v; scheduleRender(); }
  });
  $yTo.addEventListener('change', () => {
    const v = parseInt($yTo.value, 10);
    if (Number.isFinite(v)) { state.yearTo = v; scheduleRender(); }
  });

  render();
}

function orderedCategories(dim, presentSet) {
  const canonical = CATEGORY_ORDER[dim] || [];
  return canonical.filter(c => presentSet.has(c))
    .concat([...presentSet].filter(c => !canonical.includes(c)));
}
