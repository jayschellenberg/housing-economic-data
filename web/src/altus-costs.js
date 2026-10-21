/*
 * Altus Construction Cost Guide tab — $ per square foot construction cost
 * ranges published annually by Altus Group for the nine Canadian urban
 * centres (Vancouver, Calgary, Edmonton, Winnipeg, GTA, Ottawa, Montreal,
 * Halifax, St. John's), covering residential, commercial, industrial,
 * institutional, civic and recreation buildings. Infrastructure costs
 * (roads, LRT, land servicing) span several unit types and are shown in a
 * dedicated sub-view.
 *
 * Figures ship with the site — the Cost Guides are publicly distributed —
 * so the data loads from a single JSON file built by
 * scripts/altus_cost_guide.py from Jason's extract_altus.py CSV.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark, PALETTE, plotFitted } from './plot-theme.js';
import { downloadCard } from './chart.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';

const DATA_URL = './data/economy/altus_cost_guide.json';
const PREF_KEY = 'altusCosts.v1';

// Nine-city column order used in every Private / Public page of every edition.
const CITIES = ["Vancouver", "Calgary", "Edmonton", "Winnipeg", "GTA",
                "Ottawa", "Montreal", "Halifax", "St. John's"];
// Four-region order used by the Infrastructure LRT / highway tables.
const PROVINCES = ["British Columbia", "Alberta",
                   "Ontario (GTA Region)", "Ontario (Ottawa Region)"];
// Winnipeg leads the default view since it's the primary focus.
const DEFAULT_CITIES = ["Winnipeg", "Calgary", "GTA", "Vancouver"];

const SECTIONS = [
  { key: 'Private',        label: 'Private sector' },
  { key: 'Public',         label: 'Public sector' },
  { key: 'Infrastructure', label: 'Infrastructure' },
];

// Category order within each $/sqft section — matches how the PDF prints
// its pages. Any category outside this list is appended alphabetically.
const CAT_ORDER = {
  Private: ['Residential', 'Commercial', 'Industrial'],
  Public:  ['Institutional', 'Civic'],
};

// Infrastructure's unit groupings. Each becomes its own set of charts.
const INFRA_UNITS = [
  { unit: '$/metre',   label: 'Site servicing — roads (per metre)',   geo: 'city' },
  { unit: '$/acre',    label: 'Land servicing (per acre)',             geo: 'city' },
  { unit: '$/lane-km', label: 'Highways (per lane-km)',                geo: 'both' },
  { unit: '$/km',      label: 'LRT guideway & systems (per km)',       geo: 'province' },
  { unit: '$/unit',    label: 'Per-unit costs',                        geo: 'both' },
  { unit: '$/sqft',    label: 'LRT operations & maintenance facility', geo: 'province' },
];

let ui = null;

const fmtUsd = (v) => (v == null ? '**' : `$${v.toLocaleString('en-CA')}`);
const mid = (lo, hi) => {
  if (hi == null) return null;
  return (lo == null ? hi : (lo + hi) / 2);
};

function loadPrefs() {
  const p = getPref(PREF_KEY);
  return p && typeof p === 'object' ? p : {};
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  setPref(PREF_KEY, next);
  return next;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initAltusCosts() {
  const $main = document.getElementById('alt-output');
  if (!$main) return;
  ui = {
    $main,
    $error:   document.getElementById('alt-error'),
    $section: document.getElementById('alt-section'),
    $cities:  document.getElementById('alt-cities'),
    $from:    document.getElementById('alt-year-from'),
    $to:      document.getElementById('alt-year-to'),
    data: null,
    prefs: loadPrefs(),
  };

  let res;
  try {
    const r = await fetch(DATA_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    res = await r.json();
  } catch (err) {
    ui.$error.textContent = `Could not load the Altus cost data (${err.message}).`;
    ui.$error.hidden = false;
    return;
  }
  ui.data = res;

  wireSidebar();
  render();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function wireSidebar() {
  const years = ui.data.years;
  // Section radio
  const section = ui.prefs.section && SECTIONS.some(s => s.key === ui.prefs.section)
    ? ui.prefs.section : 'Private';
  ui.$section.innerHTML = SECTIONS.map(s => `
    <label class="flex items-center gap-1">
      <input type="radio" name="altSection" value="${s.key}" ${s.key === section ? 'checked' : ''} />
      ${escapeHtml(s.label)}
    </label>`).join('');

  // City multi-select — hidden for the Infrastructure province sub-tables.
  const selCities = Array.isArray(ui.prefs.cities) && ui.prefs.cities.length
    ? ui.prefs.cities.filter(c => CITIES.includes(c))
    : DEFAULT_CITIES.slice();
  renderCityPicker(selCities, section);

  // Year range selects
  ui.$from.replaceChildren(...years.map(y => new Option(String(y), String(y))));
  ui.$to.replaceChildren(...years.map(y => new Option(String(y), String(y))));
  const from = years.includes(ui.prefs.from) ? ui.prefs.from : years[0];
  const to = years.includes(ui.prefs.to) ? ui.prefs.to : years[years.length - 1];
  ui.$from.value = String(from);
  ui.$to.value = String(to);

  // Events
  ui.$section.addEventListener('change', (e) => {
    if (e.target.name !== 'altSection') return;
    savePrefs({ section: e.target.value });
    renderCityPicker(getSelectedCities(), e.target.value);
    render();
  });
  ui.$cities.addEventListener('change', () => {
    savePrefs({ cities: getSelectedCities() });
    render();
  });
  const onYear = () => {
    let f = Number(ui.$from.value), t = Number(ui.$to.value);
    if (f > t) [f, t] = [t, f];
    ui.$from.value = String(f); ui.$to.value = String(t);
    savePrefs({ from: f, to: t });
    render();
  };
  ui.$from.addEventListener('change', onYear);
  ui.$to.addEventListener('change', onYear);
  document.getElementById('alt-reset')?.addEventListener('click', () => {
    ui.prefs = savePrefs({ section: null, cities: null, from: null, to: null });
    wireSidebar();
    render();
  });
}

function renderCityPicker(selected, section) {
  const list = section === 'Infrastructure' ? [...CITIES, ...PROVINCES] : CITIES;
  const sel = new Set(selected);
  ui.$cities.innerHTML = list.map(c => `
    <label class="flex items-center gap-1 text-sm">
      <input type="checkbox" name="altCity" value="${escapeHtml(c)}" ${sel.has(c) ? 'checked' : ''} />
      ${escapeHtml(c)}
    </label>`).join('');
}

function getSelectedCities() {
  return [...ui.$cities.querySelectorAll('input[name="altCity"]:checked')]
    .map(el => el.value);
}

function getSelectedSection() {
  return ui.$section.querySelector('input[name="altSection"]:checked')?.value || 'Private';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const section = getSelectedSection();
  const cities = getSelectedCities();
  const from = Number(ui.$from.value);
  const to = Number(ui.$to.value);

  ui.$main.replaceChildren();
  if (!cities.length) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'Pick at least one centre to show.';
    ui.$main.appendChild(p);
    return;
  }

  const inRange = r => r.year >= from && r.year <= to;
  const rows = ui.data.rows.filter(r => r.section === section && inRange(r));

  if (section === 'Infrastructure') {
    renderInfrastructure(rows, cities, from, to);
  } else {
    renderSqftSection(section, rows, cities, from, to);
  }
}

/**
 * Render the Private / Public sector view: one chart per category, lines
 * coloured by city, each point the median midpoint ($/sqft) across every
 * building type Altus reports in that category / year / city.
 */
