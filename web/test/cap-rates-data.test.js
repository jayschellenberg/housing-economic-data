import { describe, it, expect } from 'vitest';
import {
  quarterKey, quarterList, typesPresent, subtypesFor, firmsFor, rowsUpTo, averageByClass, byFirm,
  rangeSeries, quarterTable, toCardInput, AVERAGE, breakGaps, nextQuarterEnd,
} from '../src/cap-rates-data.js';

const row = (quarter, firm, type, subtype, low, high) => ({
  quarter, year: Number(quarter.slice(0, 4)), qtr: Number(quarter.slice(-1)),
  date: `${quarter.slice(0, 4)}-${['03-31', '06-30', '09-30', '12-31'][Number(quarter.slice(-1)) - 1]}`,
  market: 'Winnipeg', firm, type, subtype, low, high, mid: (low + high) / 2,
});
const ROWS = [
  row('2026 Q1', 'Colliers', 'Industrial', 'Class A', 0.06, 0.07),
  row('2026 Q1', 'CBRE', 'Industrial', 'Class A', 0.06, 0.0675),
  row('2026 Q1', 'Colliers', 'Industrial', 'Class B', 0.0625, 0.0725),
  row('2026 Q2', 'Colliers', 'Industrial', 'Class A', 0.06, 0.07),
  row('2026 Q2', 'CBRE', 'Industrial', 'Class A', 0.06, 0.065),
  row('2026 Q2', 'Cushman & Wakefield', 'Industrial', 'Class A', 0.0525, 0.0575),
  row('2026 Q2', 'Colliers', 'Office', 'Suburban Class B', 0.07, 0.0825),
  row('2026 Q2', 'Colliers', 'Office', 'Downtown Class A', 0.065, 0.08),
];

describe('quarters', () => {
  it('orders quarters chronologically', () => {
    expect(quarterKey('2026 Q2')).toBeGreaterThan(quarterKey('2026 Q1'));
    expect(quarterList({ rows: ROWS })).toEqual(['2026 Q1', '2026 Q2']);
  });
  it('rowsUpTo cuts at the quarter', () => {
    expect(rowsUpTo(ROWS, '2026 Q1').every(r => r.quarter === '2026 Q1')).toBe(true);
    expect(rowsUpTo(ROWS, null)).toHaveLength(ROWS.length);
  });
});

describe('ordering', () => {
  it('lists types, classes and firms in house order', () => {
    expect(typesPresent(ROWS)).toEqual(['Industrial', 'Office']);
    expect(subtypesFor(ROWS, 'Office')).toEqual(['Downtown Class A', 'Suburban Class B']);
    expect(firmsFor(ROWS)).toEqual(['Colliers', 'CBRE', 'Cushman & Wakefield']);
  });
});

describe('series', () => {
  it('averages the firms\' mid-points by class, in percent', () => {
    const pts = averageByClass(ROWS, 'Industrial');
    const a = pts.find(p => p.line === 'Class A' && p.date === '2026-06-30');
    // mids 6.5, 6.25, 5.5 → 6.083…
    expect(a.value).toBeCloseTo(6.08, 2);
    expect(pts.find(p => p.line === 'Class B').value).toBe(6.75);
  });
  it('byFirm adds an Average line', () => {
    const pts = byFirm(ROWS, 'Industrial', 'Class A');
    expect(pts.filter(p => p.date === '2026-03-31').map(p => [p.line, p.value])).toEqual([
      [AVERAGE, 6.44], ['CBRE', 6.38], ['Colliers', 6.5],
    ]);
  });
  it('rangeSeries takes the lowest low and highest high across firms', () => {
    const r = rangeSeries(ROWS, 'Industrial', 'Class A').find(x => x.date === '2026-06-30');
    expect(r).toEqual({ date: '2026-06-30', low: 5.25, high: 7, avg: 6.08 });
  });
});

describe('quarterTable', () => {
  it('lays out firms × classes with an average row', () => {
    const t = quarterTable(ROWS, 'Industrial', '2026 Q1');
    expect(t.subtypes).toEqual(['Class A', 'Class B']);
    expect(t.firms).toEqual(['Colliers', 'CBRE']);
    expect(t.cells.CBRE['Class A']).toEqual({ low: 6, high: 6.75 });
    expect(t.cells.CBRE['Class B']).toBeUndefined();
    expect(t.average['Class A']).toEqual({ low: 6, high: 6.88 });
  });
});

describe('toCardInput', () => {
  it('draws the Average solid and firms dashed, Average last', () => {
    const pts = byFirm(ROWS, 'Industrial', 'Class A');
    const { seriesMeta, dashedIds, records } = toCardInput('x', pts, { lineOrder: ['Colliers', 'CBRE', 'Cushman & Wakefield'] });
    expect(seriesMeta.map(s => s.chartLabel)).toEqual(['Colliers', 'CBRE', 'Cushman & Wakefield', AVERAGE]);
    expect(dashedIds).toEqual(['x:Colliers', 'x:CBRE', 'x:Cushman & Wakefield']);
    expect(records.every(r => r.id.startsWith('x:'))).toBe(true);
  });
});

describe('breakGaps', () => {
  it('names the following quarter end', () => {
    expect(nextQuarterEnd('2011-12-31')).toBe('2012-03-31');
    expect(nextQuarterEnd('2026-06-30')).toBe('2026-09-30');
  });
  it('inserts a null point after a hole of more than one quarter', () => {
    const pts = [
      { line: 'A', date: '2011-12-31', value: 6 },
      { line: 'A', date: '2021-03-31', value: 6.5 },
      { line: 'A', date: '2021-06-30', value: 6.4 },
    ];
    expect(breakGaps(pts)).toEqual([
      { line: 'A', date: '2011-12-31', value: 6 },
      { line: 'A', date: '2012-03-31', value: null },
      { line: 'A', date: '2021-03-31', value: 6.5 },
      { line: 'A', date: '2021-06-30', value: 6.4 },
    ]);
  });
  it('breaks range rows too', () => {
    const rows = [{ date: '2011-12-31', low: 5, high: 6, avg: 5.5 }, { date: '2021-12-31', low: 5, high: 6, avg: 5.5 }];
    expect(breakGaps(rows)[1]).toEqual({ date: '2012-03-31', low: null, high: null, avg: null });
  });
  it('keeps the gap breakers in card records', () => {
    const { records } = toCardInput('x', [
      { line: 'A', date: '2011-12-31', value: 6 }, { line: 'A', date: '2021-03-31', value: 6.5 },
    ]);
    expect(records.map(r => r.value)).toEqual([6, null, 6.5]);
  });
});
