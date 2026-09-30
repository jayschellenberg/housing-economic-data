import { describe, it, expect } from 'vitest';
import {
  CHARTS, CHART_BY_ID, periodToDate, seasonDate, uniqueColumns, editionPoints, chartPoints,
  mergeLatestWins, toCardInput, allDistricts, sourceLabel, editionsUpTo, titleCase,
} from '../src/johnson-data.js';

// Cut-down editions in the shape parse_johnson.py writes. Two June editions
// and a December one, sharing the industrial total-vacancy matrix (with one
// figure revised between editions) plus a December-only lease-rate table.
const jun2025 = {
  id: '2025-06', year: 2025, month: 6, season: 'jun',
  tables: [
    { series: 'ind_vac_total_district', season: 'jun', shape: 'matrix', columns: ['2024', '2025'],
      rows: [
        { label: 'Central', values: [4.3, 1.7] },
        { label: 'St James', values: [2.8, 2.4] },
        { label: 'Overall', values: [2.6, 3.2] },
      ] },
  ],
};
const dec2025 = {
  id: '2025-12', year: 2025, month: 12, season: 'dec',
  tables: [
    { series: 'ind_vac_total_district', season: 'dec', shape: 'matrix', columns: ['2024', '2025'],
      rows: [
        { label: 'Central', values: [1.8, 1.0] },
        { label: 'Overall', values: [2.4, 2.5] },
      ] },
    { series: 'ind_lease_rate_district', season: null, shape: 'matrix', columns: ['2024', '2025', '% Increase Since 2016'],
      rows: [{ label: 'Central', values: [8.0, 8.5, 40.4] }] },
    { series: 'ind_leasing_by_type', season: null, shape: 'records', columns: ['SINGLE', 'RATE', 'MULTI', 'RATE', 'TOTAL', 'RATE'],
      rows: [{ label: '2025', values: [100, 7.5, 200, 8.5, 300, 8.1] }] },
  ],
};
const jun2026 = {
  id: '2026-06', year: 2026, month: 6, season: 'jun',
  tables: [
    { series: 'ind_vac_total_district', season: 'jun', shape: 'matrix', columns: ['2025', '2026'],
      rows: [
        // 2025 revised from 1.7 to 1.9 in the later edition.
        { label: 'Central', values: [1.9, 0.7] },
        { label: 'Overall', values: [3.2, 3.7] },
      ] },
    { series: 'office_sublease_history', season: null, shape: 'records', columns: ['CLASS A', 'OVERALL'],
      rows: [
        { label: 'June 2025', values: [15.7, 21.5] },
        { label: 'December 2025', values: [16.2, 23.2] },
      ] },
    { series: 'retail_vac_rent_district', season: 'jun', shape: 'records',
      columns: ['2025 VACANCY', '2025 ASKING RENT', '2026 VACANCY', '2026 ASKING RENT'],
      rows: [{ label: 'St Vital', values: [165250, 36.47, 149664, 39.03] }] },
  ],
};
const EDITIONS = [dec2025, jun2026, jun2025];   // deliberately unsorted

describe('catalog', () => {
  it('has unique chart ids and known kinds', () => {
    const ids = CHARTS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHARTS) {
      expect(['matrix-rows', 'records-cols', 'records-col', 'period-rows', 'edition-col']).toContain(c.kind);
      expect(c.series.length).toBeGreaterThan(0);
    }
  });
});

describe('dates', () => {
  it('dates June readings mid-year and December ones at year end', () => {
    expect(seasonDate(2026, 'jun')).toBe('2026-06-30');
    expect(seasonDate('2026', 'dec')).toBe('2026-12-31');
  });
  it('reads period labels', () => {
    expect(periodToDate('June 2017')).toBe('2017-06-30');
    expect(periodToDate('December 2017')).toBe('2017-12-31');
    expect(periodToDate('2017')).toBe('2017-12-31');
    expect(periodToDate('2007**')).toBe('2007-12-31');
    expect(periodToDate('Pre 1970')).toBeNull();
  });
});