function renderSqftSection(section, rows, cities, from, to) {
  // Only $/sqft rows (should be all of them for Private/Public, but filter
  // defensively against future data drift).
  const sqft = rows.filter(r => r.unit === '$/sqft');
  const categories = orderedCategories(sqft, section);
  if (!categories.length) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'No rows for this filter combination.';
    ui.$main.appendChild(p);
    return;
  }

  const headline = document.createElement('p');
  headline.className = 'text-sm text-neutral-600';
  headline.innerHTML = `Each line is the median of the published low/high midpoint across every building type Altus reports in that category / year / centre. Click <strong>Show building types</strong> on any card to see the underlying rows.`;
  ui.$main.appendChild(headline);

  for (const category of categories) {
    const catRows = sqft.filter(r => r.category === category);
    const chartRows = [];
    for (const city of cities) {
      for (let y = from; y <= to; y++) {
        const vals = catRows
          .filter(r => r.city === city && r.year === y)
          .map(r => mid(r.low, r.high))
          .filter(v => v != null);
        if (!vals.length) continue;
        vals.sort((a, b) => a - b);
        const m = vals.length % 2
          ? vals[(vals.length - 1) / 2]
          : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
        chartRows.push({ year: y, city, value: m });
      }
    }
    const card = buildCategoryCard({
      section, category, chartRows, cities, from, to,
      detailRows: catRows.filter(r => cities.includes(r.city)),
    });
    ui.$main.appendChild(card);
  }
}

