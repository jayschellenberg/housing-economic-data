import { describe, it, expect } from 'vitest';
import { populationGrowth, formatGrowth } from '../src/census-growth.js';

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
