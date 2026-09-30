import { describe, it, expect } from 'vitest';
import {
  quarterKey, quarterList, typesPresent, subtypesFor, firmsFor, rowsUpTo, averageByClass, byFirm,
  rangeSeries, quarterTable, toCardInput, AVERAGE, breakGaps, nextQuarterEnd, averageByFirm, defaultYearFrom,
  splitOfficeByLocation, collapseClasses,
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

describe('averageByFirm', () => {
  it('averages each firm\'s classes into one line per firm, in percent', () => {
    const pts = averageByFirm(ROWS, 'Industrial');
    // Colliers 2026 Q1: Class A 6.5 and Class B 6.75 -> 6.625 (rounded to 2 dp)
    expect(pts.find(p => p.line === 'Colliers' && p.date === '2026-03-31').value).toBe(6.63);
    expect(pts.find(p => p.line === 'CBRE' && p.date === '2026-06-30').value).toBe(6.25);
    expect(pts.some(p => p.line === AVERAGE)).toBe(false);
  });
  it('defaults the chart start to five years before the latest quarter', () => {
    expect(defaultYearFrom(['2021 Q4', '2026 Q2'])).toBe(2021);
    expect(defaultYearFrom([])).toBeNull();
  });
});

describe('splitOfficeByLocation', () => {
  const rows = [
    row('2026 Q2', 'Colliers', 'Office', 'Downtown Class A', 0.07, 0.08),
    row('2026 Q2', 'Colliers', 'Office', 'Suburban Class B', 0.075, 0.085),
    row('2026 Q2', 'Colliers', 'Office', 'All', 0.07, 0.08),
    row('2026 Q2', 'Colliers', 'Industrial', 'Class A', 0.06, 0.065),
  ];

  it('makes Downtown and Suburban Office their own types with Class A / B', () => {
    const out = splitOfficeByLocation(rows);
    expect(out.map(r => [r.type, r.subtype])).toEqual([
      ['Downtown Office', 'Class A'], ['Suburban Office', 'Class B'], ['Office', 'All'], ['Industrial', 'Class A'],
    ]);
    expect(typesPresent(out)).toEqual(['Industrial', 'Downtown Office', 'Suburban Office', 'Office']);
  });

  it('gives each half its own quarter table', () => {
    const t = quarterTable(splitOfficeByLocation(rows), 'Downtown Office', '2026 Q2');
    expect(t.subtypes).toEqual(['Class A']);
    expect(t.cells.Colliers['Class A']).toEqual({ low: 7, high: 8 });   // percent
  });

  it('leaves the stored rows untouched', () => {
    splitOfficeByLocation(rows);
    expect(rows[0].type).toBe('Office');
  });
});

describe('collapseClasses', () => {
  const rows = splitOfficeByLocation([
    row('2026 Q2', 'Colliers', 'Office', 'Suburban Class B', 0.07, 0.0825),
    row('2026 Q2', 'CBRE', 'Office', 'Suburban Class A', 0.0675, 0.0775),
    row('2026 Q2', 'CBRE', 'Office', 'Suburban Class B', 0.0725, 0.0825),
  ]);

  it('gives each brokerage one range: the mean of the classes it published', () => {
    const t = collapseClasses(quarterTable(rows, 'Suburban Office', '2026 Q2'));
    expect(t.subtypes).toEqual(['All classes']);
    expect(t.classes).toEqual(['Class A', 'Class B']);
    expect(t.cells.CBRE['All classes']).toEqual({ low: 7, high: 8 });
    expect(t.cells.Colliers['All classes']).toEqual({ low: 7, high: 8.25 });   // Class B only
    expect(t.average['All classes']).toEqual({ low: 7, high: 8.13 });
  });
});
