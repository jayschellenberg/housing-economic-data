/*
 * Reusable choropleth map card — the map counterpart to buildChartCard.
 *
 * Renders a self-hosted GeoJSON boundary set as an Observable Plot geo mark
 * (inline SVG, no tiles, no external requests — the strict CSP stays intact).
 * The card chrome (title / subtitle / plot / caption / Download-PNG) matches
 * the chart cards exactly, so downloadCard() and the Word/Excel export pipeline
 * treat it like any other chart.
 *
 * A map is both a DISPLAY (polygons shaded by a metric) and a SELECTOR (click a
 * polygon to drive the page). Selection stays in sync with the existing
 * dropdowns because the caller wires onSelect() to the same state it uses.
 */

import { toPng } from 'html-to-image';
import { downloadCard } from './chart.js';
import { escapeHtml } from './escape.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NO_DATA_FILL = '#e5e7eb';   // grey — matches the "**" missing-data convention
const SEL_STROKE    = '#111827';  // near-black outline for the selected polygon
const HOVER_STROKE  = '#111827';  // outline drawn on the area under the pointer
const EXPORT_RATIO  = 3;          // device-pixel scale for crisp PNGs (matches the chart cards)
const CHORO_RAMP    = ['#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'];  // light→dark blue

/**
 * Build a 5-bin quantile choropleth from [{uid, name, value}] rows. `label` and
 * `compact` format a value for the tooltip and the legend respectively. Returns
 * { values, legend } ready for mapCard.render(). Shared by the Census/Housing maps.
 */
export function quantileChoropleth(entries, { label, compact, ramp = CHORO_RAMP } = {}) {
  const fmt = label || ((v) => String(v));
  const cmp = compact || fmt;
  const nums = entries.map(e => e.value).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const values = new Map();
  if (!nums.length) return { values, legend: [{ swatch: NO_DATA_FILL, text: 'No data' }] };
  const q = (p) => nums[Math.min(nums.length - 1, Math.floor(p * nums.length))];
  const breaks = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const binOf = (v) => { let b = 0; for (const br of breaks) { if (v >= br) b++; else break; } return b; };
  for (const e of entries) {
    if (!Number.isFinite(e.value)) continue;
    values.set(String(e.uid), { fill: ramp[binOf(e.value)], label: `${e.name}: ${fmt(e.value)}` });
  }
  const edges = [nums[0], ...breaks, nums[nums.length - 1]];
  const legend = ramp.map((c, i) => ({ swatch: c, text: `${cmp(edges[i])}–${cmp(edges[i + 1])}` }));
  legend.push({ swatch: NO_DATA_FILL, text: 'No data' });
  return { values, legend };
}