function orderedCategories(rows, section) {
  const present = [...new Set(rows.map(r => r.category).filter(Boolean))];
  const front = (CAT_ORDER[section] || []).filter(c => present.includes(c));
  const rest = present.filter(c => !front.includes(c)).sort();
  return [...front, ...rest];
}

function buildCategoryCard({ section, category, chartRows, cities, from, to, detailRows }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  const subtitle = `${section} / ${category} — ${from === to ? from : `${from} to ${to}`} ($/sqft midpoint)`;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(category)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <div class="chart-caption">
      <span class="chart-caption-left"></span>
      <span class="chart-source">Source: Altus Group Canadian Cost Guide</span>
    </div>
    <div class="chart-actions flex gap-3">
      <button type="button" data-role="dl-png">Download PNG</button>
      <button type="button" data-role="toggle" class="underline text-neutral-700">Show building types</button>
    </div>
    <div data-role="detail" class="mt-3" hidden></div>`;

  const palette = CITIES.map((c, i) => [c, PALETTE[i % PALETTE.length]]);
  const colourMap = new Map(palette);
  const activeDomain = cities.filter(c => chartRows.some(r => r.city === c));
  const activeRange = activeDomain.map(c => colourMap.get(c) || PALETTE[0]);

  let plotEl;
  if (!chartRows.length) {
    plotEl = document.createElement('p');
    plotEl.className = 'text-sm text-neutral-500 px-2';
    plotEl.textContent = 'No data for the selected centres and years.';
  } else {
    const maxV = Math.max(...chartRows.map(d => d.value));
    plotEl = plotFitted(themed({
      height: 320, marginBottom: 44, marginLeft: 54, marginRight: 16,
      x: { label: 'Year', labelOffset: 36, tickFormat: 'd',
           domain: [from - 0.3, to + 0.3] },
      y: { label: null, domain: [0, Math.ceil(maxV * 1.1 / 10) * 10], grid: true,
           tickFormat: d => `$${d}` },
      color: { domain: activeDomain, range: activeRange, legend: true },
      marks: [
        ...gridMarks(),
        Plot.lineY(chartRows, { x: 'year', y: 'value', stroke: 'city', strokeWidth: 1.8,
                                sort: { channel: 'x' } }),
        Plot.dot(chartRows, { x: 'year', y: 'value', fill: 'city', r: 2.8 }),
        frameMark(),
      ],
    }));
  }
  card.querySelector('[data-role="plot"]').appendChild(plotEl);
  card.querySelector('[data-role="dl-png"]').onclick = () =>
    downloadCard(card, `altus_${section.toLowerCase()}_${category.toLowerCase().replace(/\W+/g, '-')}_${new Date().toISOString().slice(0, 10)}.png`);

  // Expandable building-type detail table
  const $detail = card.querySelector('[data-role="detail"]');
  const $toggle = card.querySelector('[data-role="toggle"]');
  $toggle.addEventListener('click', () => {
    const open = !$detail.hidden;
    $detail.hidden = open;
    $toggle.textContent = open ? 'Show building types' : 'Hide building types';
    if (!open && !$detail.dataset.rendered) {
      $detail.appendChild(buildDetailTable(detailRows, cities, from, to));
      $detail.dataset.rendered = '1';
    }
  });

  return card;
}

/**
 * One table under each category chart: one row per building type (grouped
 * by subcategory), one column per selected city × year showing the low–high
 * range as published.
 */
function buildDetailTable(rows, cities, from, to) {
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-500';
    p.textContent = 'No underlying rows for this filter.';
    return p;
  }
  const years = [];
  for (let y = from; y <= to; y++) years.push(y);

  // Group: subcategory → building_type → city → year → row
  const bySub = new Map();
  for (const r of rows) {
    const sub = r.subcategory || '';
    if (!bySub.has(sub)) bySub.set(sub, new Map());
    const bt = bySub.get(sub);
    if (!bt.has(r.building_type)) bt.set(r.building_type, new Map());
    const bc = bt.get(r.building_type);
    if (!bc.has(r.city)) bc.set(r.city, new Map());
    bc.get(r.city).set(r.year, r);
  }

  const wrap = document.createElement('div');
  wrap.className = 'overflow-x-auto';
  const headCities = cities.map(c => `<th colspan="${years.length}" class="text-center">${escapeHtml(c)}</th>`).join('');
  const headYears = cities.map(() => years.map(y => `<th class="text-right">${y}</th>`).join('')).join('');
  let html = `<table class="cmhc-table text-xs"><thead>
    <tr><th rowspan="2" class="text-left">Building type</th>${headCities}</tr>
    <tr>${headYears}</tr>
  </thead><tbody>`;
  const subs = [...bySub.keys()].sort((a, b) => a.localeCompare(b));
  for (const sub of subs) {
    if (sub) {
      html += `<tr><td colspan="${1 + cities.length * years.length}" class="font-semibold bg-neutral-50">${escapeHtml(sub)}</td></tr>`;
    }
    const types = [...bySub.get(sub).keys()].sort((a, b) => a.localeCompare(b));
    for (const t of types) {
      const cityMap = bySub.get(sub).get(t);
      const cells = cities.map(c => {
        const yearMap = cityMap.get(c) || new Map();
        return years.map(y => {
          const r = yearMap.get(y);
          if (!r) return `<td class="text-right text-neutral-300">—</td>`;
          const lo = r.low, hi = r.high;
          const txt = (lo == null && hi == null) ? '—'
            : (lo == null) ? `up to ${fmtUsd(hi)}`
            : (hi == null) ? `${fmtUsd(lo)}+`
            : `${fmtUsd(lo)}–${fmtUsd(hi)}`;
          return `<td class="text-right whitespace-nowrap">${txt}</td>`;
        }).join('');
      }).join('');
      html += `<tr><td class="text-left">${escapeHtml(t)}</td>${cells}</tr>`;
    }
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
  return wrap;
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function renderInfrastructure(rows, selected, from, to) {
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'No infrastructure rows in the selected year range.';
    ui.$main.appendChild(p);
    return;
  }
  const intro = document.createElement('p');
  intro.className = 'text-sm text-neutral-600';
  intro.innerHTML = `Infrastructure spans several unit types. Each sub-section below is charted on its native unit. LRT and highway rows are published by province; servicing by centre.`;
  ui.$main.appendChild(intro);

  const cityGeos = selected.filter(c => CITIES.includes(c));
  const provGeos = selected.filter(c => PROVINCES.includes(c));

  for (const grp of INFRA_UNITS) {
    const unitRows = rows.filter(r => r.unit === grp.unit);
    if (!unitRows.length) continue;

    // Each (building_type) gets its own card so the units stay comparable.
    const btypes = [...new Set(unitRows.map(r => r.building_type))].sort((a, b) => a.localeCompare(b));
    const section = document.createElement('section');
    section.className = 'space-y-3';
    const header = document.createElement('h3');
    header.className = 'cmhc-mi-section-title';
    header.textContent = grp.label;
    section.appendChild(header);

    for (const bt of btypes) {
      const btRows = unitRows.filter(r => r.building_type === bt);
      const geoSet = new Set(btRows.map(r => r.city));
      const useProv = provGeos.some(p => geoSet.has(p));
      const useCity = cityGeos.some(c => geoSet.has(c));
      const geos = [
        ...(useCity ? cityGeos.filter(c => geoSet.has(c)) : []),
        ...(useProv ? provGeos.filter(p => geoSet.has(p)) : []),
      ];
      if (!geos.length) continue;

      const chartRows = [];
      for (const g of geos) {
        for (const r of btRows.filter(rr => rr.city === g)) {
          const v = mid(r.low, r.high);
          if (v == null) continue;
          chartRows.push({ year: r.year, geo: g, value: v });
        }
      }
      if (!chartRows.length) continue;
      section.appendChild(buildInfraCard({
        title: bt, unit: grp.unit, chartRows, geos, from, to,
      }));
    }
    ui.$main.appendChild(section);
  }
}

function buildInfraCard({ title, unit, chartRows, geos, from, to }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  const subtitle = `${from === to ? from : `${from} to ${to}`} — ${unit} (midpoint)`;
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <div class="chart-caption">
      <span class="chart-caption-left"></span>
      <span class="chart-source">Source: Altus Group Canadian Cost Guide</span>
    </div>
    <div class="chart-actions"><button type="button" data-role="dl-png">Download PNG</button></div>`;

  const geoYears = [...new Set(chartRows.map(r => r.year))];
  const minY = Math.min(...geoYears), maxY = Math.max(...geoYears);
  const activeDomain = geos.filter(g => chartRows.some(r => r.geo === g));
  const palette = [...CITIES, ...PROVINCES];
  const colourFor = (g) => PALETTE[palette.indexOf(g) % PALETTE.length];
  const range = activeDomain.map(colourFor);

  const maxV = Math.max(...chartRows.map(d => d.value));
  const fmtAxis = unit === '$/sqft'
    ? (d => `$${d}`)
    : (d => `$${d >= 1e6 ? (d/1e6).toFixed(1)+'M' : d >= 1e3 ? Math.round(d/1e3)+'k' : d}`);

  const plot = plotFitted(themed({
    height: 300, marginBottom: 44, marginLeft: 66, marginRight: 16,
    x: { label: 'Year', labelOffset: 36, tickFormat: 'd', domain: [minY - 0.3, maxY + 0.3] },
    y: { label: null, domain: [0, maxV * 1.1], grid: true, tickFormat: fmtAxis },
    color: { domain: activeDomain, range, legend: true },
    marks: [
      ...gridMarks(),
      Plot.lineY(chartRows, { x: 'year', y: 'value', stroke: 'geo', strokeWidth: 1.8,
                              sort: { channel: 'x' } }),
      Plot.dot(chartRows, { x: 'year', y: 'value', fill: 'geo', r: 2.8 }),
      frameMark(),
    ],
  }));
  card.querySelector('[data-role="plot"]').appendChild(plot);
  card.querySelector('[data-role="dl-png"]').onclick = () =>
    downloadCard(card, `altus_infra_${title.toLowerCase().replace(/\W+/g, '-')}_${new Date().toISOString().slice(0, 10)}.png`);
  return card;
}
