/*
 * Comparison-tables view.
 *
 * Builds wide pivot tables matching the existing R-based CMHC-VacancyMedianRents
 * tool: Manitoba is always the first row, then a second comparison area
 * (Winnipeg by default but selectable), then the user's third area, then an
 * optional fourth. Each enabled table is built for one or more dwelling-type
 * passes (All / + Apartments / + Row) and rendered as HTML; the same rows can
 * be exported as a styled .xlsx via excel-export.js.
 *
 * Data source: the cached JSON shards under web/public/data/series/ — we hit
 * the most recent year + October season for each geography to match CMHC's
 * canonical RMS reporting cadence.
 */

// ExcelJS is heavy (~940KB minified) — load it on demand when the user clicks
// Download, not on tab init. Matches the lazy-import pattern in starts.js and
// indicators.js so the vendor chunk stays lean.

import { buildBarCard } from './chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { escapeHtml } from './escape.js';

// Table definitions — series + dimension pair + display label.
const TABLE_DEFS = {
  vacancy_bedroom: { label: 'Vacancy Rate by Bedroom Type',  series: 'Vacancy Rate', dimension: 'Bedroom Type',         seriesType: 'vacancy' },
  vacancy_rent:    { label: 'Vacancy Rate by Rent Range',    series: 'Vacancy Rate', dimension: 'Rent Ranges',          seriesType: 'vacancy' },
  vacancy_year:    { label: 'Vacancy Rate by Year Built',    series: 'Vacancy Rate', dimension: 'Year of Construction', seriesType: 'vacancy' },
  rent_bedroom:    { label: 'Median Rent by Bedroom Type',   series: 'Median Rent',  dimension: 'Bedroom Type',         seriesType: 'rent'    },
  rent_year:       { label: 'Median Rent by Year Built',     series: 'Median Rent',  dimension: 'Year of Construction', seriesType: 'rent'    },
};

// Column ordering + short header labels per dimension. Matches CMHC's
// canonical category order plus a "Total" tail.
const CATEGORY_COLUMNS = {
  'Bedroom Type':         [['Studio','Bachelor'],   ['1 Bedroom','1-BR'],
                           ['2 Bedroom','2-BR'],    ['3 Bedroom +','3-BR+'],
                           ['Total','Overall']],
  'Rent Ranges':          [['Less Than $750','<$750'],
                           ['$750 - $999','$750-999'],
                           ['$1,000 - $1,249','$1,000-1,249'],
                           ['$1,250 - $1,499','$1,250-1,499'],
                           ['$1,500 +','$1,500+']],
  'Year of Construction': [['Before 1960','<1960'],
                           ['1960 - 1979','1960-1979'],
                           ['1980 - 1999','1980-1999'],
                           ['2000 or Later','2000+']],
};

// Dwelling-mode → list of (filter, suffix) passes.
function dwellingPasses(mode) {
  const all = { filter: 'All', suffix: '' };
  switch (mode) {
    case 'all_apt':     return [all, { filter: 'Apartment', suffix: ' — Apartments Only' }];
    case 'all_row':     return [all, { filter: 'Row',       suffix: ' — Row Only' }];
    case 'all_apt_row': return [all,
                                { filter: 'Apartment', suffix: ' — Apartments Only' },
                                { filter: 'Row',       suffix: ' — Row Only' }];
    default:            return [all];
  }
}

function fmtValue(v, seriesType) {
  if (v == null || !Number.isFinite(v)) return null;
  if (seriesType === 'vacancy') return `${Number(v).toFixed(1)}%`;
  return `$${Math.round(Number(v)).toLocaleString()}`;
}

/**
 * Build one comparison table.
 * @param {Array} geoShards  array of { geoName, records }, in the order they
 *                            should appear as rows.
 * @param {Object} def        TABLE_DEFS entry
 * @param {string} dwelling   'All' | 'Apartment' | 'Row'
 * @param {number} maxYear    target year (CMHC's most recent reporting year)
 * @param {string} season     'October' (default)
 * @returns {Object} { columns, rows, title, seriesType }
 */
