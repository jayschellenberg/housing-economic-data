import { describe, it, expect } from 'vitest';
import {
  mOrd, mLabel, reportMonth, indexObs, centreSource, valueAt, toCardInput, monthRanges, cityList, reportedMonths,
} from '../src/rentalsca-data.js';

const data = {
  months: ['2025-12', '2026-01', '2026-02'],
  reports: [{ month: '2025-12' }, { month: '2026-02' }],
  obs: [
    ['2025-12', 'Winnipeg', 'city', 'all', '1br', 'rent', 1417, 't', '2025-12'],
    ['2026-01', 'Winnipeg', 'city', 'all', '1br', 'rent', 1409, 'd', '2026-02'],
    ['2026-02', 'Winnipeg', 'city', 'all', '1br', 'rent', 1427, 't', '2026-02'],
    ['2026-02', 'Brandon', 'city', 'all', '1br', 'rent', 1200, 't', '2026-02'],
    ['2026-02', 'Canada', 'national', 'all', '1br', 'rent', 1781, 't', '2026-02'],
    ['2026-02', 'Canada', 'province', 'ac', '1br', 'rent', 1800, 't', '2026-02'],
  ],
};

describe('months', () => {
  it('orders, labels and maps a data month to its report', () => {
    expect(mOrd('2026-01') - mOrd('2025-12')).toBe(1);
    expect(mLabel('2026-09')).toBe('September 2026');
    expect(reportMonth('2025-12')).toBe('2026-01');
  });
  it('collapses consecutive months', () => {
    expect(monthRanges(['2024-01', '2024-02', '2025-10'])).toBe('January–February 2024, October 2025');
    expect(monthRanges(['2025-12', '2026-01'])).toBe('December 2025–January 2026');
  });
});

describe('centres', () => {
  it('reads Canada from the national row, or the province table for apartments & condos', () => {
    expect(centreSource('Canada', 'all')).toEqual({ level: 'national', geo: 'Canada', seg: 'all' });
    expect(centreSource('Canada', 'ac')).toEqual({ level: 'province', geo: 'Canada', seg: 'ac' });
    expect(centreSource('Winnipeg', 'ac')).toEqual({ level: 'city', geo: 'Winnipeg', seg: 'ac' });
  });
  it('lists cities by name and the months a report covers', () => {
    expect(cityList(data)).toEqual(['Brandon', 'Winnipeg']);
    expect([...reportedMonths(data)]).toEqual(['2025-12', '2026-02']);
  });
});

describe('card input', () => {
  const index = indexObs(data);
  it('builds monthly series and lists estimated months', () => {
    const { records, seriesMeta, derived } = toCardInput('c', index, [
      { label: 'Winnipeg', ...centreSource('Winnipeg', 'all'), unit: '1br', metric: 'rent' },
      { label: 'Canada', ...centreSource('Canada', 'all'), unit: '1br', metric: 'rent' },
      { label: 'Nowhere', ...centreSource('Nowhere', 'all'), unit: '1br', metric: 'rent' },
    ]);
    expect(seriesMeta.map(s => [s.chartLabel, s.frequency])).toEqual([['Winnipeg', 'monthly'], ['Canada', 'monthly']]);
    expect(records.filter(r => r.id === 'c:Winnipeg').map(r => r.date)).toEqual(['2025-12-01', '2026-01-01', '2026-02-01']);
    expect(derived).toEqual([{ label: 'Winnipeg', months: ['2026-01'] }]);
  });
  it('breaks a line across a gap longer than two months', () => {
    const gappy = indexObs({ obs: [
      ['2025-01', 'X', 'city', 'all', '1br', 'rent', 1, 't'],
      ['2025-03', 'X', 'city', 'all', '1br', 'rent', 2, 't'],
      ['2025-09', 'X', 'city', 'all', '1br', 'rent', 3, 't'],
    ] });
    const { records } = toCardInput('g', gappy, [{ label: 'X', ...centreSource('X', 'all'), unit: '1br', metric: 'rent' }]);
    expect(records.map(r => [r.date, r.value])).toEqual([
      ['2025-01-01', 1], ['2025-03-01', 2], ['2025-04-01', null], ['2025-09-01', 3]]);
  });
  it('honours the month range and looks up one cell', () => {
    const { records } = toCardInput('c', index, [{ label: 'W', ...centreSource('Winnipeg', 'all'), unit: '1br', metric: 'rent' }],
      { from: '2026-01', to: '2026-01' });
    expect(records).toEqual([{ id: 'c:W', date: '2026-01-01', value: 1409 }]);
    expect(valueAt(index, { ...centreSource('Canada', 'ac'), unit: '1br', metric: 'rent' }, '2026-02').v).toBe(1800);
    expect(valueAt(index, { ...centreSource('Canada', 'ac'), unit: '1br', metric: 'rent' }, '2025-12')).toBe(null);
  });
});
