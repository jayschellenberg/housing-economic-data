import { describe, it, expect } from 'vitest';
import {
  capSeriesFromRows, capSpreads, spreadMarkers, rollingFrom, capVsInterestCaption, orderTypes, monthlyMean, capPublisher, ALL_FIRMS, DEFAULT_FIRM, KNOWN_TYPES, DEFAULT_OFF_TYPES,
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

describe('capVsInterestCaption', () => {
  const catalog = require('../public/data/indicators/_catalog.json');
  const rateMeta = ['boc.policy_target', 'boc.goc_5yr', 'boc.goc_10yr']
    .map((id) => catalog.series.find((s) => s.id === id));
  it('names the BoC series, then the cap-rate reports when cap rates are drawn', () => {
    const rates = capVsInterestCaption(rateMeta, [], 'Colliers');
    expect(rates).toMatch(/^Bank of Canada/);
    expect(rates).not.toMatch(/cap rate/);
    expect(capVsInterestCaption(rateMeta, ['Office'], 'Colliers'))
      .toBe(`${rates}; Colliers Winnipeg quarterly cap rate reports`);
    expect(capVsInterestCaption(rateMeta, ['Office'], ALL_FIRMS))
      .toMatch(/; Colliers Winnipeg, CBRE & Cushman & Wakefield quarterly cap rate reports$/);
  });
});

describe('capSpreads', () => {
  it('measures each quarter against its quarter-end month\'s mean 10-year yield, in bps', () => {
    const bond = [{ date: '2026-03-01', value: 3.1 }, { date: '2026-06-01', value: 3.4 }];
    const out = capSpreads([['2026-06-30', 7.0], ['2026-03-31', 7.25], ['2026-09-30', 7.0]], bond);
    expect(out).toEqual([
      { date: '2026-03-01', iso: '2026-03-31', cap: 7.25, bond: 3.1, bps: 415 },
      { date: '2026-06-01', iso: '2026-06-30', cap: 7.0, bond: 3.4, bps: 360 },
    ]);   // 2026-09 has no yield month → dropped
  });
});

describe('spreadMarkers', () => {
  // Quarterly spreads 2010Q1 … with two adjacent highs and two adjacent lows.
  const q = (y, m, bps) => ({ date: `${y}-${String(m).padStart(2, '0')}-01`, cap: 0, bond: 0, bps });
  const spreads = [
    q(2010, 3, 500), q(2010, 6, 510), q(2010, 9, 400), q(2011, 3, 300),
    q(2013, 3, 480), q(2015, 3, 200), q(2015, 6, 190), q(2018, 3, 250),
    q(2020, 3, 230), q(2026, 3, 260), q(2026, 6, 255),
  ];
  const kinds = (ms) => ms.map(m => `${m.kind}:${m.date.slice(0, 7)}`);

  it('marks the current quarter plus two highs and two lows at least a year apart', () => {
    expect(kinds(spreadMarkers(spreads))).toEqual([
      'high:2010-06', 'high:2013-03', 'low:2015-06', 'low:2020-03', 'current:2026-06',
    ]);
  });

  it('can take neighbouring quarters when the gap is zero', () => {
    const highs = spreadMarkers(spreads, { minGapMonths: 0 }).filter(m => m.kind === 'high');
    expect(highs.map(m => m.bps)).toEqual([500, 510]);
  });

  it('copes with a short history', () => {
    expect(kinds(spreadMarkers([q(2026, 6, 255)]))).toEqual(['current:2026-06']);
    expect(spreadMarkers([])).toEqual([]);
  });
});

describe('rollingFrom', () => {
  it('opens a window of whole years that ends on the given month', () => {
    expect(rollingFrom('2026-10-01', 15)).toBe('2011-11');   // Nov 2011 … Oct 2026 = 180 months
    expect(rollingFrom('2026-01-28', 15)).toBe('2011-02');
    expect(rollingFrom('2026-12-01', 1)).toBe('2026-01');
  });
});
