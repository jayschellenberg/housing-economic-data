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
    style: { background: 'white', fontSize: '12px', color: '#3f3f46' },
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
 * Tick formatters for the four chart panels.
 */
export const fmt = {
  percent:   (v) => `${Number(v).toFixed(1)}%`,
  dollar:    (v) => `$${Math.round(Number(v)).toLocaleString()}`,
  pctChange: (v) => `${Number(v).toFixed(1)}%`,
};
