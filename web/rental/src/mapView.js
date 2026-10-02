/*
 * mapView.js — the listings map.
 *
 * MapLibre GL rendering the same self-hosted Protomaps (OpenStreetMap)
 * archive the parcel search and the R dashboard use: one .pmtiles file on
 * the mb-ortho R2 bucket, styled in the browser by @protomaps/basemaps.
 * No API key, no vendor tile quota. The archive is maintained by the
 * parcel-search project (its MAINTENANCE.md §7b); this app must not fork it.
 *
 * On top of the basemap, bottom to top:
 *   - municipality polygons: a fill that is invisible until hovered /
 *     selected / adjacent (feature-state, keyed by muni_no) so the picker's
 *     selection reads on the map, plus toggleable outlines + labels; with
 *     "Select by clicking the map" on, a click toggles the municipality in
 *     the picker — the reverse direction;
 *   - the MLS-area and neighbourhood overlays (toggleable);
 *   - the subject radius, the listings (circles by bedroom band, click
 *     popup), and the drawn area shapes (drawShapes.js) on top.
 *
 * One general click handler routes a click by priority — a drawing tool,
 * then an armed subject placement, then a shape toggle, then (with a
 * select mode on) the municipality / MLS-area toggle, then a cluster
 * zoom or a listing popup — so one click never does two things. Hovering
 * a listing shows its details without a click.
 */

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre ≥ 5 runs tile work in a worker loaded from a sibling module
// file. Left to itself the built chunk asks for "maplibre-gl-worker.mjs"
// beside it, which no build step ever copies (404 on Vercel, map stuck
// before "load" with no error). Importing the file's URL through Vite
// makes it a real hashed asset in production and the node_modules path
// in dev; setWorkerUrl points MapLibre at it either way.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';
import { bedroomBand, BEDROOM_BANDS } from './lib/filters.js';
import { BAND_COLORS, BAND_LABELS } from './lib/bands.js';
import { exportMapPng } from './exports.js';
import { initSubjectFind } from '../../src/subject-find.js';
import { initDrawShapes } from './drawShapes.js';

export { BAND_COLORS };

maplibregl.setWorkerUrl(maplibreWorkerUrl);
maplibregl.addProtocol('pmtiles', new PMTilesProtocol().tile);

const BASEMAP_PMTILES_URL = import.meta.env?.VITE_BASEMAP_PMTILES_URL
  || 'https://pub-091058079bf6458da1681945177e1682.r2.dev/basemap-manitoba.pmtiles';

const MB_BOUNDS = [[-102.5, 48.5], [-88.5, 60.5]];
const DEFAULT_CENTER = [-97.14, 49.9];
const DEFAULT_ZOOM = 10;

// Clustering (like the Leaflet marker clusters on the admin dashboard):
// points merge into count bubbles until this zoom, then draw singly.
const CLUSTER_MAX_ZOOM = 12;
const CLUSTER_RADIUS = 48;
const CLUSTER_KEY = 'mbre_map_cluster';

const OVERLAYS = [
  { key: 'munis', file: 'data/municipalities.geojson', color: '#1e293b', minzoom: 0, labelMinzoom: 7, promoteId: 'muni_no' },
  { key: 'mls', file: 'data/mls-areas.geojson', color: '#b45309', minzoom: 7, labelMinzoom: 9, promoteId: 'name' },
  { key: 'nbhds', file: 'data/wpg-neighbourhoods.geojson', color: '#0e7490', minzoom: 9, labelMinzoom: 11 },
];

const SEL = ['boolean', ['feature-state', 'selected'], false];
const ADJ = ['boolean', ['feature-state', 'adjacent'], false];
const HOV = ['boolean', ['feature-state', 'hover'], false];

function streetsLayers() {
  return protomapsLayers('protomaps', namedFlavor('light'), { lang: 'en' }).map((layer) => {
    const remapped = JSON.parse(JSON.stringify(layer).replaceAll('"Noto Sans Medium"', '"Open Sans Semibold"'));
    return { ...remapped, id: `pm-${layer.id}` };
  });
}

function buildStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sprite: `${window.location.origin}/basemap-sprites/light`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${BASEMAP_PMTILES_URL}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: streetsLayers(),
  };
}

/** 64-point ring approximating a circle of `km` around [lng, lat]. */
export function circleRing(lng, lat, km, n = 64) {
  const R = 6371.0088;
  const latR = (lat * Math.PI) / 180;
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const dLat = (km / R) * Math.cos(t);
    const dLng = (km / R) * Math.sin(t) / Math.cos(latR);
    ring.push([lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
  }
  return ring;
}

function rowsToGeoJSON(rows, bands) {
  const features = [];
  for (const l of rows) {
    if (l.lat == null || l.lng == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
      properties: {
        id: l.id,
        band: bedroomBand(l.bedrooms, bands) || 'unknown',
        rent: l.rent, beds: l.bedrooms, sqft: l.sqft,
        address: l.address || l.title || '', title: l.title || '',
        source: l.source, url: l.url,
        area: l.geo_neighborhood || l.geo_mls_area || l.geo_municipality || '',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function initMapView({ container, onSubjectChange, onMuniToggle, onMlsToggle, onShapesChange, getBands, getMuniIndex, lookupSubject } = {}) {
  const $ = (id) => document.getElementById(id);
  const $card = $('map-card');
  const $legend = $('map-legend');
  const $subjectBtn = $('subject-set');
  const $subjectClear = $('subject-clear');
  const $subjectLabel = $('subject-label');
  const $radius = $('subject-radius');
  const $fit = $('map-fit');
  const $hide = $('map-toggle-btn');
  const $expand = $('map-expand-btn');
  const $muniPill = $('muni-click-pill');

  let rows = [];
  let subject = null;
  let subjectName = '';           // the address it was found by, if any
  let marker = null;
  let armed = false;             // subject placement
  let clickMode = 'off';         // 'off' | 'munis' | 'mls' — what a map click selects
  let loaded = false;
  let hovered = null;            // { key, id } feature currently hover-tinted
  let clustering = true;
  let hoverPopup = null;
  try { clustering = localStorage.getItem(CLUSTER_KEY) !== '0'; } catch { /* default on */ }
  const $cluster = $('map-cluster');
  if ($cluster) $cluster.checked = clustering;
  // "Table follows map view": on by default (Jason, 2026-09-30), remembered.
  // While on, the table / count line / analysis narrow to the viewport
  // (main.js applies it after the filters). A sidebar filter change still
  // zooms to the results, so the table never comes up empty for a filter
  // aimed off-screen; that only moves the map, so nothing chases anything.
  const FOLLOW_KEY = 'mbre_map_follow';
  let following = true;
  try { following = localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { /* default on */ }
  const $follow = $('map-follow');
  if ($follow) $follow.checked = following;
  const viewListeners = new Set();
  let moveTimer = null;
  const pendingOnLoad = [];

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    maxBounds: [[-110, 44], [-80, 64]],
    attributionControl: { compact: true },
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  let warned = false;
  map.on('error', (e) => {
    if (warned) return;
    warned = true;
    console.warn('map error', e?.error?.message || e);
  });

  const whenLoaded = (fn) => (loaded ? fn() : pendingOnLoad.push(fn));
  const draw = initDrawShapes(map, { onChange: (shapes) => onShapesChange?.(shapes) });

  map.on('load', () => {
    loaded = true;
    for (const o of OVERLAYS) {
      map.addSource(`ov-${o.key}`, { type: 'geojson', data: o.file, ...(o.promoteId ? { promoteId: o.promoteId } : {}) });
      if (o.key === 'munis' || o.key === 'mls') {
        // Selection surface: transparent until hovered / selected (/ adjacent
        // for municipalities). Sits under the outline layers.
        const sel = o.key === 'munis' ? '#1d4ed8' : '#b45309';
        map.addLayer({
          id: `ov-${o.key}-fill`, type: 'fill', source: `ov-${o.key}`,
          paint: {
            'fill-color': ['case', SEL, sel, ADJ, '#60a5fa', '#1e293b'],
            'fill-opacity': ['case', SEL, 0.22, ADJ, 0.14, HOV, 0.08, 0],
          },
        });
        map.addLayer({
          id: `ov-${o.key}-sel-line`, type: 'line', source: `ov-${o.key}`,
          paint: {
            'line-color': ['case', SEL, sel, '#60a5fa'],
            'line-width': ['case', SEL, 2.4, 1.6],
            'line-opacity': ['case', SEL, 1, ADJ, 0.9, 0],
          },
        });
      }
      map.addLayer({
        id: `ov-${o.key}-line`, type: 'line', source: `ov-${o.key}`, minzoom: o.minzoom,
        layout: { visibility: 'none' },
        paint: { 'line-color': o.color, 'line-width': 1.2, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: `ov-${o.key}-label`, type: 'symbol', source: `ov-${o.key}`, minzoom: o.labelMinzoom,
        layout: { visibility: 'none', 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'symbol-placement': 'point' },
        paint: { 'text-color': o.color, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
      });
    }
    map.addSource('radius', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    addListingLayers();
    draw.addLayers();

    for (const id of ['listings-pt', 'listings-cluster']) {
      map.on('mouseenter', id, () => { if (!armed && !draw.isArmed()) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { if (!armed && !draw.isArmed()) map.getCanvas().style.cursor = ''; });
    }
    // Hover card: the same details as the click popup minus the link, so
    // the address and rent read without a click. Suppressed while a tool
    // is armed (every mouse move is placing geometry then).
    map.on('mousemove', 'listings-pt', (e) => {
      if (armed || draw.isArmed()) return;
      const f = e.features?.[0];
      if (!f) return;
      if (hoverPopup && hoverPopup._id === f.properties.id) return;
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px', offset: 8, className: 'hover-popup' })
        .setLngLat(f.geometry.coordinates)
        .setDOMContent(popupContent(f.properties, { link: false }))
        .addTo(map);
      hoverPopup._id = f.properties.id;
    });
    map.on('mouseleave', 'listings-pt', () => { hoverPopup?.remove(); hoverPopup = null; });
    for (const key of ['munis', 'mls']) {
      map.on('mousemove', `ov-${key}-fill`, (e) => {
        if (clickMode !== key) return;
        const id = e.features?.[0]?.id;
        if (hovered && hovered.key === key && hovered.id === id) return;
        clearHover();
        if (id != null) { hovered = { key, id }; map.setFeatureState({ source: `ov-${key}`, id }, { hover: true }); }
      });
      map.on('mouseleave', `ov-${key}-fill`, clearHover);
    }
    // A POI icon the copied sprite lacks would otherwise warn on every
    // tile; a transparent 1×1 stand-in keeps the console quiet.
    map.on('styleimagemissing', (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    for (const fn of pendingOnLoad.splice(0)) fn();
  });

  map.on('click', (e) => {
    if (draw.handleClick(e)) return;
    if (armed) {
      armed = false;
      $subjectBtn.setAttribute('aria-pressed', 'false');
      map.getCanvas().style.cursor = '';
      setSubject({ lat: e.lngLat.lat, lng: e.lngLat.lng }, { emit: true });
      return;
    }
    if (!loaded) return;
    // With a select mode on, the area under the click wins over bubbles
    // and popups — the user asked for clicks to pick areas.
    if (clickMode === 'munis' || clickMode === 'mls') {
      const m = map.queryRenderedFeatures(e.point, { layers: [`ov-${clickMode}-fill`] });
      const name = m[0]?.properties?.name;
      if (name) { (clickMode === 'munis' ? onMuniToggle : onMlsToggle)?.(name); return; }
    }
    // A cluster bubble zooms in far enough to break it apart.
    const clusters = map.queryRenderedFeatures(e.point, { layers: ['listings-cluster'] });
    if (clusters.length) {
      const f = clusters[0];
      map.getSource('listings').getClusterExpansionZoom(f.properties.cluster_id)
        .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z, 16), duration: 400 }))
        .catch(() => {});
      return;
    }
    const pts = map.queryRenderedFeatures(e.point, { layers: ['listings-pt'] });
    if (pts.length) {
      const f = pts[0];
      hoverPopup?.remove(); hoverPopup = null;
      new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(f.geometry.coordinates)
        .setDOMContent(popupContent(f.properties))
        .addTo(map);
      return;
    }
  });

  function clearHover() {
    if (hovered) map.setFeatureState({ source: `ov-${hovered.key}`, id: hovered.id }, { hover: false });
    hovered = null;
  }

  /**
   * The listings source + its three layers. Clustering is a SOURCE option,
   * so toggling it means rebuilding the source; the current data is kept
   * and re-applied. Layers go just under the drawn shapes.
   */
  let listingsData = { type: 'FeatureCollection', features: [] };
  function addListingLayers() {
    const before = map.getLayer('shape-filter-fill') ? 'shape-filter-fill' : undefined;
    map.addSource('listings', {
      type: 'geojson', data: listingsData,
      cluster: clustering, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: CLUSTER_RADIUS,
    });
    map.addLayer({
      id: 'listings-cluster', type: 'circle', source: 'listings', filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#fde68a', 50, '#fbbf24', 200, '#f59e0b', 800, '#ea580c'],
        'circle-radius': ['step', ['get', 'point_count'], 14, 50, 18, 200, 23, 800, 28, 5000, 32],
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    }, before);
    map.addLayer({
      id: 'listings-cluster-count', type: 'symbol', source: 'listings', filter: ['has', 'point_count'],
      // The exact count ("3,312"), not MapLibre's abbreviated "3.3k".
      layout: { 'text-field': ['number-format', ['get', 'point_count'], { 'min-fraction-digits': 0, 'max-fraction-digits': 0 }], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'text-allow-overlap': true },
      paint: { 'text-color': '#1a1a1a' },
    }, before);
    map.addLayer({
      id: 'listings-pt', type: 'circle', source: 'listings', filter: ['!', ['has', 'point_count']],
      paint: {
        // 50% larger than the first cut (2.5 / 4.5 / 7).
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.75, 12, 6.75, 15, 10.5],
        'circle-color': ['match', ['get', 'band'],
          'studio', BAND_COLORS.studio, '1br', BAND_COLORS['1br'], '2br', BAND_COLORS['2br'],
          '3br', BAND_COLORS['3br'], '4plus', BAND_COLORS['4plus'], BAND_COLORS.unknown],
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 0.8,
      },
    }, before);
  }
  function setClustering(on) {
    clustering = Boolean(on);
    try { localStorage.setItem(CLUSTER_KEY, clustering ? '1' : '0'); } catch { /* ignore */ }
    whenLoaded(() => {
      for (const id of ['listings-pt', 'listings-cluster-count', 'listings-cluster']) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource('listings')) map.removeSource('listings');
      addListingLayers();
    });
  }
  $cluster?.addEventListener('change', () => setClustering($cluster.checked));

  function currentBounds() {
    const b = map.getBounds();
    return { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
  }
  // A hidden map narrows nothing: with Hide Map on, the table lists every
  // filtered listing (as on the Commercial dashboard).
  function notifyView() {
    const on = following && !$card.hidden;
    for (const cb of viewListeners) cb(on ? currentBounds() : null);
  }
  $follow?.addEventListener('change', () => {
    following = $follow.checked;
    try { localStorage.setItem(FOLLOW_KEY, following ? '1' : '0'); } catch { /* ignore */ }
    notifyView();
  });
  map.on('moveend', () => {
    if (!following) return;
    // Hiding the map (Analysis tab, Hide Map) collapses the container and
    // fires a move with a degenerate viewport — never narrow on that.
    if (!map.getContainer().clientWidth || !map.getContainer().clientHeight) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(notifyView, 250);   // let a fling settle before re-filtering
  });

  function popupContent(p, { link = true } = {}) {
    const div = document.createElement('div');
    div.className = 'map-popup';
    const h = document.createElement('strong'); h.textContent = p.address || '(no address)';
    const line1 = document.createElement('div');
    const rent = p.rent != null && p.rent !== '' ? `$${Number(p.rent).toLocaleString('en-CA')}` : 'no rent';
    const beds = p.beds != null && p.beds !== '' ? (Number(p.beds) === 0 ? 'Studio' : `${p.beds} BR`) : '';
    const sqft = p.sqft != null && p.sqft !== '' && Number(p.sqft) > 0 ? ` · ${Number(p.sqft).toLocaleString('en-CA')} sf` : '';
    line1.textContent = [rent, beds].filter(Boolean).join(' · ') + sqft;
    const line2 = document.createElement('div'); line2.className = 'muted';
    line2.textContent = [p.area, p.source].filter(Boolean).join(' · ');
    div.append(h, line1, line2);
    if (link && p.url) {
      const a = document.createElement('a');
      a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open listing ↗';
      div.appendChild(a);
    }
    return div;
  }

  // ---- legend ---------------------------------------------------------
  function renderLegend() {
    $legend.textContent = '';
    for (const key of [...BEDROOM_BANDS.map((b) => b.key), 'unknown']) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span'); sw.className = 'legend-swatch'; sw.style.background = BAND_COLORS[key];
      item.append(sw, document.createTextNode(BAND_LABELS[key]));
      $legend.appendChild(item);
    }
  }
  renderLegend();

  // ---- overlays -------------------------------------------------------
  // Each checkbox owns EVERY line of its layer: for municipalities that
  // includes the selection tint and outline, so an unticked box really
  // does clear the map (the filter still applies). States are remembered.
  const OVERLAY_KEY = 'mbre_map_overlays';
  let overlayState = { munis: true, mls: false, nbhds: false };
  try { overlayState = { ...overlayState, ...(JSON.parse(localStorage.getItem(OVERLAY_KEY) || '{}')) }; } catch { /* defaults */ }
  function applyOverlay(key) {
    const on = Boolean(overlayState[key]);
    const ids = [`ov-${key}-line`, `ov-${key}-label`, ...(key === 'munis' || key === 'mls' ? [`ov-${key}-fill`, `ov-${key}-sel-line`] : [])];
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  for (const o of OVERLAYS) {
    const cb = $(`ov-${o.key}`);
    if (!cb) continue;
    cb.checked = Boolean(overlayState[o.key]);
    cb.addEventListener('change', () => {
      overlayState[o.key] = cb.checked;
      try { localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlayState)); } catch { /* ignore */ }
      whenLoaded(() => applyOverlay(o.key));
    });
  }
  whenLoaded(() => { for (const o of OVERLAYS) applyOverlay(o.key); });

  // ---- click-to-select mode (municipalities / MLS areas) ----------------
  $muniPill?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    clickMode = b.dataset.mode;
    for (const x of $muniPill.querySelectorAll('[data-mode]')) {
      const on = x.dataset.mode === clickMode;
      x.setAttribute('aria-pressed', String(on));
      x.classList.toggle('active', on);
    }
    // Click targets need their outlines; turn that layer on with the mode.
    const cb = clickMode === 'munis' ? $('ov-munis') : clickMode === 'mls' ? $('ov-mls') : null;
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    clearHover();
  });

  let paintedIds = new Set();
  function setMuniSelection(effectiveNames, pickedNames) {
    whenLoaded(() => {
      const index = getMuniIndex?.();
      if (!index) return;
      const picked = new Set(pickedNames || []);
      const eff = new Set(effectiveNames || []);
      const next = new Set();
      for (const name of eff) {
        const no = index.byName.get(name)?.muni_no;
        if (!no) continue;
        next.add(no);
        map.setFeatureState({ source: 'ov-munis', id: no }, { selected: picked.has(name), adjacent: !picked.has(name) });
      }
      for (const no of paintedIds) if (!next.has(no)) map.setFeatureState({ source: 'ov-munis', id: no }, { selected: false, adjacent: false });
      paintedIds = next;
    });
  }
  let paintedMls = new Set();
  function setMlsSelection(names) {
    whenLoaded(() => {
      const next = new Set(names || []);
      for (const n of next) map.setFeatureState({ source: 'ov-mls', id: n }, { selected: true });
      for (const n of paintedMls) if (!next.has(n)) map.setFeatureState({ source: 'ov-mls', id: n }, { selected: false });
      paintedMls = next;
    });
  }

  // ---- subject --------------------------------------------------------
  function radiusKm() { const r = Number($radius.value); return Number.isFinite(r) && r > 0 ? r : 0; }
  function drawRadius() {
    whenLoaded(() => {
      const r = radiusKm();
      const fc = subject && r > 0
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(subject.lng, subject.lat, r)] } }] }
        : { type: 'FeatureCollection', features: [] };
      map.getSource('radius').setData(fc);
    });
  }
  function emitSubject() { onSubjectChange?.(subject ? { lat: subject.lat, lng: subject.lng, radiusKm: radiusKm() } : null); }
  function setSubject(next, { emit = false, name = '' } = {}) {
    subject = next ? { lat: next.lat, lng: next.lng } : null;
    subjectName = subject ? name : '';
    if (subject) {
      if (!marker) {
        marker = new maplibregl.Marker({ color: '#2563eb', draggable: true }).setLngLat([subject.lng, subject.lat]).addTo(map);
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          subject = { lat: ll.lat, lng: ll.lng };
          subjectName = '';
          drawRadius(); renderSubject(); emitSubject();
        });
      } else marker.setLngLat([subject.lng, subject.lat]);
    } else if (marker) { marker.remove(); marker = null; }
    drawRadius(); renderSubject();
    if (emit) emitSubject();
  }
  function renderSubject() {
    $subjectClear.hidden = !subject;
    $subjectLabel.textContent = !subject ? ''
      : subjectName || `${subject.lat.toFixed(5)}, ${subject.lng.toFixed(5)}`;
  }
  $subjectBtn.addEventListener('click', () => {
    armed = !armed;
    $subjectBtn.setAttribute('aria-pressed', String(armed));
    map.getCanvas().style.cursor = armed ? 'crosshair' : '';
  });
  $subjectClear.addEventListener('click', () => { setSubject(null, { emit: true }); finder.clear(); });

  // Find the subject by address or "lat, lng" — the same box as on the
  // Commercial map (src/subject-find.js); main.js resolves the query.
  const finder = initSubjectFind({
    $find: $('subject-find'),
    $suggest: $('subject-suggest'),
    lookup: (q) => (lookupSubject ? lookupSubject(q) : Promise.resolve([])),
    addressLabel: 'address',
    onPick: (h) => {
      setSubject({ lat: h.lat, lng: h.lng }, { emit: true, name: h.label });
      whenLoaded(() => map.easeTo({ center: [h.lng, h.lat], zoom: Math.max(map.getZoom(), 15), duration: 500 }));
    },
  });
  $radius.addEventListener('change', () => { drawRadius(); if (subject) emitSubject(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) { armed = false; $subjectBtn.setAttribute('aria-pressed', 'false'); map.getCanvas().style.cursor = ''; }
  });

  // ---- fit / hide / expand / png --------------------------------------
  function fitToRows() {
    const pts = rows.filter((l) => l.lat != null && l.lng != null);
    if (!pts.length) { map.fitBounds(MB_BOUNDS, { padding: 20, duration: 0 }); return; }
    const lats = pts.map((l) => l.lat).sort((a, b) => a - b);
    const lngs = pts.map((l) => l.lng).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
    const [lo, hi] = pts.length >= 20 ? [0.02, 0.98] : [0, 1];
    map.fitBounds([[q(lngs, lo), q(lats, lo)], [q(lngs, hi), q(lats, hi)]], { padding: 30, maxZoom: 15, duration: 300 });
  }
  $fit.addEventListener('click', fitToRows);
  $('map-png')?.addEventListener('click', async () => {
    const legend = [...BEDROOM_BANDS.map((b) => b.key), 'unknown'].map((k) => ({ label: BAND_LABELS[k], color: BAND_COLORS[k] }));
    await new Promise((r) => (map.loaded() ? r() : map.once('idle', r)));
    await exportMapPng(map, legend);
  });
  function setHidden(hidden) {
    $card.hidden = hidden;
    $hide.setAttribute('aria-pressed', String(hidden));
    $hide.querySelector('.map-toggle-label').textContent = hidden ? 'Show Map' : 'Hide Map';
    const $showBar = $('map-show-bar');
    if ($showBar) $showBar.hidden = !hidden;   // the legend-row buttons hide with the card
    if (!hidden) { $card.classList.remove('expanded'); $expand.setAttribute('aria-pressed', 'false'); }
    try { localStorage.setItem('mbre_map_hidden', hidden ? '1' : '0'); } catch { /* ignore */ }
    if (!hidden) setTimeout(() => { map.resize(); notifyView(); }, 0);
    else notifyView();
  }
  $hide.addEventListener('click', () => setHidden(!$card.hidden));
  $('map-show-btn')?.addEventListener('click', () => setHidden(false));
  $expand.addEventListener('click', () => {
    const expanded = !$card.classList.contains('expanded');
    $card.classList.toggle('expanded', expanded);
    $expand.setAttribute('aria-pressed', String(expanded));
    setTimeout(() => map.resize(), 0);
  });
  try {
    if (localStorage.getItem('mbre_map_hidden') === '1') {
      $card.hidden = true;
      $hide.setAttribute('aria-pressed', 'true');
      $hide.querySelector('.map-toggle-label').textContent = 'Show Map';
      const $showBar = $('map-show-bar');
      if ($showBar) $showBar.hidden = false;
    }
  } catch { /* ignore */ }

  return {
    /**
     * Replace the plotted listings. `fit` zooms to the bulk of them —
     * main.js asks for that on sidebar filter changes, not on changes the
     * user made on the map itself (a drawn shape, a dragged subject),
     * which would yank the view out from under them.
     */
    setRows(next, { fit = false } = {}) {
      rows = next || [];
      whenLoaded(() => {
        listingsData = rowsToGeoJSON(rows, getBands?.());
        map.getSource('listings').setData(listingsData);
        if (fit && rows.length) fitToRows();
      });
    },
    setClustering,
    /** Subscribe to viewport changes while "follows map view" is on; the
     *  callback gets {w,s,e,n} or null when following is off. */
    onViewChange(cb) { viewListeners.add(cb); },
    isFollowing: () => following,
    getBounds: currentBounds,
    setSubject(next, radius) {
      if (radius != null && radius !== '' && Number(radius) !== Number($radius.value)) $radius.value = String(radius);
      const same = (!next && !subject) || (next && subject && next.lat === subject.lat && next.lng === subject.lng);
      if (!same) setSubject(next); else drawRadius();
    },
    setMuniSelection,
    setMlsSelection,
    setShapes: (shapes) => whenLoaded(() => draw.setShapes(shapes)),
    fit: fitToRows,
    resize: () => map.resize(),
    map,
  };
}
