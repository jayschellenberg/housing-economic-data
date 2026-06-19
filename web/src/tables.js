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

import * as Plot from '@observablehq/plot';
import { themed, PALETTE, frameMark } from './plot-theme.js';

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
 * Build a grouped (clustered) bar chart for one table: each breakdown category
 * is a small group of bars, one bar per area — mirroring the area × category
 * table. Returns an SVG node, or null if there are no plottable values.
 */
function buildComparisonChart(table) {
  const areas = table.rows.map(r => r.area);
  const data = [];
  table.rows.forEach(r => table.columns.forEach((cat, i) => {
    const v = r.raw?.[i];
    if (v != null && Number.isFinite(v)) data.push({ area: r.area, cat, value: v });
  }));
  if (!data.length) return null;
  const isVac = table.seriesType === 'vacancy';
  const yFmt = isVac ? (v => `${v}%`) : (v => `$${Number(v).toLocaleString()}`);
  const maxV = Math.max(...data.map(d => d.value));
  return Plot.plot(themed({
    height: 250, marginBottom: 30, marginLeft: 52,
    fx: { label: null, domain: table.columns },
    x: { axis: null, label: null },
    y: { label: isVac ? 'Vacancy (%)' : 'Median Rent ($)', tickFormat: yFmt, domain: [0, maxV * 1.12] },
    color: { domain: areas, range: PALETTE, legend: true },
    marks: [Plot.barY(data, { fx: 'cat', x: 'area', y: 'value', fill: 'area' }), frameMark()],
  }));
}

/**
 * Render one table block: a title bar, then the grouped-bar chart (left) and
 * the HTML table (right) side by side in one row.
 */
function renderTable(table, dwellingSuffix, container) {
  const block = document.createElement('section');
  block.className = 'cmhc-table-block';
  const titleEl = document.createElement('div');
  titleEl.className = 'cmhc-table-title';
  titleEl.textContent = `${table.title}${dwellingSuffix}`;
  block.appendChild(titleEl);

  const row = document.createElement('div');
  row.className = 'grid md:grid-cols-2 gap-4 items-start';

  // Chart (left).
  const chartCell = document.createElement('div');
  chartCell.className = 'min-w-0';
  const svg = buildComparisonChart(table);
  if (svg) {
    const cap = document.createElement('div');
    cap.className = 'text-xs text-neutral-500 text-right mt-1';
    cap.textContent = 'Source: CMHC';
    chartCell.appendChild(svg);
    chartCell.appendChild(cap);
  }

  // Table (right).
  const tableCell = document.createElement('div');
  tableCell.className = 'min-w-0 overflow-x-auto';
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
  tableCell.appendChild(tbl);

  row.appendChild(chartCell);
  row.appendChild(tableCell);
  block.appendChild(row);
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
  const $copy     = document.getElementById('tbl-copy-clipboard');
  const $docx     = document.getElementById('tbl-download-docx');
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
      parts.push('<optgroup label="Centres (CMA / CA)">');
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
      parts.push('<optgroup label="Survey Zones">');
      levels.zone.forEach(it => {
        parts.push(`<option value="zone:${it.uid}">${escapeHtml(it.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (Array.isArray(levels.neighbourhood) && levels.neighbourhood.length) {
      parts.push('<optgroup label="Neighbourhoods">');
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
