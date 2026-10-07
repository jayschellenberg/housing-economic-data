import { describe, it, expect } from 'vitest';
import {
  qOrd, qLabel, qDate, indexObs, toCardInput, quarterRanges, quarterList, quarterTable, expenseQuarter,
} from '../src/yardi-data.js';

const data = {
  editions: [{ id: '2026Q2', label: 'Q2 2026', cover: 'Q3 2026' }],
  obs: [
    ['2025Q4', 'Winnipeg', 'total', 'vacancy', 3.2, 't', '2025Q4'],
    ['2026Q1', 'Winnipeg', 'total', 'vacancy', 3.4, 'c', '2026Q2'],
    ['2026Q2', 'Winnipeg', 'total', 'vacancy', 2.8, 't', '2026Q2'],
    ['2026Q2', 'National', 'total', 'vacancy', 4.7, 't', '2026Q2'],
    ['2025Q2', 'National', 'total', 'vacancy', 4.1, 't', '2025Q2'],
    ['2026Q2', 'National', 'total', 'lol', -0.6, 't', '2026Q2'],
    ['2026Q2', 'Winnipeg', 'total', 'renewal', 50, 'c', '2026Q2'],
    ['2025Q3', 'Manitoba', 'total', 'exp_total', 7118, 'c', '2025Q3'],
    ['2026Q2', 'Manitoba', 'total', 'exp_total', 7694, 'c', '2026Q2'],
  ],
};

describe('quarters', () => {
  it('orders, labels and dates quarters', () => {
    expect(qOrd('2026Q1') - qOrd('2025Q4')).toBe(1);
    expect(qLabel('2026Q2')).toBe('Q2 2026');
    expect(qDate('2026Q3')).toBe('2026-07-01');
  });
  it('collapses consecutive quarters into ranges', () => {
    expect(quarterRanges(['2020Q1', '2020Q2', '2020Q3', '2022Q1', '2024Q3', '2024Q4']))
      .toBe('Q1 2020–Q3 2020, Q1 2022, Q3 2024–Q4 2024');
  });
  it('lists every quarter with data, oldest first', () => {
    expect(quarterList(data)).toEqual(['2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2']);
  });
});

describe('toCardInput', () => {
  const index = indexObs(data);
  it('builds one series per line, breaks gaps with nulls, lists chart-read quarters', () => {
    const lines = [
      { label: 'Winnipeg', geo: 'Winnipeg', seg: 'total', metric: 'vacancy' },
      { label: 'National', geo: 'National', seg: 'total', metric: 'vacancy' },
      { label: 'Nowhere', geo: 'Nowhere', seg: 'total', metric: 'vacancy' },
    ];
    const { records, seriesMeta, approx } = toCardInput('v', index, lines);
    expect(seriesMeta.map(s => s.chartLabel)).toEqual(['Winnipeg', 'National']);
    expect(seriesMeta[0].units).toBe('percent');
    const natl = records.filter(r => r.id === 'v:National');
    // 2025Q2 … 2026Q2: three empty quarters between the two readings
    expect(natl.map(r => r.value)).toEqual([4.1, null, null, null, 4.7]);
    expect(approx).toEqual([{ label: 'Winnipeg', quarters: ['2026Q1'] }]);
  });
  it('joins across missing quarters when bridging', () => {
    const { records } = toCardInput('v', index, [{ label: 'N', geo: 'National', seg: 'total', metric: 'vacancy' }], { bridge: true });
    expect(records.map(r => r.value)).toEqual([4.1, 4.7]);
  });
  it('honours the from/to range', () => {
    const { records } = toCardInput('v', index, [{ label: 'W', geo: 'Winnipeg', seg: 'total', metric: 'vacancy' }],
      { from: '2026Q1', to: '2026Q1' });
    expect(records).toEqual([{ id: 'v:W', date: '2026-01-01', value: 3.4 }]);
  });
});

describe('quarterTable', () => {
  const index = indexObs(data);
  it('keeps table figures only and drops empty columns', () => {
    const t = quarterTable(index, { geos: ['National', 'Winnipeg'], seg: 'total', q: '2026Q2', metrics: ['lol', 'vacancy', 'renewal', 'stay'] });
    expect(t.cols).toEqual(['lol', 'vacancy']);
    expect(t.rows).toEqual([
      { geo: 'National', values: [-0.6, 4.7] },
      { geo: 'Winnipeg', values: [null, 2.8] },
    ]);
  });
});

describe('expenseQuarter', () => {
  const index = indexObs(data);
  it('picks the latest expense quarter at or before the selection', () => {
    expect(expenseQuarter(index, '2026Q2')).toBe('2026Q2');
    expect(expenseQuarter(index, '2026Q1')).toBe('2025Q3');
    expect(expenseQuarter(index, '2025Q2')).toBe(null);
  });
});
