/*
 * Observable Plot theme — mirrors the firm's reference appraisal chart:
 * bold dark-red title (handled in HTML, not the Plot SVG), framed plot
 * area, dashed light-grey grid lines, bold axis labels, grey tick labels.
 */

import * as Plot from '@observablehq/plot';

export const PALETTE = [
  '#1e3a8a', // primary blue
  '#dc2626', // red
  '#16a34a', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#be185d', // pink
  '#65a30d', // lime
];

export const GRID_STROKE      = '#d4d4d8';
export const GRID_DASHARRAY   = '3,3';
export const FRAME_STROKE     = '#18181b';

/**
 * Merge a Plot spec with the shared theme defaults. The caller controls
 * marks, scale domains, height, etc.
 */
export function themed(spec = {}) {
  const merged = {
    className: 'cmhc-plot',
    style: { background: 'white', fontSize: '13.5px', color: '#3f3f46' },
    marginLeft:   86,   // room for rotated y-axis label + currency ticks
    marginRight:  18,
    marginTop:    6,    // tighten the gap between subtitle and plot area
    marginBottom: 28,   // just enough for x-tick labels (no x-axis title)
    grid: false, // explicit grid marks are added per-spec for dashed style
    ...spec,
    x: {
      label: null,
      tickFormat: 'd',
      labelAnchor: 'center',
      labelArrow: 'none',
      labelOffset: 34,
      inset: 16,         // breathing room on the left + right edges
      grid: false,
      ...(spec.x || {}),
    },
    y: {
      labelAnchor: 'center',
      labelOffset: 72,   // push the title left of "$1,500"-width tick labels
      labelArrow: 'none',
      insetTop: 14,      // keep the top tick value inside the plot area
      nice: true,        // round the domain to nice tick values
      grid: false,
      ...(spec.y || {}),
    },
    color: {
      range: PALETTE,
      legend: true,
      label: null,
      ...(spec.color || {}),
    },
  };
  return merged;
}

/**
 * Per-chart helpers for the dashed grid + frame. Call from `marks: [...]`.
 */
export function gridMarks() {
  return [
    Plot.gridX({ stroke: GRID_STROKE, strokeDasharray: GRID_DASHARRAY, strokeOpacity: 1 }),
    Plot.gridY({ stroke: GRID_STROKE, strokeDasharray: GRID_DASHARRAY, strokeOpacity: 1 }),
  ];
}

export function frameMark() {
  return Plot.frame({ stroke: FRAME_STROKE, strokeWidth: 1 });
}

/**
 * Mirror the y scale on the right edge of the frame, the way the reference
 * appraisal chart's ggplot `sec_axis` does. On a wide chart the right-hand
 * values save the reader tracking back across the plot. Pair it with
 * `MIRROR_Y_MARGIN` as the spec's marginRight, or the labels are clipped.
 *
 * Ticks only — no duplicate axis title, which would just be noise.
 */
export const MIRROR_Y_MARGIN = 62;

export function mirrorYMarks(tickFormat, { label = null, labelOffset } = {}) {
  // BOTH axes have to be declared. Plot drops its implicit y axis as soon as
  // any explicit axisY mark exists, so adding only the right-hand one MOVES
  // the axis across instead of mirroring it. The left axis carries the label;
  // repeating it on the right would just be noise.
  return [
    Plot.axisY({
      anchor: 'left', tickFormat, tickSize: 3,
      label, labelOffset, labelAnchor: 'center', labelArrow: 'none',
    }),
    Plot.axisY({ anchor: 'right', tickFormat, tickSize: 3, label: null }),
  ];
}

/**
 * Tick format for a percent axis, with the decimals chosen from how much
 * ground the axis covers. A 0-8% vacancy axis reads "6%"; a 2.4-3.1% yield
 * axis still needs "2.8%", and a hair-thin spread needs two places. The
 * reference chart's axis is whole percents, and the precise value is always
 * one hover (or the data table) away, so the axis itself stays uncluttered.
 *
 * Values are already scaled to percent (3.41 means 3.41%), matching how every
 * percent series on the site is stored.
 */
