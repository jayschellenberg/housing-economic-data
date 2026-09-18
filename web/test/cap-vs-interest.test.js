import { describe, it, expect } from 'vitest';
import {
  parseCsvRows, parseCapDate, parseCapRateCsv, orderTypes, monthlyMean,
} from '../src/cap-vs-interest.js';

// A cut-down slice of the Colliers extract, in the shape the real file uses:
// MM-DD-YYYY dates, both "Multifamily" and "Multi-Family" spellings, several
// rows per (type, date) that have to be averaged down to one point.
const CSV = [
  'Source,Market,Date,Quarter,MajorType,PropType,Subtype,Low,High',
  'Colliers,Winnipeg,03-31-2010,1,Office,Downtown,Class A,7.25,7.75',
  'Colliers,Winnipeg,03-31-2010,1,Office,Downtown,Class B,8.00,8.75',
  'Colliers,Winnipeg,03-31-2010,1,Industrial,Multi-Tenant,Class B,7.75,8.25',
  'Colliers,Winnipeg,12-31-2023,4,Multifamily,Apartment,High Rise,4.50,5.00',
  'Colliers,Winnipeg,12-31-2023,4,Multi-Family,Apartment,Low Rise,5.00,5.50',
].join('\n');

describe('parseCsvRows', () => {
  it('strips a UTF-8 BOM so the first header name is clean', () => {
    const rows = parseCsvRows('﻿Source,Market\nColliers,Winnipeg\n');
    expect(rows[0]).toEqual(['Source', 'Market']);
  });

  it('keeps commas and escaped quotes inside a quoted field', () => {
    const rows = parseCsvRows('a,b\n"Colliers, Inc.","he said ""hi"""\n');
    expect(rows[1]).toEqual(['Colliers, Inc.', 'he said "hi"']);
  });

  it('handles CRLF endings and drops trailing blank lines', () => {
    const rows = parseCsvRows('a,b\r\n1,2\r\n\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseCapDate', () => {
  it('reads the extract\'s MM-DD-YYYY', () => {
    expect(parseCapDate('03-31-2010')).toBe('2010-03-31');
    expect(parseCapDate('12-31-2023')).toBe('2023-12-31');
  });

  it('also accepts ISO and slashes, so an Excel re-export still loads', () => {
    expect(parseCapDate('2023-12-31')).toBe('2023-12-31');
    expect(parseCapDate('3/31/2010')).toBe('2010-03-31');
  });

  it('rejects anything it cannot read rather than guessing', () => {
    expect(parseCapDate('31-12-2023')).toBeNull();   // month 31 doesn't exist
    expect(parseCapDate('Q1 2010')).toBeNull();
    expect(parseCapDate('')).toBeNull();
  });
});

describe('parseCapRateCsv', () => {
  it('averages the Low-High mid-points within a type and date', () => {
    const { types } = parseCapRateCsv(CSV);
    // Office 2010-03-31: mid 7.50 and 8.375 → 7.9375
    expect(types.Office[0]).toEqual(['2010-03-31', 7.9375]);
    // Single row passes through: Industrial mid of 7.75/8.25
    expect(types.Industrial[0]).toEqual(['2010-03-31', 8.0]);
  });

  it('folds "Multifamily" into "Multi-Family" before averaging', () => {
    const { types } = parseCapRateCsv(CSV);
    expect(Object.keys(types)).not.toContain('Multifamily');
    // mids 4.75 and 5.25 → 5.00
    expect(types['Multi-Family']).toEqual([['2023-12-31', 5.0]]);
  });

  it('reports the market, source and period it read', () => {
    const { meta } = parseCapRateCsv(CSV);
    expect(meta.markets).toEqual(['Winnipeg']);
    expect(meta.sources).toEqual(['Colliers']);
    expect(meta.firstDate).toBe('2010-03-31');
    expect(meta.lastDate).toBe('2023-12-31');
    expect(meta.rows).toBe(5);
    expect(meta.skipped).toBe(0);
  });

  it('uses whichever of Low/High is present and counts unreadable rows', () => {
    const csv = [
      'Source,Market,Date,MajorType,Low,High',
      'Colliers,Winnipeg,03-31-2010,Retail,6.00,',       // High blank → 6.00
      'Colliers,Winnipeg,not-a-date,Retail,6.00,7.00',   // skipped
      'Colliers,Winnipeg,03-31-2010,,6.00,7.00',         // no type → skipped
    ].join('\n');
    const { types, meta } = parseCapRateCsv(csv);
    expect(types.Retail).toEqual([['2010-03-31', 6.0]]);
    expect(meta.skipped).toBe(2);
  });

  it('names the columns it could not find', () => {
    expect(() => parseCapRateCsv('Source,Market\nColliers,Winnipeg'))
      .toThrow(/Date, MajorType, Low, High/);
  });

  it('refuses a file where nothing parsed', () => {
    expect(() => parseCapRateCsv('Date,MajorType,Low,High\nxx,Office,aa,bb'))
      .toThrow(/No rows had a readable/);
  });
});

describe('orderTypes', () => {
  it('puts the known types in appraisal order and appends the rest', () => {
    expect(orderTypes(['Retail', 'Land', 'Office', 'Multi-Family']))
      .toEqual(['Multi-Family', 'Office', 'Retail', 'Land']);
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
