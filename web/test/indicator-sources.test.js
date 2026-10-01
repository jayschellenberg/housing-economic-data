import { describe, it, expect } from 'vitest';
import catalog from '../public/data/indicators/_catalog.json';
import { chartSources } from '../src/indicator-sources.js';


describe('chartSources', () => {
  it('cites a single StatsCan table with its number, title, DOI and vectors', () => {
    const { short, items } = chartSources(catalog, 'nhpi');
    expect(short).toBe('Statistics Canada, Table 18-10-0205-01');
    expect(items).toHaveLength(1);
    expect(items[0].citation).toContain('New housing price index, monthly');
    expect(items[0].citation).toContain('https://doi.org/10.25318/1810020501-eng');
    expect(items[0].url).toContain('pid=1810020501');
    expect(items[0].detail).toMatch(/^Vectors: v\d+/);
  });

  it('resolves derived series to the published tables behind them', () => {
    const { short, items } = chartSources(catalog, 'feasibility');
    expect(short).toBe('Statistics Canada, Tables 18-10-0205-01 & 18-10-0289-01 (calculated)');
    expect(items).toHaveLength(2);
  });

  it('names Bank of Canada series codes', () => {
    const { short } = chartSources(catalog, 'policy_rates');
    expect(short).toBe('Bank of Canada, series CBC20210 & V80691311');
  });

  it('falls back to publisher names when the full list would crowd the subtitle', () => {
    const { short, items } = chartSources(catalog, 'cpi_core');
    expect(short).toBe('Statistics Canada, Table 18-10-0004-01; Bank of Canada (calculated)');
    expect(items.length).toBe(4);
  });

  it('gives every Market Indicators chart at least one source', () => {
    const groups = catalog.displayGroups;
    for (const [id, c] of Object.entries(catalog.charts)) {
      if ((groups[c.displayGroup]?.tab || 'indicators') !== 'indicators') continue;
      if (!catalog.series.some(s => s.chartId === id)) continue;
      expect(chartSources(catalog, id).items.length, id).toBeGreaterThan(0);
    }
  });
});

describe('chartSources for the visible series only', () => {
  it('drops a table when the lines it feeds are filtered out', () => {
    const ids = new Set(['statscan.unemployment.manitoba']);
    const { short, items } = chartSources(catalog, 'unemployment_rate', ids);
    expect(short).toBe('Statistics Canada, Table 14-10-0287-01');
    expect(items).toHaveLength(1);
  });
});

describe('chartSources on the Agriculture tab', () => {
  it('has an official title for every StatsCan table an agriculture chart uses', () => {
    const ag = new Set(Object.entries(catalog.displayGroups)
      .filter(([, g]) => g?.tab === 'agriculture').map(([id]) => id));
    const charts = new Set(catalog.series.filter(s => ag.has(s.displayGroup) && s.chartId).map(s => s.chartId));
    for (const id of charts) {
      for (const item of chartSources(catalog, id).items) {
        expect(item.citation, id).toMatch(/Table \d\d-\d\d-\d{4}-01 {2}\S/);
      }
    }
  });
});