function buildTable({ geoShards, def, dwelling, maxYear, season }) {
  const cols = CATEGORY_COLUMNS[def.dimension] || [];
  const headerLabels = cols.map(([_, short]) => short);
  const rows = geoShards.map(g => {
    const matched = (g.records || []).filter(r =>
      r.series === def.series &&
      r.dimension === def.dimension &&
      r.dwellingType === dwelling &&
      r.year === maxYear &&
      (r.season === season || !r.season));
    const byCat = new Map(matched.map(r => [r.category, r.value]));
    return {
      area: g.geoName,
      values: cols.map(([cat]) => fmtValue(byCat.get(cat), def.seriesType)),
      raw:    cols.map(([cat]) => byCat.get(cat) ?? null),
    };
  });
  return {
    title:      def.label,
    seriesType: def.seriesType,
    columns:    headerLabels,
    rows,
  };
}

/**
 * Render one table row: a Rental-Charts-style grouped-bar chart CARD (its own
 * object — title, subtitle, plot + right legend, caption, Download PNG) on the
 * left, and the HTML table as a separate object on the right.
 */
function renderTable(table, dwellingSuffix, container, sub) {
  const row = document.createElement('div');
  row.className = 'grid md:grid-cols-2 gap-4 items-start';

  // Chart card (separate object, left).
  const chartCell = document.createElement('div');
  chartCell.className = 'min-w-0';
  const data = [];
  table.rows.forEach(r => table.columns.forEach((cat, i) => {
    const v = r.raw?.[i];
    if (v != null && Number.isFinite(v)) data.push({ area: r.area, cat, value: v });
  }));
  const { render: renderBar } = buildBarCard(chartCell, { title: `${table.title}${dwellingSuffix}` });
  renderBar({ data, categories: table.columns, areas: table.rows.map(r => r.area),
              seriesType: table.seriesType, sub });
  row.appendChild(chartCell);

  // Table (separate object, right).
  const block = document.createElement('section');
  block.className = 'cmhc-table-block min-w-0 overflow-x-auto';
  const titleEl = document.createElement('div');
  titleEl.className = 'cmhc-table-title';
  titleEl.textContent = `${table.title}${dwellingSuffix}`;
  block.appendChild(titleEl);

  const tbl = document.createElement('table');
  tbl.className = 'cmhc-table';
  const thead = document.createElement('thead');
  const trh   = document.createElement('tr');
  const blank = document.createElement('th'); blank.textContent = '';
  trh.appendChild(blank);
  table.columns.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.rows.forEach(r => {
    const tr = document.createElement('tr');
    const areaTd = document.createElement('td');
    areaTd.textContent = r.area;
    tr.appendChild(areaTd);
    r.values.forEach(v => {
      const td = document.createElement('td');
      if (v == null) {
        td.textContent = '**';
        td.classList.add('cmhc-table-na');
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  block.appendChild(tbl);

  row.appendChild(block);
  container.appendChild(row);
}

/**
 * Initialize the comparison-tables view.
 *
 * @param {Object} opts
 * @param {Object} opts.geographies   geographies.json payload
 * @param {Object} opts.manifest      manifest.json payload
 * @param {Function} opts.loadShard   (level, uid) => Promise<shard JSON>
 */
export function initTables({ geographies, manifest, loadShard }) {
  const $province = document.getElementById('tbl-province');
  const $second   = document.getElementById('tbl-second-area');
  const $third    = document.getElementById('tbl-third-area');
  const $fourth   = document.getElementById('tbl-fourth-area');
  const $mode     = document.querySelectorAll('input[name="tblDwellingMode"]');
  const $download = document.getElementById('tbl-download-xlsx');
  const $copy     = document.getElementById('tbl-copy-clipboard');
  const $docx     = document.getElementById('tbl-download-docx');
  const $output   = document.getElementById('tbl-output');
  const $empty    = document.getElementById('tbl-empty');
  const $vintage  = document.getElementById('tbl-vintage');
  const $asOf     = document.getElementById('tbl-data-as-of');

  const levels = geographies.levels || {};
  const provinceItems = (levels.province || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  // Option list scoped to one province (its `prov` code). The second–fourth
  // areas are centres/zones WITHIN the selected province — no cross-province
  // comparison.
  const buildOptions = (provUid, placeholder = null) => {
    const parts = [];
    if (placeholder !== null) parts.push(`<option value="">${placeholder}</option>`);
    const grp = (label, level) => {
      const arr = (levels[level] || []).filter(it => it.prov === provUid);
      if (!arr.length) return;
      parts.push(`<optgroup label="${escapeHtml(label)}">`);
      arr.forEach(it => parts.push(`<option value="${level}:${it.uid}">${escapeHtml(it.name)}</option>`));
      parts.push('</optgroup>');
    };
    grp('Centres (CMA / CA)', 'cma');
    grp('Census Subdivisions', 'csd');
    grp('Survey Zones', 'zone');
    grp('Neighbourhoods', 'neighbourhood');
    return parts.join('');
  };

  // Province dropdown — the first row + the scope for the other areas.
  $province.innerHTML = provinceItems.map(it => `<option value="${escapeHtml(it.prov)}">${escapeHtml(it.name)}</option>`).join('');
  const provCodes = provinceItems.map(it => it.prov);
  $province.value = resolveProvince(provCodes, provCodes.includes('46') ? '46' : (provCodes[0] || ''));
  const currentProvinceItem = () => provinceItems.find(it => it.prov === $province.value) || provinceItems[0];

  function populateAreaDropdowns() {
    const prov = $province.value;
    $second.innerHTML = buildOptions(prov);
    $third.innerHTML  = buildOptions(prov);
    $fourth.innerHTML = buildOptions(prov, '— None —');
    // Defaults: Manitoba → Winnipeg + Brandon (the familiar pair); otherwise the
    // first two centres in the province.
    const cmas = (levels.cma || []).filter(it => it.prov === prov);
    let second = prov === '46' ? cmas.find(c => c.name === 'Winnipeg') : null;
    let third  = prov === '46' ? cmas.find(c => c.name === 'Brandon')  : null;
    second = second || cmas[0];
    third  = third  || cmas[1];
    $second.value = second ? `cma:${second.uid}` : '';
    $third.value  = third  ? `cma:${third.uid}`  : '';
    $fourth.value = '';
  }
  populateAreaDropdowns();

  // Vintage label.
  const maxYear = manifest?.cmhcMaxYear ?? new Date().getFullYear();
  $vintage.textContent = `Primary Rental Market — ${maxYear} October`;
  if ($asOf && manifest?.lastUpdated) {
    $asOf.textContent = `${maxYear} (refreshed ${new Date(manifest.lastUpdated).toISOString().slice(0,10)})`;
  }

  function pickedAreas() {
    const parsed = (v) => {
      if (!v) return null;
      const idx = v.indexOf(':');
      return { level: v.slice(0, idx), uid: v.slice(idx + 1) };
    };
    const second = parsed($second.value);
    const third  = parsed($third.value);
    const fourth = parsed($fourth.value);
    return { second, third, fourth };
  }

  function pickedMode() {
    return [...$mode].find(n => n.checked)?.value || 'all_only';
  }

  function pickedTables() {
    return Object.keys(TABLE_DEFS);   // always all tables
  }

  let lastRenderState = null;

  async function render() {
    $output.replaceChildren();
    const { second, third, fourth } = pickedAreas();
    const tableIds = pickedTables();
    if (!third) {
      $empty.hidden = false;
      $empty.textContent = 'Select a Third area to begin.';
      lastRenderState = null;
      return;
    }
    $empty.hidden = true;

    const provItem = currentProvinceItem();
    const areas = [
      provItem && { name: provItem.name, level: 'province', uid: provItem.uid },
      second && { level: second.level, uid: second.uid, name: lookupName(levels, second) },
      third  && { level: third.level,  uid: third.uid,  name: lookupName(levels, third)  },
      fourth && { level: fourth.level, uid: fourth.uid, name: lookupName(levels, fourth) },
    ].filter(Boolean);

    const geoShards = await Promise.all(areas.map(async (a) => {
      const shard = await loadShard(a.level, a.uid);
      return shard ? { ...shard, geoName: a.name } : null;
    }));
    const validShards = geoShards.filter(Boolean);
    if (validShards.length === 0) {
      $empty.hidden = false;
      $empty.textContent = 'No data shard found for the selected areas.';
      lastRenderState = null;
      return;
    }

    const passes = dwellingPasses(pickedMode());
    const built = [];   // for both rendering AND export
    for (const id of tableIds) {
      const def = TABLE_DEFS[id];
      if (!def) continue;
      for (const pass of passes) {
        const table = buildTable({
          geoShards: validShards,
          def,
          dwelling: pass.filter,
          maxYear,
          season: 'October',
        });
        renderTable(table, pass.suffix, $output, `${provItem.name} — ${maxYear} October`);
        built.push({ ...table, dwellingSuffix: pass.suffix });
      }
    }

    lastRenderState = { areas: validShards.map(s => s.geoName), built, maxYear };
  }

  function lookupName(levels, ref) {
    const arr = levels[ref.level] || [];
    return arr.find(it => it.uid === ref.uid)?.name || ref.uid;
  }

  // Debounce the re-render — rapid changes (e.g. tabbing through dwelling
  // modes, unchecking three tables in a row) used to fire one full rebuild
  // per event, which froze the page when ×3 dwelling passes × 4 areas meant
  // 15+ DOM tables per render. A short debounce coalesces bursts.
  let pendingRender = null;
  function scheduleRender() {
    if (pendingRender) clearTimeout(pendingRender);
    pendingRender = setTimeout(() => { pendingRender = null; render(); }, 120);
  }
  [...$mode, $second, $third, $fourth].forEach(el => {
    el.addEventListener('change', scheduleRender);
  });
  // Changing the province re-scopes the second–fourth dropdowns (and resets
  // their defaults) before re-rendering.
  $province.addEventListener('change', () => { rememberProvince($province.value); populateAreaDropdowns(); scheduleRender(); });

  // Flash a transient status label on an export button, then restore it.
  function flashLabel(btn, label) {
    if (btn.dataset.flashing) return;
    btn.dataset.flashing = '1';
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = original; delete btn.dataset.flashing; }, 2000);
  }

  $download.addEventListener('click', async () => {
    if (!lastRenderState || !lastRenderState.built.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    const filename = `CMHC_Tables_${lastRenderState.maxYear}_${new Date().toISOString().slice(0,10)}.xlsx`;
    await exportTablesToExcel(lastRenderState.built, { filename, maxYear: lastRenderState.maxYear });
  });

  $copy.addEventListener('click', async () => {
    if (!lastRenderState || !lastRenderState.built.length) return;
    const { copyTablesToClipboard } = await import('./clipboard-export.js');
    const status = await copyTablesToClipboard(lastRenderState.built,
      { maxYear: lastRenderState.maxYear });
    flashLabel($copy, {
      success:  'Copied — paste into Word',
      legacy:   'Copied — paste into Word',
      fallback: 'Copied as plain text',
      failed:   'Copy failed',
    }[status] || 'Copy failed');
  });

  $docx.addEventListener('click', async () => {
    if (!lastRenderState || !lastRenderState.built.length) return;
    const { exportTablesToWord } = await import('./word-export.js');
    const filename = `CMHC_Tables_${lastRenderState.maxYear}_${new Date().toISOString().slice(0,10)}.docx`;
    await exportTablesToWord(lastRenderState.built, { filename, maxYear: lastRenderState.maxYear });
  });

  render();
}
