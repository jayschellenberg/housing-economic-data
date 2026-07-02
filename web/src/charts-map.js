/*
 * Rental Charts survey-zone map — the CMHC-geography counterpart of the
 * census-boundary maps. Follows the charts tab's (geoLevel, geoUid) selection:
 * when a survey zone, neighbourhood or surveyed CMA is selected, it shows that
 * CMA's zone (or neighbourhood) polygons shaded by a rental metric, and doubles
 * as a click-to-select picker — clicking a polygon drives the same filters state
 * the dropdowns use (filters.setGeo).
 *
 * Shading comes from rental_summary.json (built by build-rental-summary.mjs from
 * the series shards): each area's newest headline value per metric. A "Map
 * metric" picker above the map switches which metric is shaded — the same five
 * series the charts plot, in the same order.
 *
 * Boundaries: adapted from CMHC RMS survey geographies (r/21 build step).
 * A handful of historical year-variant uids have no polygon of their own
 * (their area is on the map under the sibling uid) — those stay selectable
 * via the dropdowns; the map simply shows no selection outline for them.
 */

import { mapCard, quantileChoropleth } from './map.js';
import { cmaGeo, hasCmaGeo } from './geo.js';
import { loadRentalSummary } from './rental-summary.js';
import { escapeHtml } from './escape.js';

const NO_DATA_FILL = '#e5e7eb';   // grey — matches the "**" missing-data convention
const LEVEL_NOUN = { zone: 'survey zones', neighbourhood: 'neighbourhoods' };

// Metrics the map can shade by — same set and order as the charts' panels.
const METRICS = [
  { key: 'Median Rent',         label: 'Median rent',        kind: 'usd' },
  { key: 'Average Rent',        label: 'Average rent',       kind: 'usd' },
  { key: 'Vacancy Rate',        label: 'Vacancy rate',       kind: 'pct' },
  { key: 'Average Rent Change', label: 'Avg rent change',    kind: 'pct' },
  { key: 'Rental Universe',     label: 'Rental universe',    kind: 'int' },
];

const fmtFull = (kind, v) => !Number.isFinite(v) ? 'No data'
  : kind === 'usd' ? `$${Math.round(v).toLocaleString()}`
  : kind === 'pct' ? `${v.toFixed(1)}%`
  : Math.round(v).toLocaleString();
// Rents sit in the hundreds–low-thousands, so keep full dollars in the legend
// (the census maps' "$Xk" rounding is for dwelling values, not rents).
const fmtCompact = (kind, v) => !Number.isFinite(v) ? '**'
  : kind === 'usd' ? `$${Math.round(v).toLocaleString()}`
  : kind === 'pct' ? `${v.toFixed(1)}%`
  : (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

export function initChartsMap({ geographies, onSelect }) {
  const $host = document.getElementById('charts-map');
  if (!$host) return { render: () => {} };

  const levels = geographies.levels || {};
  const uidSet = (lvl) => new Set((levels[lvl] || []).map(it => String(it.uid)));
  const appUids = { zone: uidSet('zone'), neighbourhood: uidSet('neighbourhood') };
  const cmaName = (code) => (levels.cma || []).find(it => String(it.uid) === String(code))?.name || `CMA ${code}`;

  // Metric picker above the map (mirrors the census/housing map controls).
  const controls = document.createElement('div');
  controls.className = 'census-map-controls';
  controls.innerHTML = `<label for="charts-map-metric" class="text-sm text-neutral-600">Map metric:</label>
    <select id="charts-map-metric" class="border border-neutral-300 rounded px-2 py-1 text-sm">
      ${METRICS.map(m => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`).join('')}
    </select>`;
  $host.appendChild(controls);
  const $metric = controls.querySelector('#charts-map-metric');

  const map = mapCard($host);
  let token = 0;
  let lastState = null;
  $metric.addEventListener('change', () => { if (lastState) render(lastState); });

  // Which CMA + polygon layer does the current selection imply?
  function target(state) {
    const { geoLevel, geoUid } = state;
    if (geoLevel === 'zone' || geoLevel === 'neighbourhood') {
      return { cma: String(geoUid).split('-')[0], layer: geoLevel };
    }
    if (geoLevel === 'cma') return { cma: String(geoUid), layer: 'zone' };
    return null;                       // province / csd — no zone map
  }

  const hide = () => { controls.style.display = 'none'; map.card.style.display = 'none'; };

  async function render(state) {
    lastState = state;
    const t = target(state);
    if (!t || !hasCmaGeo(t.cma)) { hide(); return; }
    const my = ++token;
    const [geojson, summary] = await Promise.all([cmaGeo(t.cma, t.layer), loadRentalSummary()]);
    if (my !== token) return;                        // superseded by a newer render
    if (!geojson) { hide(); return; }
    controls.style.display = '';
    map.card.style.display = '';

    const metric = METRICS.find(m => m.key === $metric.value) || METRICS[0];
    const uids = appUids[t.layer];
    const entries = geojson.features.map(f => {
      const id = String(f.properties.id);
      const rec = summary?.geos?.[id]?.values?.[metric.key];
      return { uid: id, name: f.properties.name, value: rec && Number.isFinite(rec.v) ? rec.v : null, year: rec?.y };
    });
    const { values, legend } = quantileChoropleth(entries, {
      label:   (v) => fmtFull(metric.kind, v),
      compact: (v) => fmtCompact(metric.kind, v),
    });
    // mapCard's tooltip already prefixes the area name, so the label is just the
    // value (+ its survey year). Keep app-known areas clickable even where the
    // metric has no value.
    for (const e of entries) {
      const v = values.get(e.uid);
      if (v && Number.isFinite(e.value)) v.label = `${fmtFull(metric.kind, e.value)}${e.year ? ` (${e.year})` : ''}`;
      else if (uids.has(e.uid) && !values.has(e.uid)) values.set(e.uid, { fill: NO_DATA_FILL, label: 'No data' });
    }

    const noun = LEVEL_NOUN[t.layer];
    map.render({
      geojson,
      values,
      selectedId: state.geoUid,
      onSelect: (id) => onSelect(t.layer, id),
      title: `${cmaName(t.cma)} — ${metric.label} by ${noun}`,
      sub: `Shaded by ${metric.label.toLowerCase()} (newest survey). Click a ${noun.replace(/s$/, '')} to load its charts; the dropdowns above stay in sync.`,
      source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
      legend,
      filename: `rental_map_${t.cma}_${t.layer}_${metric.key}.png`.replace(/\s+/g, '-'),
    });
  }

  return { render };
}