describe('uniqueColumns', () => {
  it('numbers repeated column names', () => {
    expect(uniqueColumns(['SINGLE', 'RATE', 'MULTI', 'RATE'])).toEqual(['SINGLE', 'RATE', 'MULTI', 'RATE#2']);
  });
});

describe('editionPoints', () => {
  it('turns a district × year matrix into dated points with the table season', () => {
    const pts = editionPoints(CHART_BY_ID.ind_vac_total, jun2025);
    expect(pts).toContainEqual({ line: 'Central', date: '2024-06-30', value: 4.3, edition: '2025-06' });
    expect(pts).toContainEqual({ line: 'Overall', date: '2025-06-30', value: 3.2, edition: '2025-06' });
  });
  it('dates an annual table at year end and ignores non-year columns', () => {
    const pts = editionPoints(CHART_BY_ID.ind_rate, dec2025);
    expect(pts).toEqual([
      { line: 'Central', date: '2024-12-31', value: 8.0, edition: '2025-12' },
      { line: 'Central', date: '2025-12-31', value: 8.5, edition: '2025-12' },
    ]);
  });
  it('picks the numbered RATE columns of the leasing-by-type table', () => {
    const pts = editionPoints(CHART_BY_ID.ind_rate_type, dec2025);
    expect(pts.map(p => [p.line, p.value])).toEqual([
      ['Single-tenant rate', 7.5], ['Multi-tenant rate', 8.5], ['All rate', 8.1],
    ]);
  });
  it('reads "June 2025" / "December 2025" period rows', () => {
    const pts = editionPoints(CHART_BY_ID.office_sublease, jun2026);
    expect(pts).toContainEqual({ line: 'Class A', date: '2025-06-30', value: 15.7, edition: '2026-06' });
    expect(pts).toContainEqual({ line: 'Overall', date: '2025-12-31', value: 23.2, edition: '2026-06' });
  });
  it('reads the two-year asking-rent snapshot by column year', () => {
    const pts = editionPoints(CHART_BY_ID.retail_ask, jun2026);
    expect(pts).toEqual([
      { line: 'St Vital', date: '2025-06-30', value: 36.47, edition: '2026-06' },
      { line: 'St Vital', date: '2026-06-30', value: 39.03, edition: '2026-06' },
    ]);
  });
});

describe('views', () => {
  it('"edition" view uses only that edition', () => {
    const pts = chartPoints(CHART_BY_ID.ind_vac_total, EDITIONS, { view: 'edition', editionId: '2025-06' });
    expect(pts.every(p => p.edition === '2025-06')).toBe(true);
    expect(pts.find(p => p.line === 'Central' && p.date === '2025-06-30').value).toBe(1.7);
  });
  it('"series" view interleaves June and December and lets the latest edition win', () => {
    const pts = chartPoints(CHART_BY_ID.ind_vac_total, EDITIONS, { view: 'series', editionId: '2026-06' });
    const central = pts.filter(p => p.line === 'Central').map(p => [p.date, p.value]);
    expect(central).toEqual([
      ['2024-06-30', 4.3], ['2024-12-31', 1.8], ['2025-06-30', 1.9], ['2025-12-31', 1.0], ['2026-06-30', 0.7],
    ]);
  });
  it('"series" view as of an earlier edition keeps that edition\'s figure', () => {
    const pts = chartPoints(CHART_BY_ID.ind_vac_total, EDITIONS, { view: 'series', editionId: '2025-12' });
    expect(pts.find(p => p.line === 'Central' && p.date === '2025-06-30').value).toBe(1.7);
    expect(pts.some(p => p.date === '2026-06-30')).toBe(false);
  });
  it('editionsUpTo sorts and bounds', () => {
    expect(editionsUpTo(EDITIONS, '2025-12').map(e => e.id)).toEqual(['2025-06', '2025-12']);
    expect(editionsUpTo(EDITIONS, null).map(e => e.id)).toEqual(['2025-06', '2025-12', '2026-06']);
  });
  it('mergeLatestWins keeps the last writer', () => {
    const merged = mergeLatestWins([
      [{ line: 'A', date: '2020-12-31', value: 1 }],
      [{ line: 'A', date: '2020-12-31', value: 2 }],
    ]);
    expect(merged).toEqual([{ line: 'A', date: '2020-12-31', value: 2 }]);
  });
});

