/*
 * Fixed-size chart images. Every chart PNG the site produces — the per-card
 * "Download PNG" buttons and the per-tab Word/Excel chart exports — comes out
 * at exactly 1950 × 1050 px tagged 300 DPI: a 6.5 × 3.5 in figure, the full
 * printable width of a Letter page, matching the firm's R appraisal charts.
 *
 * How a card gets there:
 *   1. The card is laid out at 975 × 525 CSS px (half the target), so text
 *      sizes land where the R charts have them once rasterised at 2x.
 *   2. Cards that can redraw their plot (registered via `setExportRedraw`)
 *      redraw at that width, then again with the plot height that makes the
 *      whole card 525 px tall — the chart fills the frame.
 *   3. Whatever the card's final box, it is scaled to fit and centred on a
 *      white 1950 × 1050 canvas, so the output size never varies. Cards that
 *      can't redraw (census/housing bar charts, maps) land here with a margin.
 *   4. A pHYs chunk stamps 300 DPI into the PNG, so Word and friends place it
 *      at 6.5 in wide instead of guessing from 96 DPI.
 */

import { toCanvas } from 'html-to-image';

export const EXPORT_W = 1950;
export const EXPORT_H = 1050;
export const EXPORT_DPI = 300;

/** CSS layout size of a card during capture (rasterised at 2x). */
const LAYOUT_SCALE = 2;
const LAYOUT_W = EXPORT_W / LAYOUT_SCALE;   // 975
const LAYOUT_H = EXPORT_H / LAYOUT_SCALE;   // 525

/** Never squash a plot below this while fitting the card to 525 px. */
const MIN_PLOT_H = 160;
/** Plot height used for the measuring pass. */
const PROBE_PLOT_H = 300;

const redraws = new WeakMap();

/**
 * Let the exporter redraw this card's plot at a given height. `fn(h)` must
 * redraw synchronously with the plot `h` px tall, or at its normal height
 * when `h` is null (called afterwards to restore the on-screen chart).
 */
export function setExportRedraw(card, fn) {
  redraws.set(card, fn);
}

/**
 * Rasterise `card` onto a 1950 × 1050 canvas.
 * @param {Element} card
 * @param {Object} opts
 * @param {Function} [opts.filter]  html-to-image node filter (what to leave out)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function captureCard(card, { filter } = {}) {
  const redraw = redraws.get(card);
  const prev = { width: card.style.width, maxWidth: card.style.maxWidth };
  card.classList.add('cmhc-exporting');
  try {
    if (redraw) {
      card.style.width = `${LAYOUT_W}px`;
      card.style.maxWidth = 'none';
      redraw(PROBE_PLOT_H);
      const chrome = card.offsetHeight - PROBE_PLOT_H;
      redraw(Math.max(MIN_PLOT_H, LAYOUT_H - chrome));
    }
    const w = card.offsetWidth, h = card.offsetHeight;
    const scale = Math.min(EXPORT_W / w, EXPORT_H / h);
    const src = await toCanvas(card, {
      backgroundColor: '#ffffff',
      pixelRatio: scale,
      cacheBust: true,
      // skipFonts: the only webfont is Inter via the cross-origin Google Fonts
      // stylesheet, whose cssRules can't be read (CORS) — html-to-image logs a
      // SecurityError and falls back to system fonts anyway. Skipping the
      // attempt removes the console noise and the ~3s per-capture stall.
      skipFonts: true,
      ...(filter ? { filter } : {}),
    });
    const out = document.createElement('canvas');
    out.width = EXPORT_W; out.height = EXPORT_H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
    const dw = Math.round(w * scale), dh = Math.round(h * scale);
    ctx.drawImage(src, Math.round((EXPORT_W - dw) / 2), Math.round((EXPORT_H - dh) / 2), dw, dh);
    return out;
  } finally {
    card.classList.remove('cmhc-exporting');
    card.style.width = prev.width;
    card.style.maxWidth = prev.maxWidth;
    if (redraw) redraw(null);
  }
}

/** Canvas → PNG Blob carrying the 300 DPI pHYs stamp. */
export async function canvasToPngBlob(canvas) {
  const raw = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  const bytes = withPngDpi(new Uint8Array(await raw.arrayBuffer()), EXPORT_DPI);
  return new Blob([bytes], { type: 'image/png' });
}

/** Capture `card` and download it as a 1950 × 1050, 300 DPI PNG. */
export async function downloadCardPng(card, filename, { filter } = {}) {
  const blob = await canvasToPngBlob(await captureCard(card, { filter }));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --- PNG resolution metadata ---------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Return a copy of PNG `bytes` whose pHYs chunk says `dpi` dots per inch,
 * replacing any pHYs already present. The chunk goes straight after IHDR
 * (the spec requires it before the first IDAT).
 * @param {Uint8Array} bytes
 * @param {number} dpi
 * @returns {Uint8Array}
 */
export function withPngDpi(bytes, dpi) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4);            // "pHYs"
  pv.setUint32(8, ppm); pv.setUint32(12, ppm);
  phys[16] = 1;                                     // unit: metre
  pv.setUint32(17, crc32(phys.subarray(4, 17)));

  const parts = [bytes.subarray(0, 8)];             // signature
  let off = 8;
  while (off < bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (type !== 'pHYs') parts.push(bytes.subarray(off, end));
    if (type === 'IHDR') parts.push(phys);
    off = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
