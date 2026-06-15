/*
 * Housing Stock view — the unified census housing-characteristics page.
 * Combines two StatsCan census datasets for one area + census-year view:
 *   - Structural type of dwelling (dwelling_types.json, r/10+10b/c/d) — chart + table
 *   - Period of construction (age) + dwelling condition (census_housing.json, r/07–09)
 * The two datasets cover different geographies — dwelling type is published at
 * Canada / province / CMA-CA level; age & condition at Canada / province /
 * municipality (CSD) level — so the area dropdown is the union of both and each
 * section renders only where the selected area has data. (The former standalone
 * "Dwelling Type" tab folded in here.)
 *
 * Views: a point-in-time profile for a single census year, or (default) a
 * comparison across census years.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark, PALETTE } from './plot-theme.js';

// Common age buckets for the comparison view — each census's own bands rolled
// up to a shared set so the years line up despite different banding.
const COMMON_AGE = ['Pre-1961', '1961–1980', '1981–1990', '1991–2000', '2001–2010', '2011 or later'];
const ROLLUP = {
  '2021': [[0, 1, 2], [3, 4], [5], [6, 7], [8, 9], [10, 11]],  // 12 bands → 6
  '2016': [[0], [1], [2], [3], [4, 5], [6]],                   // 7 bands → 6
  '2011': [[0], [1], [2], [3], [4, 5], []],                    // 6 bands → 6 (no 2011+ band)
};
// 2006 has only a coarse before/after-1986 age split (no detailed bands), so it
// contributes to the comparable metrics (total dwellings, % major repairs) but
// is left out of the rolled-up age-mix comparison (no ROLLUP entry).
const ALL_YEARS = ['2006', '2011', '2016', '2021'];

// Short labels for the 8 structural types (index-aligned across census years;
// 2006 leaves the last two null — see dwelling_types notes2006).
const DT_SHORT = ['Single-detached', 'Semi-detached', 'Row', 'Duplex',
                  'Apt <5', 'Apt 5+', 'Other attached', 'Movable'];

export async function initHousing() {
  const $area = document.getElementById('hsk-area');
  const $tables = document.getElementById('hsk-tables');
  const $headline = document.getElementById('hsk-headline');
  const $charts = document.getElementById('hsk-chart-grid');
  const $view = document.querySelectorAll('input[name="hskView"]');
  if (!$area || !$tables) return;

  const [housing, dwelling] = await Promise.all([
    fetch('./data/housing/census_housing.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/housing/dwelling_types.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!housing || !Array.isArray(housing.areas)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census housing data not found. Run r/07_scrape_census_housing.R.</p>';
    return;
  }

  const hByUid = new Map(housing.areas.map(a => [a.uid, a]));
  const dByUid = new Map((dwelling?.areas || []).map(a => [a.uid, a]));
  const nameByUid = new Map([...dByUid].map(([u, a]) => [u, a.name]).concat(
    housing.areas.map(a => [a.uid, a.name])));   // census_housing names win on overlap

  const fmtN = (v) => v == null ? '**' : Number(v).toLocaleString();
  const fmtP = (v) => v == null ? '—'  : `${v.toFixed(1)}%`;
  const major = (yd) => yd?.condition?.[yd.condition.length - 1];   // last condition cat = major
  const rollAge = (year, age) => ROLLUP[year].map(ix => ix.reduce((s, i) => s + (age?.[i] || 0), 0));
  const dwellingYearsAsc = (dd) => ALL_YEARS.filter(y => dd.census?.[y]);

  // --- Combined area dropdown (union of both datasets) -----------------------
  const byName = (a, b) => a.name.localeCompare(b.name);
  const pickH = (test) => housing.areas.filter(test).sort(byName);
  const pickD = (test) => (dwelling?.areas || []).filter(test).sort(byName);
  const country = housing.areas.filter(a => a.level === 'country');
  const opt   = (a) => `<option value="${escapeHtml(a.uid)}">${escapeHtml(a.name)}</option>`;
  const group = (label, arr) => arr.length ? `<optgroup label="${escapeHtml(label)}">${arr.map(opt).join('')}</optgroup>` : '';
  $area.innerHTML =
    country.map(opt).join('') +
    group('Provinces & Territories', pickH(a => a.level === 'province')) +
    group('Manitoba CMAs / CAs',     pickD(a => a.level === 'cma' && a.prov === '46')) +
    group('Saskatchewan CMAs / CAs', pickD(a => a.level === 'cma' && a.prov === '47')) +
    group('Manitoba municipalities', pickH(a => a.level === 'csd' && a.prov === '46')) +
    group('Saskatchewan municipalities', pickH(a => a.level === 'csd' && a.prov === '47'));
  // Default to Manitoba (province) — it carries both datasets, so the default
  // compare view shows dwelling type + age + condition together.
  $area.value = hByUid.has('46') ? '46'
              : hByUid.has('4611040') ? '4611040'
              : (country[0]?.uid || $area.options[0]?.value);

  const viewVal = () => [...$view].find(r => r.checked)?.value || 'compare';
  let lastTables = [];

  // ===========================================================================
  // Dwelling type (structural type) — chart + table, where the area has data
  // ===========================================================================
  function dwellCompare(dd, name) {
    const ys = dwellingYearsAsc(dd);
    if (!ys.length) return;
    // Chart: stacked bar of structural types across census years.
    const data = [];
    for (const y of ys) {
      const c = dd.census[y];
      DT_SHORT.forEach((lbl, i) => { if (c.types?.[i] != null) data.push({ year: y, type: lbl, value: c.types[i] }); });
    }
    if (data.length) {
      const svg = Plot.plot(themed({
        height: 250, marginBottom: 30,
        x: { type: 'band', label: null },
        y: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString() },
        color: { domain: DT_SHORT, range: PALETTE, legend: true },
        marks: [Plot.barY(data, { x: 'year', y: 'value', fill: 'type', order: DT_SHORT }), frameMark()],
      }));
      appendCard('Dwelling type mix', `${name} — occupied dwellings by structural type`, svg);
    }
    // Table: types × census years (counts), with % share of the latest year.
    const last = ys[ys.length - 1];
    const totL = dd.census[last]?.total || 0;
    const rows = DT_SHORT.map((lbl, i) => ({
      area: lbl,
      values: [...ys.map(y => fmtN(dd.census[y]?.types?.[i])),
               fmtP(totL > 0 && dd.census[last]?.types?.[i] != null ? dd.census[last].types[i] / totL * 100 : null)],
    }));
    rows.push({ area: 'Total', values: [...ys.map(y => fmtN(dd.census[y]?.total)), '100.0%'] });
    const cols = [...ys, `${last} share`];
    const note = dwelling?.notes2006 && ys.includes('2006')
      ? `<p class="text-xs text-neutral-500 mt-2">${escapeHtml(dwelling.notes2006)}</p>` : '';
    appendBlock(`Structural type of dwelling — ${ys.join(' / ')}`,
      compareTable(['Structural type', ...cols], rows) + note);
    lastTables.push({ title: `${name} — dwelling type ${ys.join('/')}`, columns: cols, rows });
  }

  function dwellYear(dd, name, year) {
    const c = dd.census?.[year];
    if (!c) return;
    const total = c.total || 0;
    const share = (v) => (total > 0 && v != null) ? v / total * 100 : null;
    // Chart: horizontal bar of structural types for the year.
    const data = DT_SHORT.map((lbl, i) => ({ type: lbl, value: c.types?.[i] })).filter(d => d.value != null);
    if (data.length) {
      const svg = Plot.plot(themed({
        height: 250, marginLeft: 110, marginBottom: 28,
        x: { label: 'Occupied dwellings', tickFormat: v => Number(v).toLocaleString(), inset: 0 },
        y: { label: null },
        color: { legend: false },
        marks: [
          Plot.gridX({ stroke: '#d4d4d8', strokeDasharray: '3,3' }),
          Plot.barX(data, { x: 'value', y: 'type', fill: PALETTE[0], sort: { y: '-x' } }),
          frameMark(),
        ],
      }));
      appendCard('Dwelling type mix', `${name} — structural type (${year} Census)`, svg);
    }
    const rows = DT_SHORT.map((lbl, i) => ({ area: lbl, values: [fmtN(c.types?.[i]), fmtP(share(c.types?.[i]))] }));
    rows.push({ area: 'Total', values: [fmtN(total), '100.0%'] });
    const note = (c.types?.some(v => v == null) && dwelling?.notes2006)
      ? `<p class="text-xs text-neutral-500 mt-2">${escapeHtml(dwelling.notes2006)}</p>` : '';
    appendBlock(`Structural type of dwelling — ${year}`,
      summaryTable(['Structural type', 'Dwellings', 'Share'], rows) + note);
    lastTables.push({ title: `${name} — dwelling type (${year})`, columns: ['Dwellings', 'Share'], rows });
  }

  // ===========================================================================
  // Age (period of construction) + condition — tables, where the area has data
  // ===========================================================================
  function housingYear(hd, name, year) {
    const yd = hd.census?.[year];
    if (!yd) {
      appendBlock('Housing stock', `<p class="text-sm text-neutral-600">No ${year} age/condition data for this area (boundary change or suppressed).</p>`);
      return;
    }
    const total = yd.total || 0;
    const share = (v) => (total > 0 && v != null) ? (v / total * 100) : null;
    const ageRows  = housing.periodLabels[year].map((lbl, i)    => ({ area: lbl, values: [fmtN(yd.age?.[i]),       fmtP(share(yd.age?.[i]))] }));
    const condRows = housing.conditionLabels[year].map((lbl, i) => ({ area: lbl, values: [fmtN(yd.condition?.[i]), fmtP(share(yd.condition?.[i]))] }));
    const withTotal = (rows) => rows.concat([{ area: 'Total', values: [fmtN(total), '100.0%'] }]);
    appendBlock(`Age — period of construction (${year})`, summaryTable(['Category', 'Dwellings', 'Share'], withTotal(ageRows)));
    appendBlock(`Condition — repairs needed (${year})`, summaryTable(['Category', 'Dwellings', 'Share'], withTotal(condRows)));
    lastTables.push(
      { title: `${name} — period of construction (${year})`, columns: ['Dwellings', 'Share'], rows: withTotal(ageRows) },
      { title: `${name} — dwelling condition (${year})`,      columns: ['Dwellings', 'Share'], rows: withTotal(condRows) });
  }

  function housingCompare(hd, name) {
    const years = ALL_YEARS.filter(y => hd.census?.[y]);   // ascending
    if (years.length < 2) {
      appendBlock('Housing stock',
        `<p class="text-sm text-neutral-600">Age/condition comparison needs at least two census years; this area has ${years.join(', ') || 'none'}.</p>`);
      if (years.length === 1) housingYear(hd, name, years[0]);
      return;
    }
    const yd = (y) => hd.census[y];
    const tot = (y) => yd(y).total || 0;
    const majPct = (y) => { const t = tot(y), m = major(yd(y)); return (t > 0 && m != null) ? m / t * 100 : null; };
    const first = years[0], last = years[years.length - 1];
    const totChg = tot(first) > 0 ? (tot(last) - tot(first)) / tot(first) * 100 : null;
    const ppChg  = (majPct(last) != null && majPct(first) != null) ? majPct(last) - majPct(first) : null;
    const fmtDeltaPct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    const fmtDeltaPP  = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} pp`;

    const headRows = [
      { area: 'Total private dwellings', values: [...years.map(y => fmtN(tot(y))), fmtDeltaPct(totChg)] },
      { area: 'Needing major repairs',   values: [...years.map(y => `${fmtN(major(yd(y)))} (${fmtP(majPct(y))})`), fmtDeltaPP(ppChg)] },
    ];
    const chgCol = `Δ ${first}→${last}`;
    appendBlock(`Housing stock — ${years.join(' / ')}`, compareTable(['', ...years, chgCol], headRows));
    lastTables.push({ title: `${name} — housing stock ${years.join('/')}`, columns: [...years, chgCol], rows: headRows });

    const ageYears = years.filter(y => ROLLUP[y]);
    if (ageYears.length >= 2) {
      const aFirst = ageYears[0], aLast = ageYears[ageYears.length - 1];
      const rolled = Object.fromEntries(ageYears.map(y => [y, rollAge(y, yd(y).age)]));
      const ageRows = COMMON_AGE.map((lbl, i) => {
        const sh = (y) => tot(y) > 0 ? rolled[y][i] / tot(y) * 100 : null;
        return { area: lbl, values: [...ageYears.map(y => fmtP(sh(y))), fmtDeltaPP(sh(aLast) != null && sh(aFirst) != null ? sh(aLast) - sh(aFirst) : null)] };
      });
      const ageChg = `Δ ${aFirst}→${aLast}`;
      appendBlock('Age mix (share of dwellings)', compareTable(['Period of construction', ...ageYears, ageChg], ageRows));
      lastTables.push({ title: `${name} — age mix ${ageYears.join('/')}`, columns: [...ageYears, ageChg], rows: ageRows });
    }
  }

  // --- Headline --------------------------------------------------------------
  function renderHeadline(name, hd, dd, v) {
    if (hd) {
      if (v === 'compare') {
        const years = ALL_YEARS.filter(y => hd.census?.[y]);
        if (years.length >= 2) {
          const tot = (y) => hd.census[y].total || 0;
          const majP = (y) => { const t = tot(y), m = major(hd.census[y]); return (t > 0 && m != null) ? m / t * 100 : null; };
          const f = years[0], l = years[years.length - 1];
          const d = tot(f) > 0 ? (tot(l) - tot(f)) / tot(f) * 100 : null;
          $headline.innerHTML = `
            <div class="cmhc-hsk-title">${escapeHtml(name)} — housing stock <span>(${f} → ${l})</span></div>
            <div class="cmhc-hsk-stats">
              <span>Dwellings <strong>${fmtN(tot(f))} → ${fmtN(tot(l))}</strong> (${d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(1) + '%'})</span>
              <span>Major repairs <strong>${fmtP(majP(f))} → ${fmtP(majP(l))}</strong></span>
            </div>`;
          return;
        }
      } else {
        const yd = hd.census?.[v];
        if (yd) {
          const total = yd.total || 0, share = (x) => (total > 0 && x != null) ? x / total * 100 : null;
          const since = yd.age?.[yd.age.length - 1];
          $headline.innerHTML = `
            <div class="cmhc-hsk-title">${escapeHtml(name)} — housing stock <span>(${v} Census)</span></div>
            <div class="cmhc-hsk-stats">
              <span><strong>${fmtN(total)}</strong> private dwellings</span>
              <span><strong>${fmtP(share(major(yd)))}</strong> need major repairs</span>
              <span><strong>${fmtP(share(since))}</strong> built ${escapeHtml(housing.periodLabels[v].slice(-1)[0] || 'recently')}</span>
            </div>`;
          return;
        }
      }
    }
    if (dd) {
      const ys = dwellingYearsAsc(dd), ly = ys[ys.length - 1], c = dd.census[ly], total = c.total || 0;
      const apt = (c.types?.[3] || 0) + (c.types?.[4] || 0) + (c.types?.[5] || 0);  // duplex + apt<5 + apt5+
      $headline.innerHTML = `
        <div class="cmhc-hsk-title">${escapeHtml(name)} — dwellings by type <span>(${ly} Census)</span></div>
        <div class="cmhc-hsk-stats">
          <span><strong>${fmtN(total)}</strong> private dwellings</span>
          <span><strong>${fmtP(total ? c.types?.[0] / total * 100 : null)}</strong> single-detached</span>
          <span><strong>${fmtP(total ? apt / total * 100 : null)}</strong> apartments</span>
        </div>`;
      return;
    }
    $headline.innerHTML = `<div class="cmhc-hsk-title">${escapeHtml(name)}</div>`;
  }

  // --- HTML builders ---------------------------------------------------------
  function appendBlock(title, innerHtml) {
    $tables.insertAdjacentHTML('beforeend',
      `<section class="cmhc-table-block"><div class="cmhc-table-title">${escapeHtml(title)}</div>${innerHtml}</section>`);
  }
  function summaryTable(headers, rows) {
    const body = rows.map(r => {
      const cls = r.area === 'Total' ? ' class="cmhc-table-summary cmhc-table-summary-top"' : '';
      return `<tr${cls}><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="cmhc-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }
  function compareTable(headers, rows) {
    const body = rows.map(r => {
      const cls = r.area === 'Total' ? ' class="cmhc-table-summary cmhc-table-summary-top"' : '';
      return `<tr${cls}><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="cmhc-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }
  function appendCard(title, sub, svgNode) {
    const card = document.createElement('section');
    card.className = 'chart-card';
    card.innerHTML = `<header class="chart-title">${escapeHtml(title)}</header>
      <p class="chart-sub">${escapeHtml(sub)}</p>
      <div data-role="plot"></div>
      <div class="chart-caption"><span class="chart-caption-left"></span>
        <span class="chart-source">Source: StatsCan Census</span></div>`;
    card.querySelector('[data-role="plot"]').appendChild(svgNode);
    $charts?.appendChild(card);
  }

  // --- Orchestration ---------------------------------------------------------
  function render() {
    const uid = $area.value;
    const name = nameByUid.get(uid) || uid;
    const hd = hByUid.get(uid), dd = dByUid.get(uid);
    const v = viewVal();
    $charts?.replaceChildren();
    $tables.innerHTML = '';
    lastTables = [];

    renderHeadline(name, hd, dd, v);

    if (dd) { v === 'compare' ? dwellCompare(dd, name) : dwellYear(dd, name, v); }
    if (hd) { v === 'compare' ? housingCompare(hd, name) : housingYear(hd, name, v); }

    if (!dd && !hd) {
      $tables.innerHTML = '<p class="text-sm text-neutral-600">No census data for this area.</p>';
    } else if (!hd && dd) {
      $tables.insertAdjacentHTML('beforeend',
        '<p class="text-xs text-neutral-500">Age &amp; condition are published at the municipality level — pick a municipality to see them.</p>');
    } else if (hd && !dd) {
      $tables.insertAdjacentHTML('beforeend',
        '<p class="text-xs text-neutral-500">Structural type is published at the CMA/CA, province &amp; Canada level — pick a CMA or province to see the dwelling-type breakdown.</p>');
    }
  }

  $area.addEventListener('change', render);
  $view.forEach(r => r.addEventListener('change', render));
  render();

  // --- Exports ---------------------------------------------------------------
  document.getElementById('hsk-download-xlsx')?.addEventListener('click', async () => {
    if (!lastTables.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(
      lastTables.map(t => ({ ...t, dwellingSuffix: '' })),
      { filename: `Census_HousingStock_${new Date().toISOString().slice(0, 10)}.xlsx`,
        maxYear: 2021, titleNote: '— Census of Population (StatsCan)' });
  });
  document.getElementById('hsk-copy')?.addEventListener('click', () => {
    const html = lastTables.map(t =>
      `<h4>${escapeHtml(t.title)}</h4>` +
      `<table border="1" cellspacing="0" cellpadding="3"><tr><th></th>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('') +
      '</table>').join('<br>');
    copyHtml(html);
  });
}

function copyHtml(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch {
    navigator.clipboard?.writeText(text);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
