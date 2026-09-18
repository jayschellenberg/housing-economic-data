import { describe, it, expect } from 'vitest';
import { CHART_EXPORT_FILTER } from '../src/indicator-chart.js';

// html-to-image only runs in a visible browser, so the predicate it is handed
// is the testable part of the export. What survives it is exactly what lands in
// the PNG (and in the per-tab Word/Excel captures, which share this filter).
const node = (...classes) => {
  const el = document.createElement('div');
  classes.forEach(c => el.classList.add(c));
  return el;
};

describe('CHART_EXPORT_FILTER', () => {
  it('keeps the parts of the card that belong in a report figure', () => {
    for (const cls of ['chart-title', 'chart-sub', 'cmhc-plot-wrap', 'cmhc-plot-legend',
                       'chart-caption', 'chart-source']) {
      expect(CHART_EXPORT_FILTER(node(cls)), cls).toBe(true);
    }
  });

  it('drops the latest-value chips — on-screen reading aid, not part of the figure', () => {
    expect(CHART_EXPORT_FILTER(node('cmhc-latest-row'))).toBe(false);
  });

  it('still drops the other on-screen helpers', () => {
    for (const cls of ['chart-actions', 'cmhc-stale-warning', 'cmhc-chart-table', 'cmhc-explainer']) {
      expect(CHART_EXPORT_FILTER(node(cls)), cls).toBe(false);
    }
  });

  it('keeps nodes with no classList at all (text nodes, the svg internals)', () => {
    expect(CHART_EXPORT_FILTER({})).toBe(true);
    expect(CHART_EXPORT_FILTER(document.createTextNode('x'))).toBe(true);
  });

  it('drops an excluded node even when it carries other classes too', () => {
    expect(CHART_EXPORT_FILTER(node('cmhc-latest-row', 'flex', 'gap-2'))).toBe(false);
  });
});