describe('toCardInput', () => {
  const pts = chartPoints(CHART_BY_ID.ind_vac_total, EDITIONS, { view: 'series', editionId: '2026-06' });
  it('keeps the aggregate line when the picker narrows', () => {
    const { seriesMeta, dashedIds } = toCardInput(CHART_BY_ID.ind_vac_total, pts, { keep: ['St James'] });
    expect(seriesMeta.map(s => s.chartLabel)).toEqual(['St James', 'Overall']);
    expect(dashedIds).toEqual(['ind_vac_total:St James']);
  });
  it('orders lines by the given district order', () => {
    const { seriesMeta } = toCardInput(CHART_BY_ID.ind_vac_total, pts, { lineOrder: ['St James', 'Central', 'Overall'] });
    expect(seriesMeta.map(s => s.chartLabel)).toEqual(['St James', 'Central', 'Overall']);
  });
  it('puts the oldest building-age cohort first, the rest in row order', () => {
    const chart = CHART_BY_ID.ind_rate_age;
    expect(chart.lineOrder).toEqual(['Pre 1970']);
    const agePts = [
      { line: '1970–1979', date: '2025-01-01', value: 8 },
      { line: '1980–1989', date: '2025-01-01', value: 9 },
      { line: 'Pre 1970',  date: '2025-01-01', value: 7 },
    ];
    const { seriesMeta } = toCardInput(chart, agePts, { lineOrder: chart.lineOrder });
    expect(seriesMeta.map(s => s.chartLabel)).toEqual(['Pre 1970', '1970–1979', '1980–1989']);
  });
  it('leads the apartment-sales legends with Pre 1946 and ends with All apartments', () => {
    const want = ['Pre 1946', '1946–1959', '1960–1969', '1970+', 'All apartments'];
    for (const id of ['apt_psf', 'apt_suite']) {
      const chart = CHART_BY_ID[id];
      expect(chart.lineOrder).toEqual(want);
      const pts = ['1946–1959', '1960–1969', '1970+', 'All apartments', 'Pre 1946']
        .map(line => ({ line, date: '2025-01-01', value: 1 }));
      const { seriesMeta } = toCardInput(chart, pts, { lineOrder: chart.lineOrder });
      expect(seriesMeta.map(s => s.chartLabel)).toEqual(want);
    }
  });
  it('marks semi-annual families monthly and annual charts annual', () => {
    expect(toCardInput(CHART_BY_ID.ind_vac_total, pts).seriesMeta[0].frequency).toBe('monthly');
    const rate = chartPoints(CHART_BY_ID.ind_rate, EDITIONS, { view: 'series', editionId: '2026-06' });
    expect(toCardInput(CHART_BY_ID.ind_rate, rate).seriesMeta[0].frequency).toBe('annual');
  });
});

describe('sidebar helpers', () => {
  it('lists districts alphabetically with aggregates last', () => {
    expect(allDistricts(EDITIONS)).toEqual(['Central', 'St James', 'St Vital', 'Overall']);
  });
  it('labels the source by view', () => {
    expect(sourceLabel(EDITIONS, { view: 'edition', editionId: '2025-12' })).toBe('Johnson Report, December 2025');
    expect(sourceLabel(EDITIONS, { view: 'series', editionId: '2026-06' })).toBe('Johnson Report, June 2026');
    expect(sourceLabel([], { view: 'series', editionId: null })).toBe('Johnson Report');
  });
  it('title-cases column names', () => {
    expect(titleCase('POWER CENTRES')).toBe('Power Centres');
    expect(titleCase('TOTAL A,B,C')).toBe('Total A,B,C');
  });
});
