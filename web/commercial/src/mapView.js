/*
 * mapView.js — the listings map.
 *
 * MapLibre GL rendering the same self-hosted Protomaps (OpenStreetMap)
 * archive the parcel search and the rental explorer use: one .pmtiles
 * file on the mb-ortho R2 bucket, styled in the browser by
 * @protomaps/basemaps. No API key, no vendor tile quota. The archive is
 * maintained by the parcel-search project; this app must not fork it.
 *
 * On top of the basemap, bottom to top:
 *   - municipality and Winnipeg-neighbourhood polygons, built by
 *     v3/build_web_overlays.py from the SAME geojsons pass4_spatial
 *     assigns from, so a listing is never drawn inside a polygon the
 *     data says it is not in. A fill stays invisible until hovered or
 *     selected; with "click to select" on, a click toggles that area in
 *     the sidebar picker — the reverse direction;
 *   - the subject radius, the listings (circles by space type, hover and
 *     click popups), and the drawn area shapes on top.
 *
 * One general click handler routes a click by explicit priority — a
 * drawing tool, then an armed subject placement, then (with a select
 * mode on) the area toggle, then a cluster zoom, then a listing popup —
 * so one click never does two things.
 *
 * NOTE FOR CHECKS: the in-app browser pane runs hidden, where
 * requestAnimationFrame never fires and MapLibre therefore never loads
 * its style (a grey canvas, no error). Verify this file with headless
 * Playwright Chromium instead.
 */