export function percentTickFormat(domain) {
  const [lo, hi] = domain || [];
  const span = Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
  const places = span >= 4 ? 0 : span >= 1 ? 1 : 2;
  return (v) => `${Number(v).toFixed(places)}%`;
}

/**
 * Tick formatters for the four chart panels.
 */
export const fmt = {
  percent:   (v) => `${Number(v).toFixed(1)}%`,
  dollar:    (v) => `$${Math.round(Number(v)).toLocaleString()}`,
  pctChange: (v) => `${Number(v).toFixed(1)}%`,
};

/* --- Fitting a plot to its card ------------------------------------------- */

/*
 * Observable Plot defaults to a 640px-wide SVG, and the stylesheet only lets
 * that shrink (`max-width: 100%`), never grow. On a wide monitor a chart card
 * is comfortably wider than 640, so the chart sat in the top-left corner of
 * its card with a band of white to the right — and, because the PNG export
 * rasterises the whole card, that band was baked into every exported image.
 *
 * Measuring the plot host and handing Plot an explicit width fixes both at
 * once: the chart fills the card on screen, and the export follows.
 */

/** Plot's own default, used when the host has no width to measure yet. */
export const PLOT_FALLBACK_WIDTH = 640;

/** Narrowest we will ask Plot to draw; below this the CSS scales it down. */
const PLOT_MIN_WIDTH = 420;

/**
 * The width to give a Plot spec so the chart fills `host`.
 *
 * A host inside a hidden tab panel measures 0 — every tab but the open one is
 * `hidden` — so fall back to Plot's default and let `fitPlotWidth` redraw at
 * the real width once the panel is shown.
 *
 * @param {Element} host   the element the SVG is appended to
 * @param {number} [fallback]
 * @returns {number} width in CSS pixels
 */
export function plotWidth(host, fallback = PLOT_FALLBACK_WIDTH) {
  const w = Math.round(host?.clientWidth || 0);
  return w > 0 ? Math.max(w, PLOT_MIN_WIDTH) : fallback;
}

/**
 * Height for a plot drawn at `width`, from the card's base height.
 *
 * The base heights are tuned for a ~640px chart; stretched to 900+ without
 * gaining any height, a time series turns into a letterbox. Grow the height
 * with the width, but gently and to a ceiling — a chart that fills a wide
 * card should stay a chart, not become a square. A card at the base width is
 * left exactly as it was.
 *
 * @param {number} width   the width the plot will draw at
 * @param {number} base    the card's height at Plot's default width
 * @returns {number} height in CSS pixels
 */
export function plotHeight(width, base) {
  if (!Number.isFinite(width) || !Number.isFinite(base)) return base;
  return Math.round(Math.min(base * 1.3, Math.max(base, width * 0.45)));
}

/**
 * Redraw a card when its plot host changes width: a window resize, the
 * sidebar-bearing tabs' layout shifting, or the panel simply becoming visible
 * (hidden panels measure 0, so the first draw used the fallback width).
 *
 * Small changes are ignored — a one-pixel scrollbar reflow is not worth a
 * redraw, and re-entering the observer from our own draw is how a resize loop
 * starts. The host is a plain block element whose width comes from the card,
 * never from the SVG inside it, so a redraw cannot widen it.
 *
 * @param {Element} host      the plot host to watch
 * @param {Function} redraw   called when the width moves materially
 * @returns {Function} stop watching
 */
export function fitPlotWidth(host, redraw) {
  if (!host || typeof ResizeObserver !== 'function') return () => {};
  let last = Math.round(host.clientWidth || 0);
  const ro = new ResizeObserver(() => {
    const now = Math.round(host.clientWidth || 0);
    if (now === 0 || Math.abs(now - last) < 8) return;
    last = now;
    redraw();
  });
  ro.observe(host);
  return () => ro.disconnect();
}
