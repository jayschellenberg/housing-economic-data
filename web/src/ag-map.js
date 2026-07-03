/*
 * Agriculture tab — within-province farm-structure choropleth. Shades a
 * province's Census Consolidated Subdivisions (2021 Census of Agriculture) by a
 * chosen metric: average farm size, number of farms, average operator age, or
 * the dominant (most common) farm type. Scoped to the tab's province dropdown.
 *
 * Reuses the shared map component (mapCard + quantileChoropleth). Boundary
 * geometry is the CCS GeoJSON from r/20 (feature id = CCSUID); the shading data
 * is ag_ccs.json from r/24, joined on CCSUID. The "dominant farm type" metric is
 * categorical, so it builds its own colour map + legend rather than the quantile
 * ramp the numeric metrics use.
 */

import { mapCard, quantileChoropleth } from './map.js';
import { provinceGeo, hasProvinceGeo } from './geo.js';
import { escapeHtml } from './escape.js';

const NO_DATA_FILL = '#e5e7eb';

const METRICS = [
  { key: 'size',  label: 'Average farm size', full: (v) => `${Math.round(v).toLocaleString()} acres`, compact: (v) => `${Math.round(v).toLocaleString()} ac` },
  { key: 'farms', label: 'Number of farms',   full: (v) => Math.round(v).toLocaleString(),            compact: (v) => Math.round(v).toLocaleString() },
  { key: 'age',   label: 'Average operator age', full: (v) => `${Number(v).toFixed(1)} years`,        compact: (v) => `${Number(v).toFixed(1)}` },
  { key: 'type',  label: 'Dominant farm type', categorical: true },
];

// Fixed colours for the categorical farm-type map, so the same type is the same
// colour across provinces. Types not listed fall back to grey.
const TYPE_COLORS = {
  'Grain & oilseed':      '#c9a227',
  'Cattle':               '#8c6d4f',
  'Dairy':                '#4e79a7',
  'Hog':                  '#e15759',
  'Poultry & egg':        '#b07aa1',
  'Sheep & goat':         '#76b7b2',
  'Other animal':         '#9c755f',
  'Other crop':           '#59a14f',
  'Vegetable':            '#8cd17d',
  'Fruit & nut':          '#f28e2b',
  'Greenhouse & nursery': '#499894',
};

let dataPromise = null;
const loadData = () => {
  if (!dataPromise) {
    dataPromise = fetch('./data/geo/ag_ccs.json')
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { if (!d) dataPromise = null; return d; });
  }
  return dataPromise;
};

const PROV_NAME = { 46: 'Manitoba', 47: 'Saskatchewan', 48: 'Alberta', 59: 'British Columbia' };

export function initAgMap({ host }) {
  const $host = document.getElementById(host);
  if (!$host) return { render: () => {} };

  const controls = document.createElement('div');
  controls.className = 'census-map-controls';
  controls.innerHTML = `<label for="ag-map-metric" class="text-sm text-neutral-600">Map metric:</label>
    <select id="ag-map-metric" class="border border-neutral-300 rounded px-2 py-1 text-sm">
      ${METRICS.map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
    </select>`;
  $host.appendChild(controls);
  const $metric = controls.querySelector('#ag-map-metric');

  const map = mapCard($host);
  let token = 0;
  let lastProv = null;
  $metric.addEventListener('change', () => { if (lastProv) draw(lastProv); });

  const hide = () => { controls.style.display = 'none'; map.card.style.display = 'none'; };

  async function draw(sgc) {
    lastProv = sgc;
    if (!hasProvinceGeo(sgc)) { hide(); return; }
    const my = ++token;
    const [geojson, data] = await Promise.all([provinceGeo(sgc, 'ccs'), loadData()]);
    if (my !== token) return;
    if (!geojson || !data) { hide(); return; }
    controls.style.display = '';
    map.card.style.display = '';

    const metric = METRICS.find((m) => m.key === $metric.value) || METRICS[0];
    const series = data.series || {};
    const name = PROV_NAME[sgc] || 'Province';
    const title = `${name} — ${metric.label} by consolidated subdivision`;
    const source = 'Boundaries: Statistics Canada 2021 cartographic files; data: 2021 Census of Agriculture';
    const filename = `farm_${metric.key}_${name}.png`.replace(/\s+/g, '-');

    if (metric.categorical) {
      // Dominant farm type — categorical fill + a per-type legend of the types
      // actually present in this province.
      const present = new Set();
      const values = new Map();
      for (const f of geojson.features) {
        const t = series[String(f.properties.id)]?.type;
        if (!t) continue;
        present.add(t);
        values.set(String(f.properties.id), { fill: TYPE_COLORS[t] || '#bbbbbb', label: `${f.properties.name}: ${t}` });
      }
      const legend = [...present]
        .sort((a, b) => (Object.keys(TYPE_COLORS).indexOf(a)) - (Object.keys(TYPE_COLORS).indexOf(b)))
        .map((t) => ({ swatch: TYPE_COLORS[t] || '#bbbbbb', text: t }));
      legend.push({ swatch: NO_DATA_FILL, text: 'No data' });
      map.render({
        geojson, values, legend, title, source, filename,
        sub: `Most common farm type in each subdivision (2021). Click-through not enabled.`,
      });
      return;
    }

    const entries = geojson.features.map((f) => {
      const rec = series[String(f.properties.id)];
      const v = rec && Number.isFinite(rec[metric.key]) ? rec[metric.key] : null;
      return { uid: String(f.properties.id), name: f.properties.name, value: v };
    });
    const { values, legend } = quantileChoropleth(entries, { label: metric.full, compact: metric.compact });
    map.render({
      geojson, values, legend, title, source, filename,
      sub: `Shaded by ${metric.label.toLowerCase()} (2021 Census of Agriculture). Darker = higher.`,
    });
  }

  return { render: (sgc) => draw(sgc) };
}
