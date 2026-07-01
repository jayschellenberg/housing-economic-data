/*
 * Compare Areas view — overlay several areas (within one province) as
 * time-series lines for a fixed breakdown category, with a matching areas ×
 * years table beside each chart. One chart+table pair per metric (Median Rent,
 * Average Rent, Vacancy Rate, Avg Rent Change). The multi-area counterpart to
 * the single-area Rental Charts tab: there you compare categories within one
 * area; here you compare areas for one category.
 *
 * Reuses buildChartCard() — it colours lines by `category`, so feeding it rows
 * whose `category` is the area name draws one line per area, with an area
 * legend, for free. Province-scoped (no cross-province comparison, by design).
 *
 * Data source: the same cached series shards as Rental Charts (loadShard).
 */

import { buildChartCard } from './chart.js';
import { resolveProvince, rememberProvince } from './prefs.js';
import { escapeHtml as esc } from './escape.js';

const METRICS = ['Median Rent', 'Average Rent', 'Vacancy Rate', 'Average Rent Change'];
const AREA_LEVELS = ['province', 'cma', 'csd', 'zone', 'neighbourhood'];
const LEVEL_LABEL = {
  province:      'Entire province',
  cma:           'CMA / CA',
  csd:           'Census Subdivision',
  zone:          'Survey Zone',
  neighbourhood: 'Neighbourhood',
};
const DWELLING_LABEL = { All: 'All Types', Apartment: 'Apartments Only', Row: 'Row Only' };