// Rasterize an inline <svg> to a PNG data URL directly on a canvas. The map's
// choropleth is hundreds of <path> nodes; html-to-image's per-node style
// inlining would take 20 s+ over that, whereas native canvas rasterization is
// ~1 s. The SVG is pure geometry (no external refs), so the canvas is never
// tainted. Returns { dataUrl, w, h }.
function svgToPng(svgEl, ratio = EXPORT_RATIO) {
  return new Promise((resolve, reject) => {
    const rect = svgEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const xml = new XMLSerializer().serializeToString(svgEl);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * ratio; canvas.height = h * ratio;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/png'), w, h });
    };
    img.onerror = () => reject(new Error('svg rasterize failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  });
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

// Export the whole card (title / subtitle / map / legend / caption) as a PNG.
// The heavy <svg> is flattened to an <img> first so html-to-image only has to
// capture the lightweight HTML chrome around it — fast, and visually identical.
async function exportMapCard(card, svgEl, filename) {
  let raster;
  try {
    raster = await svgToPng(svgEl);
  } catch (err) {
    console.error('[map export] rasterize failed, falling back', err);
    return downloadCard(card, filename, 'png');   // slow but correct
  }
  const img = document.createElement('img');
  img.src = raster.dataUrl;
  img.style.width = `${raster.w}px`;
  img.style.height = 'auto';
  img.style.maxWidth = '100%';
  svgEl.replaceWith(img);
  card.classList.add('cmhc-exporting');
  try {
    if (img.decode) await img.decode().catch(() => {});
    // Guard the capture so a stalled html-to-image can never strand the card on
    // the static image — the finally always restores the live SVG.
    const url = await Promise.race([
      toPng(card, {
        backgroundColor: '#ffffff', pixelRatio: EXPORT_RATIO, cacheBust: true, skipFonts: true,
        filter: (n) => !(n.classList && (n.classList.contains('chart-actions') || n.classList.contains('cmhc-map-zoom-controls'))),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('export timed out')), 20000)),
    ]);
    triggerDownload(url, filename);
  } catch (err) {
    console.error('[map export]', err);
  } finally {
    card.classList.remove('cmhc-exporting');
    img.replaceWith(svgEl);   // restore the live, interactive SVG
  }
}

// +/- buttons, wheel-to-zoom (about the pointer) and drag-to-pan for the
// hand-built map SVG. Zoom is a transform on the paths group; state lives in `z`
// (persisted across re-renders). `pan.didPan` gates the polygon click so a drag
// doesn't also select an area.
function setupZoom(svg, group, controls, W, H, z, pan) {
  const MAX_K = 8;
  const apply = () => group.setAttribute('transform',
    `translate(${z.tx.toFixed(2)} ${z.ty.toFixed(2)}) scale(${z.k.toFixed(4)})`);
  const clampPan = () => {
    z.tx = Math.min(0, Math.max(W * (1 - z.k), z.tx));
    z.ty = Math.min(0, Math.max(H * (1 - z.k), z.ty));
  };
  const zoomAt = (cx, cy, factor) => {
    const k = Math.min(MAX_K, Math.max(1, z.k * factor));
    const f = k / z.k;
    if (f === 1) return;
    z.tx = cx - f * (cx - z.tx);
    z.ty = cy - f * (cy - z.ty);
    z.k = k;
    clampPan(); apply();
  };
  const toVB = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    return [(clientX - r.left) / r.width * W, (clientY - r.top) / r.height * H];
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = toVB(e.clientX, e.clientY);
    zoomAt(cx, cy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  controls.querySelector('[data-zoom="in"]').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.4));
  controls.querySelector('[data-zoom="out"]').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.4));
  // Home: reset the view to the full extent.
  const reset = () => { z.k = 1; z.tx = 0; z.ty = 0; svg.style.cursor = ''; apply(); };
  controls.querySelector('[data-zoom="reset"]')?.addEventListener('click', reset);

  // Drag to pan (only meaningful once zoomed in).
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  svg.addEventListener('pointerdown', (e) => {
    pan.didPan = false;
    if (z.k <= 1) return;
    dragging = true; pan.dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY;
    svg.style.cursor = 'grabbing';
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    z.tx += (e.clientX - lastX) / r.width * W;
    z.ty += (e.clientY - lastY) / r.height * H;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) pan.didPan = true;
    clampPan(); apply();
  });
  const end = () => { dragging = false; pan.dragging = false; svg.style.cursor = z.k > 1 ? 'grab' : ''; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointerleave', end);
  svg.style.cursor = z.k > 1 ? 'grab' : '';
  clampPan(); apply();
}

/**
 * Build a map card and append it to `container`. Returns { render, card }.
 *
 * render({ geojson, values, selectedId, onSelect, title, sub, source, legend, filename })
 *   geojson    — a GeoJSON FeatureCollection; each feature.properties.id joins to `values`
 *   values     — Map(id -> { fill, label })  (fill hex; label used in the hover tooltip)
 *   selectedId — id of the polygon to outline as selected (optional)
 *   onSelect   — (id) => void, called when a data-bearing polygon is clicked
 *   legend     — [{ swatch, text }] rendered as a horizontal key below the map
 */
