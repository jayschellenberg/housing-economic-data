/*
 * Population growth between censuses, for the Community Census Profile's
 * "Population growth" chart (Jason, 2026-10-21): a small town is a flat line
 * along the floor of the population trend chart beside Winnipeg and Manitoba,
 * but its % change over each census period compares on the same footing.
 */

/**
 * % change over each census period, per area.
 * `rows`: [{ region, year, value }] (the trend chart's points).
 * `regions`: area names in legend order — the result keeps that order.
 * Returns [{ region, period: '2016–2021', from, to, value }], value in %;
 * a period starting at zero or a missing count is skipped.
 */
export function populationGrowth(rows, regions) {
  const out = [];
  for (const region of regions) {
    const pts = rows
      .filter(d => d.region === region && Number.isFinite(d.value))
      .sort((a, b) => a.year - b.year);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!(a.value > 0)) continue;
      out.push({ region, period: `${a.year}–${b.year}`, from: a.year, to: b.year, value: (b.value / a.value - 1) * 100 });
    }
  }
  return out;
}

/**
 * Plot `render` hook that moves a text mark from the start of its x band to
 * the middle. On a band x scale Plot anchors text at the band's start, so a
 * bar's value label sat over the bar's left edge.
 */
export function centreOnBand(index, scales, values, dimensions, context, next) {
  const half = (scales.x?.bandwidth?.() ?? 0) / 2;
  const x = values.x && Float64Array.from(values.x, (v) => v + half);
  return next(index, scales, { ...values, ...(x ? { x } : {}) }, dimensions, context);
}

/** "+4.7%", "−4.7%", "0.0%". */
export function formatGrowth(v) {
  const s = Math.abs(v).toFixed(1);
  if (s === '0.0') return '0.0%';
  return `${v > 0 ? '+' : '−'}${s}%`;
}
