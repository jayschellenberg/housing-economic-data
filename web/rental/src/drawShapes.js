/*
 * drawShapes.js — the map half of the area filter, ported from the parcel
 * search's drawShapes.js. Three tools with Matrix-MLS conventions and one
 * state machine:
 *   Radius    — click the centre, move, click again to set the radius.
 *   Rectangle — click one corner, then the opposite corner.
 *   Polygon   — click vertices; double-click or click the first vertex
 *               again to close; needs 3+.
 * Esc cancels. A committed shape starts as INCLUDE (green); clicking its
 * centre dot or fill flips it to EXCLUDE (red). The eraser clears all.
 *
 * The module only REPORTS shapes (onChange); main.js writes them into the
 * filter state and they flow back through setShapes(), so a Clear in the
 * filter panel also clears the map, and a reload restores them.
 */

import { haversineKm } from './lib/filters.js';
import { circleRing, rectRing, shapesToFc, formatKm } from './lib/shapeFilter.js';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const MODE_COLOR = ['match', ['get', 'mode'], 'exclude', '#c62828', '#2e7d32'];

export function initDrawShapes(map, { onChange } = {}) {
  const $ = (id) => document.getElementById(id);
  const buttons = {
    circle: $('shape-tool-circle'), rectangle: $('shape-tool-rectangle'), polygon: $('shape-tool-polygon'),
  };
  const $clear = $('shape-tool-clear');
  const $readout = $('shape-readout');

  let shapes = [];
  let nextId = 1;
  let armed = null;       // 'circle' | 'rectangle' | 'polygon' | null
  let pending = null;
  let layersReady = false;

  function addLayers() {
    map.addSource('shape-filter', { type: 'geojson', data: EMPTY_FC });
    map.addSource('shape-preview', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({ id: 'shape-filter-fill', type: 'fill', source: 'shape-filter', filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': MODE_COLOR, 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'shape-filter-line', type: 'line', source: 'shape-filter', filter: ['==', '$type', 'Polygon'],
      paint: { 'line-color': MODE_COLOR, 'line-width': 2 } });
    map.addLayer({ id: 'shape-filter-dot', type: 'circle', source: 'shape-filter', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-width': 2.5, 'circle-stroke-color': MODE_COLOR } });
    map.addLayer({ id: 'shape-filter-label', type: 'symbol', source: 'shape-filter', filter: ['==', '$type', 'Point'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 12, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': ['match', ['get', 'mode'], 'exclude', '#8b1c1c', '#1d5a22'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'shape-preview-line', type: 'line', source: 'shape-preview',
      paint: { 'line-color': '#ff4d00', 'line-width': 2, 'line-dasharray': [3, 2] } });
    layersReady = true;
    render();
  }

  function render() {
    if (!layersReady) return;
    map.getSource('shape-filter').setData(shapesToFc(shapes));
  }
  function renderPreview(ring) {
    if (!layersReady) return;
    map.getSource('shape-preview').setData(ring && ring.length >= 2
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } }] }
      : EMPTY_FC);
  }
  function showReadout(point, km) {
    if (!$readout) return;
    $readout.textContent = formatKm(km);
    $readout.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
    $readout.hidden = false;
  }
  function hideReadout() { if ($readout) $readout.hidden = true; }

  function syncButtons() {
    for (const [tool, b] of Object.entries(buttons)) b?.setAttribute('aria-pressed', String(armed === tool));
    if ($clear) $clear.disabled = shapes.length === 0 && !pending;
  }
  function cancelPending() { pending = null; renderPreview(null); hideReadout(); }
  function setArmed(tool) {
    cancelPending();
    armed = armed === tool ? null : tool;
    map.getCanvas().style.cursor = armed ? 'crosshair' : '';
    if (armed === 'polygon') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    syncButtons();
  }
  function emit() { onChange?.(shapes.map((s) => ({ ...s }))); }
  function commit(shape) {
    shapes.push({ id: nextId++, mode: 'include', ...shape });
    cancelPending();
    setArmed(null);
    render(); emit();
  }

  function tryToggleAt(point) {
    if (!layersReady) return false;
    const feats = map.queryRenderedFeatures(point, { layers: ['shape-filter-dot', 'shape-filter-fill'] });
    if (!feats.length) return false;
    const s = shapes.find((x) => x.id === feats[0].properties?.id);
    if (!s) return false;
    s.mode = s.mode === 'include' ? 'exclude' : 'include';
    render(); emit();
    return true;
  }

  /** Map click. Returns true when this module consumed the click. */
  function handleClick(e) {
    if (!armed) return tryToggleAt(e.point);
    const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    if (armed === 'circle') {
      if (!pending) pending = { center: pt };
      else {
        const radiusKm = haversineKm(pending.center.lat, pending.center.lng, pt.lat, pt.lng);
        if (radiusKm > 0) commit({ kind: 'circle', center: pending.center, radiusKm });
      }
    } else if (armed === 'rectangle') {
      if (!pending) pending = { corner: pt };
      else if (pt.lng !== pending.corner.lng || pt.lat !== pending.corner.lat) commit({ kind: 'rectangle', ring: rectRing(pending.corner, pt) });
    } else if (armed === 'polygon') {
      if (!pending) pending = { verts: [] };
      if (pending.verts.length >= 3) {
        const first = map.project([pending.verts[0][0], pending.verts[0][1]]);
        const dx = first.x - e.point.x, dy = first.y - e.point.y;
        if (dx * dx + dy * dy <= 144) { commit({ kind: 'polygon', ring: [...pending.verts] }); return true; }
      }
      pending.verts.push([pt.lng, pt.lat]);
      renderPreview([...pending.verts]);
    }
    syncButtons();
    return true;
  }

  function handleDblClick(e) {
    if (armed !== 'polygon' || !pending) return false;
    e.preventDefault();
    const verts = pending.verts.slice(0, -1);   // the dblclick's two clicks pushed the same vertex twice
    if (verts.length >= 3) commit({ kind: 'polygon', ring: verts }); else cancelPending();
    return true;
  }

  function handleMouseMove(e) {
    if (!armed || !pending) return;
    const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    if (armed === 'circle' && pending.center) {
      const km = haversineKm(pending.center.lat, pending.center.lng, pt.lat, pt.lng);
      renderPreview(circleRing(pending.center, km));
      showReadout(e.point, km);
    } else if (armed === 'rectangle' && pending.corner) {
      renderPreview(rectRing(pending.corner, pt));
    } else if (armed === 'polygon' && pending.verts?.length) {
      renderPreview([...pending.verts, [pt.lng, pt.lat]]);
    }
  }

  for (const [tool, b] of Object.entries(buttons)) b?.addEventListener('click', () => setArmed(tool));
  $clear?.addEventListener('click', () => {
    if (!shapes.length && !pending) return;
    shapes = [];
    cancelPending();
    if (armed) setArmed(armed);   // disarm
    render(); emit(); syncButtons();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) setArmed(armed); });
  map.on('mousemove', handleMouseMove);
  map.on('dblclick', handleDblClick);
  syncButtons();

  return {
    addLayers,
    handleClick,
    isArmed: () => armed != null,
    /** Sync from the filter state without re-emitting. */
    setShapes(next) {
      const incoming = Array.isArray(next) ? next : [];
      const same = incoming.length === shapes.length && incoming.every((s, i) => JSON.stringify(s) === JSON.stringify(shapes[i]));
      if (same) return;
      shapes = incoming.map((s) => ({ ...s }));
      nextId = shapes.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1;
      render(); syncButtons();
    },
    getShapes: () => shapes.map((s) => ({ ...s })),
  };
}
