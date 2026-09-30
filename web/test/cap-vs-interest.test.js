import { describe, it, expect } from 'vitest';
import {
  capSeriesFromRows, orderTypes, monthlyMean, capPublisher, ALL_FIRMS, DEFAULT_FIRM, KNOWN_TYPES, DEFAULT_OFF_TYPES,
} from '../src/cap-vs-interest.js';

// Rows in the shape cap_rates.json carries (mid as a fraction), for two
// quarters, two firms and three types — Office with several classes so the
// per-type mean is exercised.
const row = (date, firm, type, subtype, mid) => ({ date, quarter: date.slice(0, 4), firm, type, subtype, low: mid - 0.005, high: mid + 0.005, mid });
const ROWS = [
  row('2026-03-31', 'Colliers', 'Office', 'Downtown Class A', 0.0725),
  row('2026-03-31', 'Colliers', 'Office', 'Downtown Class B', 0.0775),
  row('2026-03-31', 'Colliers', 'Office', 'Suburban Class B', 0.0775),
  row('2026-03-31', 'CBRE',     'Office', 'Downtown Class A', 0.075),
  row('2026-03-31', 'Colliers', 'Industrial', 'Class A', 0.065),
  row('2026-06-30', 'Colliers', 'Industrial', 'Class A', 0.06),
  row('2026-06-30', 'CBRE',     'Industrial', 'Class A', 0.0625),
  row('2026-06-30', 'Colliers', 'Hotel', 'Focused Service', 0.08625),
  { date: '2026-06-30', firm: 'Colliers', type: 'Retail', subtype: 'Regional Mall', mid: null },
];

describe('capSeriesFromRows', () => {
  it('defaults to Colliers and averages that firm\'s classes per type and quarter, in percent', () => {
    const { types } = capSeriesFromRows(ROWS);
    // Office 2026-03-31: (7.25 + 7.75 + 7.75) / 3 = 7.5833…
    expect(types.Office[0][0]).toBe('2026-03-31');
    expect(types.Office[0][1]).toBeCloseTo(7.5833, 3);
    expect(types.Industrial).toEqual([['2026-03-31', 6.5], ['2026-06-30', 6.0]]);
    expect(Object.keys(types)).not.toContain('Retail');   // null mid dropped
  });

  it('ignores other firms when one firm is chosen', () => {
    const { types } = capSeriesFromRows(ROWS, 'CBRE');
    expect(types.Office).toEqual([['2026-03-31', 7.5]]);
    expect(types.Industrial).toEqual([['2026-06-30', 6.25]]);
    expect(types.Hotel).toBeUndefined();
  });

  it('averages across every firm\'s classes for the all-firms option', () => {
    const { types } = capSeriesFromRows(ROWS, ALL_FIRMS);
    // Office: (7.25 + 7.75 + 7.75 + 7.5) / 4 = 7.5625
    expect(types.Office[0][1]).toBeCloseTo(7.5625, 4);
    // Industrial 2026-06-30: (6.0 + 6.25) / 2
    expect(types.Industrial[1]).toEqual(['2026-06-30', 6.125]);
  });

  it('reports the span it covers and copes with no rows', () => {
    expect(capSeriesFromRows(ROWS).firstDate).toBe('2026-03-31');
    expect(capSeriesFromRows(ROWS).lastDate).toBe('2026-06-30');
    expect(capSeriesFromRows([])).toEqual({ types: {}, firstDate: null, lastDate: null });
    expect(capSeriesFromRows(null).types).toEqual({});
  });
});

describe('types and firms', () => {
  it('puts the known types in appraisal order and appends the rest', () => {
    expect(orderTypes(['Retail', 'Land', 'Self Storage', 'Office', 'Multi-Family']))
      .toEqual(['Multi-Family', 'Office', 'Retail', 'Self Storage', 'Land']);
  });
  it('keeps hotel and self storage off by default and Colliers as the firm', () => {
    expect([...DEFAULT_OFF_TYPES]).toEqual(['Hotel', 'Self Storage']);
    expect(KNOWN_TYPES).toContain('Self Storage');
    expect(DEFAULT_FIRM).toBe('Colliers');
  });
  it('credits the chosen firm, or all three for the average', () => {
    expect(capPublisher('CBRE')).toBe('CBRE');
    expect(capPublisher(ALL_FIRMS)).toMatch(/Colliers, CBRE & Cushman & Wakefield/);
  });
});

describe('monthlyMean', () => {
  it('averages daily observations onto the first of the month', () => {
    const out = monthlyMean([
      { date: '2026-01-02', value: 3.0 },
      { date: '2026-01-30', value: 4.0 },
      { date: '2026-02-03', value: 5.0 },
    ]);
    expect(out).toEqual([
      { date: '2026-01-01', value: 3.5 },
      { date: '2026-02-01', value: 5.0 },
    ]);
  });

  it('moves a lone quarter-end point onto its month start unchanged', () => {
    expect(monthlyMean([{ date: '2023-12-31', value: 5.0 }]))
      .toEqual([{ date: '2023-12-01', value: 5.0 }]);
  });

  it('ignores non-finite values', () => {
    expect(monthlyMean([
      { date: '2026-01-02', value: null },
      { date: '2026-01-03', value: 2.0 },
    ])).toEqual([{ date: '2026-01-01', value: 2.0 }]);
  });
});
