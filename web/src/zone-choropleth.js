/*
 * Shared CMHC-geography choropleth map: shade a CMA's survey zones (or
 * neighbourhoods) by a metric, with a picker, quantile legend, value+year
 * tooltip, and click-to-select. Both the Rental Charts map (charts-map.js) and
 * the Housing Starts map (starts-map.js) are thin wrappers over this — they
 * differ only in the metric list, the summary file, and how the host tab wires
 * `onSelect` / calls `render(state)`.
 *
 * Shading comes from a per-area summary file ({ geos: { uid: { values: {
 * metric: { v, y } } } } }); geometry from cmaGeo(). A metric's value is the
 * area's newest headline figure.
 */

import { mapCard, quantileChoropleth } from './map.js';
import { cmaGeo, hasCmaGeo } from './geo.js';
import { escapeHtml } from './escape.js';

const NO_DATA_FILL = '#e5e7eb';   // grey — matches the "**" missing-data convention
const LEVEL_NOUN = { zone: 'survey zones', neighbourhood: 'neighbourhoods' };

// Full value for the tooltip; kind ∈ 'usd' | 'pct' | 'int'.
const fmtFull = (kind, v) => !Number.isFinite(v) ? 'No data'
  : kind === 'usd' ? `$${Math.round(v).toLocaleString()}`
  : kind === 'pct' ? `${v.toFixed(1)}%`
  : Math.round(v).toLocaleString();
// Compact value for the legend. Rents/counts stay readable: full dollars, and
// only round to "k" for large plain counts (rental universe, starts totals).
const fmtCompact = (kind, v) => !Number.isFinite(v) ? '**'
  : kind === 'usd' ? `$${Math.round(v).toLocaleString()}`
  : kind === 'pct' ? `${v.toFixed(1)}%`
  : (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

/**
 * @param {Object} opts
 * @param {string}   opts.host        id of the container <section>
 * @param {Object}   opts.geographies geographies index ({ levels }) for app-known uids + CMA names
 * @param {Function} opts.onSelect    (layer, uid) => void — called when a polygon is clicked
 * @param {Array}    opts.metrics     [{ key, label, kind }] — the picker options
 * @param {Function} opts.loadSummary () => Promise<summary> — single-flight per-area summary
 * @param {string}   opts.pickerId    id for the metric <select>
 * @param {string}   opts.source      map source/attribution line
 * @param {string}   opts.filePrefix  PNG filename prefix (e.g. "rental" / "starts")
 * @returns {{ render: (state) => void }}
 */
export function makeZoneChoroplethMap({ host, geographies, onSelect, metrics, loadSummary, pickerId, source, filePrefix }) {
  const $host = document.getElementById(host);
  if (!$host) return { render: () => {} };

  const levels = geographies.levels || {};
  const uidSet = (lvl) => new Set((levels[lvl] || []).map(it => String(it.uid)));
  const appUids = { zone: uidSet('zone'), neighbourhood: uidSet('neighbourhood') };
  const cmaName = (code) => (levels.cma || []).find(it => String(it.uid) === String(code))?.name || `CMA ${code}`;

  const controls = document.createElement('div');
  controls.className = 'census-map-controls';
  controls.innerHTML = `<label for="${pickerId}" class="text-sm text-neutral-600">Map metric:</label>
    <select id="${pickerId}" class="border border-neutral-300 rounded px-2 py-1 text-sm">
      ${metrics.map(m => `<option value="${escapeHtml(m.key)}">${escapeHtml(m.label)}</option>`).join('')}
    </select>`;
  $host.appendChild(controls);
  const $metric = controls.querySelector(`#${pickerId}`);

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
    const [geojson, summary] = await Promise.all([cmaGeo(t.cma, t.layer), loadSummary()]);
    if (my !== token) return;                        // superseded by a newer render
    if (!geojson) { hide(); return; }
    controls.style.display = '';
    map.card.style.display = '';

    const metric = metrics.find(m => m.key === $metric.value) || metrics[0];
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
      sub: `Shaded by ${metric.label.toLowerCase()} (most recent). Click a ${noun.replace(/s$/, '')} to load it; the dropdowns stay in sync.`,
      source,
      legend,
      filename: `${filePrefix}_map_${t.cma}_${t.layer}_${metric.key}.png`.replace(/\s+/g, '-'),
    });
  }

  return { render };
}
