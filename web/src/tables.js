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

import { exportTablesToExcel } from './excel-export.js';

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
 * Render one table block (title bar + HTML table) into a container.
 */
function renderTable(table, dwellingSuffix, container) {
  const block = document.createElement('section');
  block.className = 'cmhc-table-block';
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
  container.appendChild(block);
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
  const $second   = document.getElementById('tbl-second-area');
  const $third    = document.getElementById('tbl-third-area');
  const $fourth   = document.getElementById('tbl-fourth-area');
  const $mode     = document.querySelectorAll('input[name="tblDwellingMode"]');
  const $tables   = document.querySelectorAll('#tbl-tables input[type=checkbox]');
  const $download = document.getElementById('tbl-download-xlsx');
  const $output   = document.getElementById('tbl-output');
  const $empty    = document.getElementById('tbl-empty');
  const $vintage  = document.getElementById('tbl-vintage');
  const $asOf     = document.getElementById('tbl-data-as-of');

  // Build a flat option list across CMA + survey zones (matches the original
  // tool's "Third Area" dropdown which mixed centres and zones).
  const levels = geographies.levels || {};
  const buildOptions = (placeholder = null) => {
    const parts = [];
    if (placeholder !== null) parts.push(`<option value="">${placeholder}</option>`);
    if (Array.isArray(levels.cma)) {
      parts.push('<optgroup label="Manitoba Centres">');
      levels.cma.forEach(it => {
        parts.push(`<option value="cma:${it.uid}">${escapeHtml(it.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (Array.isArray(levels.csd) && levels.csd.length) {
      parts.push('<optgroup label="Census Subdivisions">');
      levels.csd.forEach(it => {
        parts.push(`<option value="csd:${it.uid}">${escapeHtml(it.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (Array.isArray(levels.zone) && levels.zone.length) {
      parts.push('<optgroup label="Winnipeg Survey Zones">');
      levels.zone.forEach(it => {
        parts.push(`<option value="zone:${it.uid}">${escapeHtml(it.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (Array.isArray(levels.neighbourhood) && levels.neighbourhood.length) {
      parts.push('<optgroup label="Winnipeg Neighbourhoods">');
      levels.neighbourhood.forEach(it => {
        parts.push(`<option value="neighbourhood:${it.uid}">${escapeHtml(it.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    return parts.join('');
  };

  $second.innerHTML = buildOptions();
  $third.innerHTML  = buildOptions();
  $fourth.innerHTML = buildOptions('— None —');
  // Sensible defaults: second = Winnipeg, third = Brandon (typical pair).
  const winnipegCma = (levels.cma || []).find(it => it.name === 'Winnipeg');
  const brandonCma  = (levels.cma || []).find(it => it.name === 'Brandon');
  if (winnipegCma) $second.value = `cma:${winnipegCma.uid}`;
  if (brandonCma)  $third.value  = `cma:${brandonCma.uid}`;

  // Vintage label.
  const maxYear = manifest?.cmhcMaxYear ?? new Date().getFullYear();
  $vintage.textContent = `Primary Rental Market — ${maxYear} October`;
  if ($asOf && manifest?.lastUpdated) {
    $asOf.textContent = `${maxYear} (refreshed ${new Date(manifest.lastUpdated).toISOString().slice(0,10)})`;
  }

  // Always show Manitoba first.
  const manitobaItem = (levels.province || []).find(it => it.name === 'Manitoba') || levels.province?.[0];

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
    return [...$tables].filter(n => n.checked).map(n => n.value);
  }

  let lastRenderState = null;

  async function render() {
    $output.replaceChildren();
    const { second, third, fourth } = pickedAreas();
    const tableIds = pickedTables();
    if (!third || tableIds.length === 0) {
      $empty.hidden = false;
      $empty.textContent = !third
        ? 'Select a Third area to begin.'
        : 'Tick at least one table on the left.';
      lastRenderState = null;
      return;
    }
    $empty.hidden = true;

    const areas = [
      manitobaItem && { name: manitobaItem.name, level: 'province', uid: manitobaItem.uid },
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
        renderTable(table, pass.suffix, $output);
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
  [...$mode, ...$tables, $second, $third, $fourth].forEach(el => {
    el.addEventListener('change', scheduleRender);
  });

  $download.addEventListener('click', async () => {
    if (!lastRenderState || !lastRenderState.built.length) return;
    const filename = `CMHC_Tables_${lastRenderState.maxYear}_${new Date().toISOString().slice(0,10)}.xlsx`;
    await exportTablesToExcel(lastRenderState.built, { filename, maxYear: lastRenderState.maxYear });
  });

  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
