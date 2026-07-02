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

// Map a single-geo tab's (geoLevel, geoUid) selection to a draw target. A zone/
// neighbourhood implies its CMA + own layer and outlines itself; a CMA shows its
// zones with nothing outlined; province/CSD → no map.
export function singleGeoTarget(state) {
  const { geoLevel, geoUid } = state || {};
  if (geoLevel === 'zone' || geoLevel === 'neighbourhood') {
    return { cma: String(geoUid).split('-')[0], layer: geoLevel, selectedIds: [String(geoUid)] };
  }
  if (geoLevel === 'cma') return { cma: String(geoUid), layer: 'zone', selectedIds: [] };
  return null;
}

// Map a set of picked comparison areas to a draw target — but ONLY when they all
// sit within a single CMA (else null → the map hides). The compared areas at the
// shown layer are outlined. A province/CSD pick contributes no CMA and is simply
// absent from the map; a picked CMA (with no zones) shows that CMA's zones.
export function comparedAreasTarget(areas) {
  const cmas = new Set();
  for (const a of areas || []) {
    if (a.level === 'zone' || a.level === 'neighbourhood') cmas.add(String(a.uid).split('-')[0]);
    else if (a.level === 'cma') cmas.add(String(a.uid));
  }
  if (cmas.size !== 1) return null;
  const cma = [...cmas][0];
  const hasZone = areas.some(a => a.level === 'zone');
  const hasNbhd = areas.some(a => a.level === 'neighbourhood');
  const layer = hasNbhd && !hasZone ? 'neighbourhood' : 'zone';
  const selectedIds = areas.filter(a => a.level === layer).map(a => String(a.uid));
  return { cma, layer, selectedIds };
}

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
 * @returns {{ draw: (target) => void }}  target = { cma, layer, selectedIds } | null
 */
export function makeZoneChoroplethMap({ host, geographies, onSelect, metrics, loadSummary, pickerId, source, filePrefix, clickHint }) {
  const $host = document.getElementById(host);
  if (!$host) return { draw: () => {} };

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
  let lastTarget = null;
  $metric.addEventListener('change', () => { if (lastTarget) draw(lastTarget); });

  const hide = () => { controls.style.display = 'none'; map.card.style.display = 'none'; };

  // target = { cma, layer, selectedIds } (or null to hide). Callers derive it:
  // single-geo tabs via singleGeoTarget; comparison tabs from their picked areas.
  async function draw(target) {
    lastTarget = target;
    if (!target || !target.cma || !hasCmaGeo(target.cma)) { hide(); return; }
    const { cma, layer, selectedIds = [] } = target;
    const my = ++token;
    const [geojson, summary] = await Promise.all([cmaGeo(cma, layer), loadSummary()]);
    if (my !== token) return;                        // superseded by a newer render
    if (!geojson) { hide(); return; }
    controls.style.display = '';
    map.card.style.display = '';

    const metric = metrics.find(m => m.key === $metric.value) || metrics[0];
    const uids = appUids[layer];
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

    const noun = LEVEL_NOUN[layer];
    const hint = onSelect
      ? (clickHint || `Click a ${noun.replace(/s$/, '')} to load it; the dropdowns stay in sync.`)
      : `The compared ${noun} are outlined.`;
    map.render({
      geojson,
      values,
      selectedIds,
      onSelect: onSelect ? (id) => onSelect(layer, id) : undefined,
      title: `${cmaName(cma)} — ${metric.label} by ${noun}`,
      sub: `Shaded by ${metric.label.toLowerCase()} (most recent). ${hint}`,
      source,
      legend,
      filename: `${filePrefix}_map_${cma}_${layer}_${metric.key}.png`.replace(/\s+/g, '-'),
    });
  }

  return { draw };
}