// MapLibre 6 dropped the default export (and is the first major without
// the DOM.sanitize XSS advisory that affects every build up to 6.4).
import {
  Map as MapLibreMap, Marker, Popup, NavigationControl, ScaleControl,
  addProtocol, setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre >= 5 runs tile work in a worker loaded from a sibling module
// file. Left to itself the BUILT chunk asks for "maplibre-gl-worker.mjs"
// beside it, which no build step emits — a 404 on Vercel and a map that
// never reaches 'load', with no error. optimizeDeps.exclude fixes only the
// dev server, so this was live and invisible to a check that ran against
// dev. Importing the file's URL through Vite makes it a real hashed asset
// in production and the node_modules path in dev; setWorkerUrl points
// MapLibre at it either way.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';
import { BAND_COLORS, BAND_LABELS, bandOf, legendFor } from './lib/bands.js';
import { askingText, addressOf } from './lib/results.js';
import { sizeOf } from './lib/filters.js';
import { initDrawShapes } from './drawShapes.js';
import { exportMapPng } from './exports.js';

export { BAND_COLORS };

setWorkerUrl(maplibreWorkerUrl);
addProtocol('pmtiles', new PMTilesProtocol().tile);

const BASEMAP_PMTILES_URL = import.meta.env?.VITE_BASEMAP_PMTILES_URL
  || 'https://pub-091058079bf6458da1681945177e1682.r2.dev/basemap-manitoba.pmtiles';

const MB_BOUNDS = [[-102.5, 48.5], [-88.5, 60.5]];
const DEFAULT_CENTER = [-97.14, 49.9];
const DEFAULT_ZOOM = 10;

// Points merge into count bubbles until this zoom, then draw singly.
const CLUSTER_MAX_ZOOM = 12;
const CLUSTER_RADIUS = 48;
const CLUSTER_KEY = 'commavail_map_cluster';
const OVERLAY_KEY = 'commavail_map_overlays';

// promoteId makes the name the feature id, which is what feature-state
// (hover / selected tinting) is keyed on and what the picker stores.
const OVERLAYS = [
  { key: 'munis', file: 'data/municipalities.geojson', color: '#1e293b', minzoom: 0, labelMinzoom: 7, promoteId: 'name', selectable: true, sel: '#1d4ed8' },
  // Winnipeg's 23 community clusters — the neighbourhoods dissolved, by
  // build_web_overlays.py. Coarser than nbhds, so it labels a zoom earlier.
  // blue-800: dark enough not to read as an Office dot (#2a78d6) or the
  // subject radius (#2563eb), both of which are drawn over this layer.
  { key: 'clusters', file: 'data/wpg-clusters.geojson', color: '#1e40af', minzoom: 8, labelMinzoom: 10, promoteId: 'name', selectable: true, sel: '#1e40af' },
  { key: 'nbhds', file: 'data/wpg-neighbourhoods.geojson', color: '#0e7490', minzoom: 9, labelMinzoom: 11, promoteId: 'name', selectable: true, sel: '#0e7490' },
];

const SEL = ['boolean', ['feature-state', 'selected'], false];
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

export function rowsToGeoJSON(rows) {
  const features = [];
  for (const r of rows || []) {
    if (r.latitude == null || r.longitude == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
      properties: {
        id: r.listing_id,
        band: bandOf(r),
        address: addressOf(r),
        unit: r.unit || '',
        asking: askingText(r),
        size: sizeOf(r) ?? '',
        listing_type: r.listing_type || '',
        status: r.status || '',
        brokerage: r.brokerage || '',
        area: r.neighbourhood || r.municipality || r.city || '',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Fit to the 2nd-98th percentile of the points, not the extremes: the
 * tracker carries a handful of correctly-geocoded listings in
 * Saskatchewan and Ontario, and fitting to those would show the reader
 * half of Canada with Winnipeg as a dot.
 */
export function percentileBounds(points) {
  const pts = (points || []).filter((p) => p.lat != null && p.lng != null);
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat).sort((a, b) => a - b);
  const lngs = pts.map((p) => p.lng).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  const [lo, hi] = pts.length >= 20 ? [0.02, 0.98] : [0, 1];
  return [[q(lngs, lo), q(lats, lo)], [q(lngs, hi), q(lats, hi)]];
}

export function initMapView({
  container, onAreaToggle, onShapesChange, onSubjectChange, lookupSubject,
} = {}) {
  const $ = (id) => document.getElementById(id);
  const $card = $('map-card');
  const $legend = $('map-legend');
  const $fit = $('map-fit');
  const $modePill = $('map-click-pill');
  const $subjectBtn = $('subject-set');
  const $subjectClear = $('subject-clear');
  const $subjectLabel = $('subject-label');
  const $radius = $('subject-radius');

  let rows = [];
  let loaded = false;
  let armed = false;              // subject placement
  let clickMode = 'off';          // 'off' | 'munis' | 'clusters' | 'nbhds'
  let hovered = null;
  let hoverPopup = null;
  let subject = null;
  let subjectName = '';           // the address it was found by, if any
  let marker = null;
  let clustering = true;
  try { clustering = localStorage.getItem(CLUSTER_KEY) !== '0'; } catch { /* default on */ }
  const $cluster = $('map-cluster');
  if ($cluster) $cluster.checked = clustering;
  const pendingOnLoad = [];

  const map = new MapLibreMap({
    container,
    style: buildStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: { compact: true },
    preserveDrawingBuffer: true,   // so a PNG export can read the canvas
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

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
      map.addSource(`ov-${o.key}`, { type: 'geojson', data: o.file, promoteId: o.promoteId });
      if (o.selectable) {
        map.addLayer({
          id: `ov-${o.key}-fill`, type: 'fill', source: `ov-${o.key}`,
          paint: {
            'fill-color': ['case', SEL, o.sel, '#1e293b'],
            'fill-opacity': ['case', SEL, 0.22, HOV, 0.08, 0],
          },
        });
        map.addLayer({
          id: `ov-${o.key}-sel-line`, type: 'line', source: `ov-${o.key}`,
          paint: {
            'line-color': o.sel,
            'line-width': ['case', SEL, 2.4, 1.6],
            'line-opacity': ['case', SEL, 1, 0],
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
        layout: {
          visibility: 'none', 'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'], 'text-size': 11, 'symbol-placement': 'point',
        },
        paint: { 'text-color': o.color, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
      });
    }

    map.addSource('radius', { type: 'geojson', data: emptyFc() });
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-dasharray': [3, 2] } });

    addListingLayers();
    draw.addLayers();

    for (const id of ['listings-pt', 'listings-cluster']) {
      map.on('mouseenter', id, () => { if (!armed && !draw.isArmed()) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { if (!armed && !draw.isArmed()) map.getCanvas().style.cursor = ''; });
    }

    // Hover card: the same details as the click popup, so the address and
    // asking read without a click. Suppressed while a tool is armed —
    // every mouse move is placing geometry then.
    map.on('mousemove', 'listings-pt', (e) => {
      if (armed || draw.isArmed()) return;
      const f = e.features?.[0];
      if (!f) return;
      if (hoverPopup && hoverPopup._id === f.properties.id) return;
      hoverPopup?.remove();
      hoverPopup = new Popup({
        closeButton: false, closeOnClick: false, maxWidth: '280px', offset: 8, className: 'hover-popup',
      }).setLngLat(f.geometry.coordinates).setDOMContent(popupContent(f.properties)).addTo(map);
      hoverPopup._id = f.properties.id;
    });
    map.on('mouseleave', 'listings-pt', () => { hoverPopup?.remove(); hoverPopup = null; });

    for (const o of OVERLAYS.filter((x) => x.selectable)) {
      map.on('mousemove', `ov-${o.key}-fill`, (e) => {
        if (clickMode !== o.key) return;
        const id = e.features?.[0]?.id;
        if (hovered && hovered.key === o.key && hovered.id === id) return;
        clearHover();
        if (id != null) { hovered = { key: o.key, id }; map.setFeatureState({ source: `ov-${o.key}`, id }, { hover: true }); }
      });
      map.on('mouseleave', `ov-${o.key}-fill`, clearHover);
    }

    // A POI icon the copied sprite lacks would otherwise warn on every
    // tile; a transparent 1x1 stand-in keeps the console quiet.
    map.on('styleimagemissing', (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });

    for (const o of OVERLAYS) applyOverlay(o.key);
    for (const fn of pendingOnLoad.splice(0)) fn();
  });

  map.on('click', (e) => {
    if (draw.handleClick(e)) return;
    if (armed) {
      armed = false;
      $subjectBtn?.setAttribute('aria-pressed', 'false');
      map.getCanvas().style.cursor = '';
      setSubject({ lat: e.lngLat.lat, lng: e.lngLat.lng }, { emit: true });
      return;
    }
    if (!loaded) return;
    // With a select mode on, the area under the click wins over bubbles
    // and popups — the user asked for clicks to pick areas.
    if (clickMode !== 'off') {
      const hit = map.queryRenderedFeatures(e.point, { layers: [`ov-${clickMode}-fill`] });
      const name = hit[0]?.properties?.name;
      if (name) { onAreaToggle?.(clickMode, name); return; }
    }
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
      new Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(f.geometry.coordinates)
        .setDOMContent(popupContent(f.properties))
        .addTo(map);
    }
  });

  function emptyFc() { return { type: 'FeatureCollection', features: [] }; }

  function clearHover() {
    if (hovered) map.setFeatureState({ source: `ov-${hovered.key}`, id: hovered.id }, { hover: false });
    hovered = null;
  }

  // ---- listings ---------------------------------------------------------
  let listingsData = emptyFc();
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
        'circle-radius': ['step', ['get', 'point_count'], 14, 50, 18, 200, 23, 800, 28],
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    }, before);
    map.addLayer({
      id: 'listings-cluster-count', type: 'symbol', source: 'listings', filter: ['has', 'point_count'],
      // The exact count ("1,018"), not MapLibre's abbreviated "1k".
      layout: {
        'text-field': ['number-format', ['get', 'point_count'], { 'min-fraction-digits': 0, 'max-fraction-digits': 0 }],
        'text-font': ['Open Sans Semibold'], 'text-size': 11, 'text-allow-overlap': true,
      },
      paint: { 'text-color': '#1a1a1a' },
    }, before);
    map.addLayer({
      id: 'listings-pt', type: 'circle', source: 'listings', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.75, 12, 6.75, 15, 10.5],
        'circle-color': ['match', ['get', 'band'],
          'Office', BAND_COLORS.Office, 'Industrial', BAND_COLORS.Industrial,
          'Retail', BAND_COLORS.Retail, 'Land', BAND_COLORS.Land,
          'Investment', BAND_COLORS.Investment, 'Mixed', BAND_COLORS.Mixed,
          BAND_COLORS.unknown],
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
      // Clustering is a SOURCE option, so toggling it rebuilds the source;
      // the current data is kept and re-applied.
      for (const id of ['listings-pt', 'listings-cluster-count', 'listings-cluster']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource('listings')) map.removeSource('listings');
      addListingLayers();
    });
  }
  $cluster?.addEventListener('change', () => setClustering($cluster.checked));

  function popupContent(p) {
    const div = document.createElement('div');
    div.className = 'map-popup';
    const h = document.createElement('strong');
    h.textContent = p.unit ? `${p.address} — ${p.unit}` : p.address;
    const line1 = document.createElement('div');
    const size = p.size !== '' && p.size != null ? `${Number(p.size).toLocaleString('en-CA')} sf` : '';
    line1.textContent = [p.asking || 'no asking price', size].filter(Boolean).join(' · ');
    const line2 = document.createElement('div');
    line2.className = 'muted';
    line2.textContent = [BAND_LABELS[p.band] || p.band, p.listing_type, p.status].filter(Boolean).join(' · ');
    const line3 = document.createElement('div');
    line3.className = 'muted';
    line3.textContent = [p.area, p.brokerage].filter(Boolean).join(' · ');
    div.append(h, line1, line2, line3);
    return div;
  }

  // ---- legend -----------------------------------------------------------
  function renderLegend(forRows) {
    if (!$legend) return;
    $legend.textContent = '';
    for (const item of legendFor(forRows)) {
      const el = document.createElement('span');
      el.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = item.color;
      el.append(sw, document.createTextNode(item.label));
      $legend.appendChild(el);
    }
  }

  // ---- overlays ---------------------------------------------------------
  // Each checkbox owns EVERY line of its layer, selection tint included,
  // so an unticked box really does clear the map. States are remembered.
  let overlayState = { munis: true, clusters: false, nbhds: false };
  try { overlayState = { ...overlayState, ...(JSON.parse(localStorage.getItem(OVERLAY_KEY) || '{}')) }; } catch { /* defaults */ }
  function applyOverlay(key) {
    const o = OVERLAYS.find((x) => x.key === key);
    const on = Boolean(overlayState[key]);
    const ids = [`ov-${key}-line`, `ov-${key}-label`, ...(o?.selectable ? [`ov-${key}-fill`, `ov-${key}-sel-line`] : [])];
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

  // ---- click-to-select --------------------------------------------------
  $modePill?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    clickMode = b.dataset.mode;
    for (const x of $modePill.querySelectorAll('[data-mode]')) {
      const on = x.dataset.mode === clickMode;
      x.setAttribute('aria-pressed', String(on));
      x.classList.toggle('active', on);
    }
    // Click targets need their outlines; turn that layer on with the mode.
    const cb = clickMode === 'off' ? null : $(`ov-${clickMode}`);
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    clearHover();
  });

  const painted = { munis: new Set(), clusters: new Set(), nbhds: new Set() };
  function setAreaSelection(key, names) {
    whenLoaded(() => {
      const next = new Set(names || []);
      for (const n of next) map.setFeatureState({ source: `ov-${key}`, id: n }, { selected: true });
      for (const n of painted[key]) {
        if (!next.has(n)) map.setFeatureState({ source: `ov-${key}`, id: n }, { selected: false });
      }
      painted[key] = next;
    });
  }

  // ---- subject ----------------------------------------------------------
  function radiusKm() {
    const r = Number($radius?.value);
    return Number.isFinite(r) && r > 0 ? r : 0;
  }
  function drawRadius() {
    whenLoaded(() => {
      const r = radiusKm();
      const fc = subject && r > 0
        ? {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [circleRing(subject.lng, subject.lat, r)] },
          }],
        }
        : emptyFc();
      map.getSource('radius')?.setData(fc);
    });
  }
  function emitSubject() {
    onSubjectChange?.(subject ? { lat: subject.lat, lng: subject.lng, radiusKm: radiusKm() } : null);
  }
  function setSubject(next, { emit = false, name = '' } = {}) {
    subject = next ? { lat: next.lat, lng: next.lng } : null;
    subjectName = subject ? name : '';
    if (subject) {
      if (!marker) {
        marker = new Marker({ color: '#2563eb', draggable: true })
          .setLngLat([subject.lng, subject.lat]).addTo(map);
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          subject = { lat: ll.lat, lng: ll.lng };
          // Dragged off the address it was found by, the pin is no longer
          // AT that address — keep the name and the label would lie.
          subjectName = '';
          drawRadius(); renderSubject(); emitSubject();
        });
      } else marker.setLngLat([subject.lng, subject.lat]);
    } else if (marker) { marker.remove(); marker = null; }
    drawRadius(); renderSubject();
    if (emit) emitSubject();
  }
  function renderSubject() {
    if ($subjectClear) $subjectClear.hidden = !subject;
    if ($subjectLabel) {
      $subjectLabel.textContent = !subject ? ''
        : subjectName || `${subject.lat.toFixed(5)}, ${subject.lng.toFixed(5)}`;
    }
  }
  $subjectBtn?.addEventListener('click', () => {
    armed = !armed;
    $subjectBtn.setAttribute('aria-pressed', String(armed));
    map.getCanvas().style.cursor = armed ? 'crosshair' : '';
  });
  $subjectClear?.addEventListener('click', () => {
    setSubject(null, { emit: true });
    if ($find) $find.value = '';
  });

  // ---- subject by address ------------------------------------------------
  // What resolves an address is main.js's business (the index is built from
  // the bundle, lazily, on first use); this is only the combobox.
  const $find = $('subject-find');
  const $suggest = $('subject-suggest');
  let hits = [];
  let active = -1;
  let seq = 0;

  function closeSuggest() {
    if ($suggest) $suggest.hidden = true;
    $find?.setAttribute('aria-expanded', 'false');
    $find?.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function paintSuggest(message) {
    if (!$suggest) return;
    $suggest.textContent = '';
    if (!hits.length) {
      if (!message) { closeSuggest(); return; }
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = message;
      $suggest.appendChild(li);
    }
    hits.forEach((h, i) => {
      const li = document.createElement('li');
      li.id = `subject-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const name = document.createElement('span');
      name.textContent = h.label;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = h.source === 'address' ? 'Winnipeg address'
        : h.source === 'coordinates' ? 'coordinates' : (h.where || 'listing');
      li.append(name, where);
      // mousedown, not click: a click fires after the input's blur, and the
      // blur would already have closed the list it landed on.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(h); });
      $suggest.appendChild(li);
    });
    $suggest.hidden = false;
    $find.setAttribute('aria-expanded', 'true');
    if (active >= 0) $find.setAttribute('aria-activedescendant', `subject-opt-${active}`);
    else $find.removeAttribute('aria-activedescendant');
  }

  function pick(h) {
    closeSuggest();
    if ($find) $find.value = h.label;
    setSubject({ lat: h.lat, lng: h.lng }, { emit: true, name: h.label });
    whenLoaded(() => map.easeTo({
      center: [h.lng, h.lat], zoom: Math.max(map.getZoom(), 15), duration: 500,
    }));
  }

  async function refresh() {
    const q = ($find?.value || '').trim();
    const mine = ++seq;
    if (q.length < 2) { hits = []; closeSuggest(); return; }
    if ($find && !lookupSubject) return;
    const found = await lookupSubject(q);
    if (mine !== seq) return;          // a later keystroke already answered
    hits = found || [];
    active = hits.length ? 0 : -1;
    paintSuggest(/\d/.test(q) ? 'No address or listing by that number here'
      : 'Start with the civic number, or paste lat, lng');
  }

  let timer = null;
  $find?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  $find?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      paintSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (hits.length) pick(hits[Math.max(0, active)]);
      else refresh();
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });
  $find?.addEventListener('blur', () => setTimeout(closeSuggest, 0));
  $find?.addEventListener('focus', () => { if (hits.length) paintSuggest(); });
  $radius?.addEventListener('change', () => { drawRadius(); if (subject) emitSubject(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) {
      armed = false;
      $subjectBtn?.setAttribute('aria-pressed', 'false');
      map.getCanvas().style.cursor = '';
    }
  });

  // ---- fit --------------------------------------------------------------
  function fitToRows() {
    const bounds = percentileBounds(rows.map((r) => ({ lat: r.latitude, lng: r.longitude })));
    if (!bounds) { map.fitBounds(MB_BOUNDS, { padding: 20, duration: 0 }); return; }
    map.fitBounds(bounds, { padding: 30, maxZoom: 15, duration: 300 });
  }
  $fit?.addEventListener('click', fitToRows);
  $('map-png')?.addEventListener('click', async () => {
    // Let any in-flight tiles settle first; exportMapPng then forces its
    // own repaint and reads the pixels inside that frame.
    if (!map.loaded()) await new Promise((r) => map.once('idle', r));
    await exportMapPng(map, legendFor(rows));
  });

  return {
    /**
     * Replace the plotted listings. `fit` zooms to the bulk of them —
     * main.js asks for that on sidebar filter changes, not on changes the
     * user made ON the map (a drawn shape, a dragged subject, an area
     * click), which would yank the view out from under them.
     */
    setRows(next, { fit = false } = {}) {
      rows = next || [];
      renderLegend(rows);
      whenLoaded(() => {
        listingsData = rowsToGeoJSON(rows);
        map.getSource('listings')?.setData(listingsData);
        if (fit && rows.length) fitToRows();
      });
    },
    setClustering,
    setAreaSelection,
    setShapes: (shapes) => whenLoaded(() => draw.setShapes(shapes)),
    setSubject(next, radius) {
      if (radius != null && radius !== '' && $radius && Number(radius) !== Number($radius.value)) {
        $radius.value = String(radius);
      }
      const same = (!next && !subject)
        || (next && subject && next.lat === subject.lat && next.lng === subject.lng);
      if (!same) setSubject(next); else drawRadius();
    },
    fit: fitToRows,
    resize: () => map.resize(),
    isLoaded: () => loaded,
    /** How many listings are currently plotted. Checks assert on this
     *  rather than reaching into MapLibre's private source data, which
     *  moved in v6. */
    pointCount: () => listingsData.features.length,
    card: $card,
    map,
  };
}
