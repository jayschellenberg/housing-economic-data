import { describe, it, expect } from 'vitest';
import { ratePeriods, accrueInterest } from '../src/court.js';

// A cut-down slice of the court's published table, in the newest-first order
// the scrape writes.
const RATES = [
  { effectiveDate: '2024-01-01', quarter: '2024-Q1', ratePct: 5.00 },
  { effectiveDate: '2023-10-01', quarter: '2023-Q4', ratePct: 5.00 },
  { effectiveDate: '2023-07-01', quarter: '2023-Q3', ratePct: 4.75 },
  { effectiveDate: '2023-04-01', quarter: '2023-Q2', ratePct: 4.50 },
];

describe('ratePeriods', () => {
  it('makes each rate run until the next quarter takes effect', () => {
    const periods = ratePeriods(RATES);
    expect(periods.map(p => [p.from, p.to])).toEqual([
      ['2023-04-01', '2023-07-01'],
      ['2023-07-01', '2023-10-01'],
      ['2023-10-01', '2024-01-01'],
      ['2024-01-01', '9999-12-31'],
    ]);
  });
  it('leaves the newest rate running open-ended', () => {
    expect(ratePeriods(RATES).at(-1).ratePct).toBe(5.00);
  });
  it('drops rows without a usable date or rate', () => {
    expect(ratePeriods([...RATES, { effectiveDate: null, ratePct: 3 }, { effectiveDate: '2025-01-01' }]))
      .toHaveLength(RATES.length);
  });
  it('returns nothing for no input', () => {
    expect(ratePeriods([])).toEqual([]);
    expect(ratePeriods(undefined)).toEqual([]);
  });
});

describe('accrueInterest', () => {
  it('accrues a single quarter as simple interest on actual days', () => {
    // 2023-Q2 at 4.50%: May 1 -> Jul 1 is 61 days.
    const res = accrueInterest(100000, '2023-05-01', '2023-07-01', RATES);
    expect(res.segments).toHaveLength(1);
    expect(res.totalDays).toBe(61);
    expect(res.totalInterest).toBeCloseTo(100000 * 0.045 * 61 / 365, 6);
  });

  it('steps through each quarter at its own rate', () => {
    const res = accrueInterest(100000, '2023-05-01', '2024-01-01', RATES);
    expect(res.segments.map(s => [s.quarter, s.days, s.ratePct])).toEqual([
      ['2023-Q2', 61, 4.50],
      ['2023-Q3', 92, 4.75],
      ['2023-Q4', 92, 5.00],
    ]);
    const expected = 100000 * (0.045 * 61 + 0.0475 * 92 + 0.05 * 92) / 365;
    expect(res.totalInterest).toBeCloseTo(expected, 6);
  });

  it('is not the same as applying the latest rate across the whole period', () => {
    // The distinction the tab exists to make: stepping the rates is lower here
    // than assuming today's 5.00% ran throughout.
    const stepped = accrueInterest(100000, '2023-05-01', '2024-01-01', RATES).totalInterest;
    const flat = 100000 * 0.05 * 245 / 365;
    expect(stepped).toBeLessThan(flat);
  });

  it('excludes the end date, so back-to-back periods do not double-count', () => {
    const whole = accrueInterest(50000, '2023-05-01', '2023-10-01', RATES);
    const first = accrueInterest(50000, '2023-05-01', '2023-07-01', RATES);
    const second = accrueInterest(50000, '2023-07-01', '2023-10-01', RATES);
    expect(first.totalDays + second.totalDays).toBe(whole.totalDays);
    expect(first.totalInterest + second.totalInterest).toBeCloseTo(whole.totalInterest, 6);
  });

  it('flags a start earlier than the published table and accrues from its start', () => {
    const res = accrueInterest(100000, '2010-01-01', '2023-07-01', RATES);
    expect(res.startsBeforePublished).toBe(true);
    expect(res.publishedFrom).toBe('2023-04-01');
    expect(res.segments[0].from).toBe('2023-04-01');
  });

  it('runs past the newest quarter at the newest rate', () => {
    const res = accrueInterest(100000, '2024-01-01', '2024-03-01', RATES);
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0].ratePct).toBe(5.00);
    expect(res.totalDays).toBe(60);
  });

  it('returns nothing for a non-positive principal or an inverted range', () => {
    for (const bad of [
      [0, '2023-05-01', '2023-07-01'],
      [-100, '2023-05-01', '2023-07-01'],
      [100000, '2023-07-01', '2023-05-01'],
      [100000, '2023-05-01', '2023-05-01'],
    ]) {
      const res = accrueInterest(bad[0], bad[1], bad[2], RATES);
      expect(res.segments).toEqual([]);
      expect(res.totalInterest).toBe(0);
    }
  });

  it('survives an empty rate table', () => {
    expect(accrueInterest(100000, '2023-05-01', '2023-07-01', []).totalInterest).toBe(0);
  });
});
