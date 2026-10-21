import { describe, it, expect } from 'vitest';
import * as Plot from '@observablehq/plot';
import { populationGrowth, formatGrowth, centreOnBand } from '../src/census-growth.js';

describe('centreOnBand', () => {
  // The census chart's own marks: bars by region within each period facet,
  // labels above a rise and below a fall.
  const regions = ['Thompson (CY)', 'Winnipeg (CMA)', 'Manitoba'];
  const growth = [
    { region: regions[0], period: '2016–2021', value: -4.7 },
    { region: regions[1], period: '2016–2021', value: 7.2 },
    { region: regions[2], period: '2016–2021', value: 5.0 },
  ];
  const el = Plot.plot({
    width: 640, height: 330,
    fx: { domain: ['2016–2021'] }, x: { axis: null, domain: regions }, y: { domain: [-8, 10] },
    marks: [
      Plot.barY(growth, { fx: 'period', x: 'region', y: 'value' }),
      ...[[d => d.value >= 0, 'bottom', -3], [d => d.value < 0, 'top', 3]].map(([keep, lineAnchor, dy]) =>
        Plot.text(growth.filter(keep), { fx: 'period', x: 'region', y: 'value', text: d => formatGrowth(d.value), lineAnchor, dy, render: centreOnBand })),
    ],
  });
  const tr = (n, i) => Number((n?.getAttribute?.('transform') || '').match(/translate\(([-\d.]+),?\s*([-\d.]+)?/)?.[i] ?? 0);
  const bars = [...el.querySelectorAll('g[aria-label="bar"] rect')].map((r) => ({
    cx: Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2 + tr(r.parentNode, 1),
    top: Number(r.getAttribute('y')), bottom: Number(r.getAttribute('y')) + Number(r.getAttribute('height')),
  }));
  const labels = [...el.querySelectorAll('g[aria-label="text"] text')].map((t) => ({
    text: t.textContent, x: tr(t, 1) + tr(t.parentNode, 1), y: tr(t, 2),
  }));
  const bar = (v) => bars[growth.findIndex((g) => g.value === v)];
  const label = (s) => labels.find((l) => l.text === s);

  it('puts each label on its bar’s centre line', () => {
    for (const g of growth) expect(label(formatGrowth(g.value)).x).toBeCloseTo(bar(g.value).cx, 6);
  });
  it('puts a rise’s label above the bar and a fall’s below it', () => {
    expect(label('+7.2%').y).toBeLessThanOrEqual(bar(7.2).top);
    expect(label('−4.7%').y).toBeGreaterThanOrEqual(bar(-4.7).bottom);
  });
});

describe('populationGrowth', () => {
  const rows = [
    // Thompson (CA): 2016 -> 2021 is -4.7% on the profile header.
    { region: 'Thompson (CA)', year: 2016, value: 13678 },
    { region: 'Thompson (CA)', year: 2021, value: 13035 },
    { region: 'Thompson (CA)', year: 2011, value: 13123 },
    { region: 'Manitoba', year: 2016, value: 1278365 },
    { region: 'Manitoba', year: 2021, value: 1342153 },
  ];

  it('gives each area its % change per census period, in time order', () => {
    const g = populationGrowth(rows, ['Thompson (CA)', 'Manitoba']);
    expect(g.map(d => [d.region, d.period])).toEqual([
      ['Thompson (CA)', '2011–2016'], ['Thompson (CA)', '2016–2021'], ['Manitoba', '2016–2021'],
    ]);
    expect(g[1].value).toBeCloseTo(-4.70, 2);
    expect(g[2].value).toBeCloseTo(4.99, 2);
  });

  it('skips periods it cannot compute', () => {
    const g = populationGrowth([
      { region: 'A', year: 2011, value: 0 },
      { region: 'A', year: 2016, value: 10 },
      { region: 'A', year: 2021, value: null },
    ], ['A']);
    expect(g).toEqual([]);
  });

  it('keeps the legend order and ignores areas without counts', () => {
    expect(populationGrowth(rows, ['Manitoba', 'Nowhere']).map(d => d.region)).toEqual(['Manitoba']);
  });
});

describe('formatGrowth', () => {
  it('signs the rate to one place', () => {
    expect(formatGrowth(4.987)).toBe('+5.0%');
    expect(formatGrowth(-4.7)).toBe('−4.7%');
    expect(formatGrowth(0.02)).toBe('0.0%');
  });
});
