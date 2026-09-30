/*
 * Map PNG for the framed dashboards (web/rental/, web/commercial/), at the
 * site's fixed chart-image size: 1950 × 1050 px tagged 300 DPI (png-export.js),
 * a 6.5 × 3.5 in exhibit that drops into a report like every other figure.
 *
 * The dashboards used to save the canvas at whatever size it had on screen
 * (at 96 DPI), so a map exhibit came out a different size on every monitor.
 * Here the map is redrawn for the capture instead of scaled: its container is
 * set to 750 × 377 CSS px (the export frame, less the legend strip, at the
 * site's 2.6× capture scale) and MapLibre's pixel ratio to 2.6, so tiles,
 * labels and points render sharp at full size. The zoom is shifted so the
 * view keeps the width it had on screen. Everything is put back afterwards.
 *
 * The read-back happens INSIDE a render callback. preserveDrawingBuffer keeps
 * the buffer across a compositing step, but by the time an `idle` handler
 * runs the browser has already presented and cleared the frame, so drawImage()
 * would copy a blank canvas. Asking for a repaint and grabbing the pixels in
 * that same frame is what captures the map (found on the Commercial map).
 */

import { canvasToPngBlob, EXPORT_W, EXPORT_H } from './png-export.js';

const SCALE = 2.6;            // png-export's capture scale: 13px text → ~34px
const STRIP = 70;             // legend strip under the map, in export px
const MAP_H = EXPORT_H - STRIP;
const IDLE_TIMEOUT_MS = 10000;

const FONT = '"Inter", Arial, sans-serif';

function whenIdle(map) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, IDLE_TIMEOUT_MS);   // never hang the button
    map.once('idle', () => { clearTimeout(t); resolve(); });
  });
}

function grabFrame(map) {
  return new Promise((resolve) => {
    map.once('render', () => {
      const src = map.getCanvas();
      const copy = document.createElement('canvas');
      copy.width = src.width;
      copy.height = src.height;
      copy.getContext('2d').drawImage(src, 0, 0);
      resolve(copy);
    });
    map.triggerRepaint();
  });
}

function compose(mapCanvas, legend) {
  const out = document.createElement('canvas');
  out.width = EXPORT_W;
  out.height = EXPORT_H;
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, EXPORT_W, EXPORT_H);
  g.drawImage(mapCanvas, 0, 0, EXPORT_W, MAP_H);

  // Attribution, bottom-right of the map area (the licence requires it).
  g.font = `26px ${FONT}`;
  const attr = '© Protomaps © OpenStreetMap contributors';
  const aw = g.measureText(attr).width + 24;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(EXPORT_W - aw, MAP_H - 40, aw, 40);
  g.fillStyle = '#333';
  g.textBaseline = 'middle';
  g.fillText(attr, EXPORT_W - aw + 12, MAP_H - 20);

  // Legend, one centred row under the map, as on the site's chart cards.
  g.font = `34px ${FONT}`;
  const R = 12, GAP = 14, SEP = 42;
  const widths = legend.map((i) => R * 2 + GAP + g.measureText(i.label).width);
  let x = (EXPORT_W - (widths.reduce((a, b) => a + b, 0) + SEP * Math.max(0, legend.length - 1))) / 2;
  const y = MAP_H + STRIP / 2;
  legend.forEach((item, i) => {
    g.fillStyle = item.color;
    g.beginPath(); g.arc(x + R, y, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#27272a';
    g.fillText(item.label, x + R * 2 + GAP, y + 1);
    x += widths[i] + SEP;
  });
  return out;
}

/**
 * Download the map, as currently viewed, as a 1950 × 1050, 300 DPI PNG.
 * @param {import('maplibre-gl').Map} map   created with preserveDrawingBuffer
 * @param {Array<{label:string,color:string}>} legend
 * @param {string} filename
 */
export async function exportFixedMapPng(map, legend, filename) {
  const box = map.getContainer();
  const prev = {
    width: box.style.width, height: box.style.height,
    center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    pixelRatio: map.getPixelRatio(),
  };
  const onScreenW = box.clientWidth || EXPORT_W / SCALE;
  const cssW = EXPORT_W / SCALE;
  let frame;
  try {
    box.style.width = `${cssW}px`;
    box.style.height = `${MAP_H / SCALE}px`;
    map.setPixelRatio(SCALE);
    map.resize();
    map.jumpTo({ center: prev.center, zoom: prev.zoom + Math.log2(cssW / onScreenW), bearing: prev.bearing, pitch: prev.pitch });
    await whenIdle(map);
    frame = await grabFrame(map);
  } finally {
    box.style.width = prev.width;
    box.style.height = prev.height;
    map.setPixelRatio(prev.pixelRatio);
    map.resize();
    map.jumpTo({ center: prev.center, zoom: prev.zoom, bearing: prev.bearing, pitch: prev.pitch });
  }
  const blob = await canvasToPngBlob(compose(frame, legend));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