export function initCompare({ geographies, capabilities, manifest, categoryOrder = {}, loadShard }) {
  const $province  = document.getElementById('cmp-province');
  const $areas     = document.getElementById('cmp-areas');
  const $breakdown = document.querySelectorAll('input[name="cmpBreakdown"]');
  const $category  = document.getElementById('cmp-category');
  const $dwelling  = document.querySelectorAll('input[name="cmpDwelling"]');
  const $yearFrom  = document.getElementById('cmp-year-from');
  const $yearTo    = document.getElementById('cmp-year-to');
  const $output    = document.getElementById('cmp-output');
  const $empty     = document.getElementById('cmp-empty');
  if (!$province || !$output) return;

  const levels = geographies.levels || {};
  const provinceItems = (levels.province || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  $province.innerHTML = provinceItems
    .map(it => `<option value="${esc(it.prov)}">${esc(it.name)}</option>`).join('');
  const provCodes = provinceItems.map(it => it.prov);
  $province.value = resolveProvince(provCodes, provCodes.includes('46') ? '46' : (provCodes[0] || ''));

  const maxYear = manifest?.cmhcMaxYear ?? new Date().getFullYear();
  $yearFrom.value = Math.max(maxYear - 10, 1990);
  $yearTo.value   = maxYear;

  function areasForProvince(prov) {
    const out = [];
    for (const lvl of AREA_LEVELS) {
      (levels[lvl] || []).filter(it => it.prov === prov).forEach(it =>
        out.push({ level: lvl, uid: it.uid, name: it.name, parentName: it.parentName }));
    }
    return out;
  }

  function populateAreas() {
    const areas = areasForProvince($province.value);
    let html = '';
    for (const lvl of AREA_LEVELS) {
      const arr = areas.filter(a => a.level === lvl);
      if (!arr.length) continue;
      html += `<div class="text-xs font-semibold text-neutral-500 mt-1">${esc(LEVEL_LABEL[lvl])}</div>`;
      for (const a of arr) {
        const lbl = a.parentName && (lvl === 'zone' || lvl === 'neighbourhood')
          ? `${a.name} — ${a.parentName}` : a.name;
        html += `<label class="flex items-center gap-1"><input type="checkbox" value="${esc(a.level + ':' + a.uid)}" data-name="${esc(a.name)}" /> ${esc(lbl)}</label>`;
      }
    }
    $areas.innerHTML = html;
    // Default: the first two CMAs (typical "Winnipeg vs Brandon" pairing).
    const checks = [...$areas.querySelectorAll('input[type=checkbox]')];
    const cmas = checks.filter(c => c.value.startsWith('cma:'));
    (cmas.length >= 2 ? cmas.slice(0, 2) : checks.slice(0, 2)).forEach(c => { c.checked = true; });
    checks.forEach(c => c.addEventListener('change', scheduleRender));
  }

  function populateCategory() {
    const cats = categoryOrder[pickedBreakdown()] || [];
    $category.innerHTML = cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $category.value = cats.includes('Total') ? 'Total' : cats[cats.length - 1] || '';
  }

  const pickedBreakdown = () => [...$breakdown].find(n => n.checked)?.value || 'Bedroom Type';
  const pickedDwelling  = () => [...$dwelling].find(n => n.checked)?.value || 'All';
  const pickedAreas = () => [...$areas.querySelectorAll('input:checked')].map(c => {
    const i = c.value.indexOf(':');
    return { level: c.value.slice(0, i), uid: c.value.slice(i + 1), name: c.dataset.name };
  });

  const miss = (v) => v == null || !Number.isFinite(Number(v));   // null / NaN / Infinity → "**" (rendered downstream)
  const fmtFor = (metric) => (metric === 'Vacancy Rate' || metric === 'Average Rent Change')
    ? (v) => (miss(v) ? null : `${Number(v).toFixed(1)}%`)
    : (v) => (miss(v) ? null : `$${Math.round(Number(v)).toLocaleString()}`);
  const dimsFor = (metric) => capabilities?.series?.[metric]?.dimensions || [];

  let lastTables = [];

  async function render() {
    const dim = pickedBreakdown(), cat = $category.value, dwelling = pickedDwelling();
    const yf = parseInt($yearFrom.value, 10) || (maxYear - 10);
    const yt = parseInt($yearTo.value, 10)   || maxYear;
    const areas = pickedAreas();

    if (areas.length < 2) {
      $output.replaceChildren(); lastTables = [];
      $empty.hidden = false; $empty.textContent = 'Pick at least 2 areas to compare.';
      return;
    }
    $empty.hidden = true;

    const shards = (await Promise.all(areas.map(async (a) => {
      const s = await loadShard(a.level, a.uid);
      return s ? { ...s, _name: a.name } : null;
    }))).filter(Boolean);

    $output.replaceChildren();
    lastTables = [];
    const subBase = `by ${cat} — ${DWELLING_LABEL[dwelling] || dwelling}`;

    // Only the metrics CMHC actually publishes for this breakdown (e.g. only
    // Vacancy Rate is published by rent range; Avg Rent Change only by bedroom
    // type) — otherwise those panels would just show empty "No data" cards.
    const shown   = METRICS.filter(m => dimsFor(m).includes(dim));
    const omitted = METRICS.filter(m => !dimsFor(m).includes(dim));
    if (omitted.length) {
      const note = document.createElement('p');
      note.className = 'text-xs text-neutral-500';
      note.textContent = `Not published by ${dim}: ${omitted.join(', ')}.`;
      $output.appendChild(note);
    }

    // One chart + table pair per metric.
    for (const metric of shown) {
      const chartRows = [];
      const yearsSet = new Set();
      const byArea = new Map();
      const order = [];
      for (const s of shards) {
        const recs = (s.records || []).filter(r =>
          r.series === metric && r.dimension === dim && r.category === cat &&
          r.dwellingType === dwelling && r.season === 'October' &&
          r.year >= yf && r.year <= yt && r.value != null);
        const m = new Map();
        for (const r of recs) { chartRows.push({ category: s._name, year: r.year, value: r.value }); m.set(r.year, r.value); yearsSet.add(r.year); }
        byArea.set(s._name, m); order.push(s._name);
      }

      // Row: chart card (left) + table (right).
      const row = document.createElement('div');
      row.className = 'grid md:grid-cols-2 gap-4 items-start';
      const chartCell = document.createElement('div');
      chartCell.className = 'min-w-0';
      const tableCell = document.createElement('div');
      tableCell.className = 'overflow-x-auto min-w-0';
      row.append(chartCell, tableCell);
      $output.appendChild(row);

      // Chart (areas as lines). buildChartCard renders its own "No data" note
      // when a metric has nothing for this category/area set.
      const card = buildChartCard(chartCell, { series: metric });
      card.render(chartRows, subBase, order, { season: 'October' });

      // Table: transposed — years down the rows, areas across the columns.
      if (chartRows.length) {
        const years = [...yearsSet].sort((a, b) => a - b);
        const fmt = fmtFor(metric);
        const title = `${metric} ${subBase}`;
        const rows = years.map(y => ({
          area: String(y),
          values: order.map(name => fmt((byArea.get(name) || new Map()).get(y))),
        }));
        tableCell.innerHTML = tableHtml(title, 'Year', order, rows);
        lastTables.push({ title, columns: order.slice(),
          rows: rows.map(r => ({ area: r.area, values: r.values.map(v => v == null ? '**' : v) })) });
      } else {
        tableCell.innerHTML = `<p class="text-sm text-neutral-600 mt-2">No ${esc(metric)} data for this selection.</p>`;
      }
    }
  }

  function tableHtml(title, corner, cols, rows) {
    return `<section class="cmhc-table-block">
      <div class="cmhc-table-title">${esc(title)}</div>
      <table class="cmhc-table"><thead><tr><th>${esc(corner)}</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.area)}</td>${r.values.map(v =>
        v == null ? '<td class="cmhc-table-na">**</td>' : `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></section>`;
  }

  // --- Wiring --------------------------------------------------------------
  let pending = null;
  function scheduleRender() { if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = null; render(); }, 120); }

  $province.addEventListener('change', () => { rememberProvince($province.value); populateAreas(); scheduleRender(); });
  $breakdown.forEach(n => n.addEventListener('change', () => { populateCategory(); scheduleRender(); }));
  [...$dwelling, $category, $yearFrom, $yearTo].forEach(el => el.addEventListener('change', scheduleRender));

  document.getElementById('cmp-download-xlsx')?.addEventListener('click', async () => {
    if (!lastTables.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(lastTables.map(t => ({ ...t, dwellingSuffix: '' })),
      { filename: `CMHC_CompareAreas_${new Date().toISOString().slice(0, 10)}.xlsx`,
        maxYear, titleNote: '— CMHC Rental Market Survey' });
  });
  document.getElementById('cmp-copy')?.addEventListener('click', () => {
    if (!lastTables.length) return;
    const html = lastTables.map(t =>
      `<h4>${esc(t.title)}</h4><table border="1" cellspacing="0" cellpadding="3">` +
      `<tr><th></th>${t.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${esc(r.area)}</td>${r.values.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') +
      '</table>').join('<br>');
    copyHtml(html);
  });

  populateAreas();
  populateCategory();
  render();
}

function copyHtml(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch { navigator.clipboard?.writeText(text); }
}