export function mapCard(container, { className = '' } = {}) {
  const card = document.createElement('section');
  card.className = `chart-card ${className}`.trim();
  card.innerHTML = `
    <header class="chart-title" data-role="title"></header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot" class="cmhc-map"></div>
    <div data-role="legend" class="cmhc-map-legend"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>Map boundaries not available.</div>
    <div class="chart-caption">
      <span class="chart-caption-left" data-role="caption-left"></span>
      <span class="chart-source" data-role="source">Source: Statistics Canada (boundaries)</span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
  `;
  container.appendChild(card);

  const $title  = card.querySelector('[data-role="title"]');
  const $sub    = card.querySelector('[data-role="sub"]');
  const $plot   = card.querySelector('[data-role="plot"]');
  const $legend = card.querySelector('[data-role="legend"]');
  const $empty  = card.querySelector('[data-role="empty"]');
  const $source = card.querySelector('[data-role="source"]');
  const $png    = card.querySelector('[data-role="dl-png"]');

  // Zoom/pan transform, persisted across re-renders so selecting a municipality
  // (which rebuilds the SVG) doesn't reset the user's view.
  const zoomState = { k: 1, tx: 0, ty: 0 };

  function render({ geojson, values, selectedId, onSelect, title, sub, source, legend, filename }) {
    $title.textContent = title || '';
    $sub.textContent   = sub || '';
    if (source) $source.textContent = source;
    $plot.replaceChildren();

    const features = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    if (!features.length) {
      $empty.hidden = false; $legend.replaceChildren(); $png.disabled = true;
      return;
    }
    $empty.hidden = true; $png.disabled = false;

    const vals = values || new Map();
    const fillFor  = (f) => vals.get(String(f.properties.id))?.fill || NO_DATA_FILL;
    const labelFor = (f) => {
      const v = vals.get(String(f.properties.id));
      return `${f.properties.name}\n${v ? v.label : 'No data'}`;
    };

    // Manual planar Web-Mercator fit + hand-built SVG paths. d3-geo's spherical
    // geoPath (used by Plot.geo) mis-rendered these polygons — it spread every
    // feature across the whole frame — whereas a plain planar projection is
    // correct, and dependency-free.
    const W = 700, H = 620, PAD = 8;
    // Both axes in the same (radian) units so the aspect ratio is correct.
    const mercX = (lon) => lon * Math.PI / 180;
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
    const eachPt = (f, cb) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) for (const pt of ring) cb(pt[0], pt[1]);
    };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of features) eachPt(f, (lon, lat) => {
      const x = mercX(lon), y = mercY(lat);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    const scale = Math.min((W - 2 * PAD) / ((maxX - minX) || 1), (H - 2 * PAD) / ((maxY - minY) || 1));
    const offX = PAD + ((W - 2 * PAD) - scale * (maxX - minX)) / 2;
    const offY = PAD + ((H - 2 * PAD) - scale * (maxY - minY)) / 2;
    const projX = (lon) => (offX + (mercX(lon) - minX) * scale).toFixed(1);
    const projY = (lat) => (offY + (maxY - mercY(lat)) * scale).toFixed(1);
    const pathData = (f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let d = '';
      for (const poly of polys) for (const ring of poly)
        d += 'M' + ring.map((pt) => `${projX(pt[0])} ${projY(pt[1])}`).join('L') + 'Z';
      return d;
    };

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'cmhc-plot');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.style.background = 'white';
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';

    // All polygons live in a group so zoom/pan is a single transform on it.
    const zoomG = document.createElementNS(SVG_NS, 'g');
    zoomG.setAttribute('class', 'cmhc-map-zoom');
    const panState = { didPan: false, dragging: false };
    let selPath = null;
    for (const f of features) {
      const id = String(f.properties.id);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathData(f));
      path.setAttribute('fill', fillFor(f));
      path.setAttribute('fill-opacity', '0.85');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '0.5');
      const titleEl = document.createElementNS(SVG_NS, 'title');
      titleEl.textContent = labelFor(f);
      path.appendChild(titleEl);
      if (vals.has(id)) {
        path.style.cursor = 'pointer';
        if (typeof onSelect === 'function')
          path.addEventListener('click', () => { if (!panState.didPan) onSelect(id); });
      }
      // Highlight the area under the pointer: fuller fill + a crisp outline, and
      // raise it so the outline isn't clipped by neighbours. Suppressed mid-drag
      // so panning doesn't strobe. On leave, restore the polygon's base style
      // (the selected one keeps its heavier outline) and re-raise the selection.
      path.addEventListener('mouseenter', () => {
        if (panState.dragging) return;
        path.setAttribute('fill-opacity', '1');
        path.setAttribute('stroke', HOVER_STROKE);
        path.setAttribute('stroke-width', '1.5');
        zoomG.appendChild(path);
      });
      path.addEventListener('mouseleave', () => {
        const isSel = selPath === path;
        path.setAttribute('fill-opacity', '0.85');
        path.setAttribute('stroke', isSel ? SEL_STROKE : '#ffffff');
        path.setAttribute('stroke-width', isSel ? '2' : '0.5');
        if (selPath && !isSel) zoomG.appendChild(selPath);
      });
      if (selectedId != null && id === String(selectedId)) selPath = path;
      zoomG.appendChild(path);
    }
    if (selPath) {
      selPath.setAttribute('stroke', SEL_STROKE);
      selPath.setAttribute('stroke-width', '2');
      zoomG.appendChild(selPath);   // raise to top so the outline isn't clipped
    }
    svg.appendChild(zoomG);

    // Frame wraps the SVG so the zoom controls sit over its top-right corner.
    const frame = document.createElement('div');
    frame.className = 'cmhc-map-frame';
    frame.appendChild(svg);
    const controls = document.createElement('div');
    controls.className = 'cmhc-map-zoom-controls';
    controls.innerHTML =
      '<button type="button" data-zoom="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-zoom="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-zoom="reset" aria-label="Reset view" title="Reset view">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
        '<path fill="currentColor" d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z"/></svg>' +
      '</button>';
    frame.appendChild(controls);
    $plot.appendChild(frame);

    setupZoom(svg, zoomG, controls, W, H, zoomState, panState);

    // Horizontal legend key below the map.
    $legend.replaceChildren();
    (legend || []).forEach(({ swatch, text }) => {
      const item = document.createElement('span');
      item.className = 'cmhc-map-legend-item';
      item.innerHTML = `<span class="cmhc-map-legend-swatch" style="background:${escapeHtml(swatch)}"></span>`;
      const t = document.createElement('span');
      t.textContent = text;
      item.appendChild(t);
      $legend.appendChild(item);
    });

    $png.onclick = () => exportMapCard(card, svg, filename || 'map.png');
  }

  return { render, card };
}
