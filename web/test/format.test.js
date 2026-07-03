import { describe, it, expect } from 'vitest';
import { miss, fInt, fUsd, fDec1, fPct1, fPctFrac0, fPctFrac1, fPctInt, INDICATOR_FMT } from '../src/format.js';

describe('miss (missing-value predicate)', () => {
  it('treats null / undefined / NaN / ±Infinity as missing', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, {}, 'x']) {
      expect(miss(v)).toBe(true);
    }
  });
  it('treats finite numbers (incl. 0 and negatives) as present', () => {
    for (const v of [0, -1, 3.14, 1e6, '42']) {
      expect(miss(v)).toBe(false);
    }
  });
});

describe('formatters — finite values', () => {
  it('fInt adds thousands separators', () => {
    expect(fInt(12345)).toBe('12,345');
    expect(fInt(0)).toBe('0');
  });
  it('fUsd rounds to whole dollars with a $ and separators', () => {
    expect(fUsd(1234.5)).toBe('$1,235');
    expect(fUsd(1000000)).toBe('$1,000,000');
  });
  it('fDec1 keeps one decimal place', () => {
    expect(fDec1(4.27)).toBe('4.3');
    expect(fDec1(10)).toBe('10.0');
  });
  it('fPct1 treats the value as an already-computed percent', () => {
    expect(fPct1(5.2)).toBe('5.2%');
    expect(fPct1(100)).toBe('100.0%');
  });
  it('fPctFrac0 treats the value as a fraction → whole percent', () => {
    expect(fPctFrac0(0.27)).toBe('27%');
    expect(fPctFrac0(0.5)).toBe('50%');
  });
  it('fPctFrac1 treats the value as a fraction → one-decimal percent', () => {
    expect(fPctFrac1(0.052)).toBe('5.2%');
    expect(fPctFrac1(0.1)).toBe('10.0%');
  });
  it('fPctInt treats the value as already 0–100 → whole percent', () => {
    expect(fPctInt(32.6)).toBe('33%');
    expect(fPctInt(30)).toBe('30%');
  });
});

describe('formatters — missing values', () => {
  it('default to the "**" table marker', () => {
    for (const f of [fInt, fUsd, fDec1, fPct1, fPctFrac0, fPctFrac1, fPctInt]) {
      expect(f(null)).toBe('**');
      expect(f(NaN)).toBe('**');
    }
  });
  it('honor a custom marker (— for charts, null to defer)', () => {
    expect(fUsd(null, '—')).toBe('—');
    expect(fPct1(NaN, '—')).toBe('—');
    expect(fUsd(null, null)).toBeNull();
    expect(fInt(Infinity, null)).toBeNull();
  });
});

describe('INDICATOR_FMT — agricultural commodity units', () => {
  it('dollar_per_tonne rounds to whole dollars with a /t suffix', () => {
    expect(INDICATOR_FMT.dollar_per_tonne(672.08)).toBe('$672/t');
    expect(INDICATOR_FMT.dollar_per_tonne(1234.5)).toBe('$1,235/t');
  });
  it('dollar_per_cwt keeps two decimals with a /cwt suffix', () => {
    expect(INDICATOR_FMT.dollar_per_cwt(296.78)).toBe('$296.78/cwt');
    expect(INDICATOR_FMT.dollar_per_cwt(112)).toBe('$112.00/cwt');
  });
  it('both render null as the indicator "—" marker', () => {
    expect(INDICATOR_FMT.dollar_per_tonne(null)).toBe('—');
    expect(INDICATOR_FMT.dollar_per_cwt(null)).toBe('—');
  });
  it('supply-managed units: $/kg, $/dozen, $/kL', () => {
    expect(INDICATOR_FMT.dollar_per_kg(2.89)).toBe('$2.89/kg');
    expect(INDICATOR_FMT.dollar_per_dozen(2.4)).toBe('$2.40/doz');
    expect(INDICATOR_FMT.dollar_per_kl(891.29)).toBe('$891/kL');
    expect(INDICATOR_FMT.dollar_per_kg(null)).toBe('—');
    expect(INDICATOR_FMT.dollar_per_dozen(null)).toBe('—');
    expect(INDICATOR_FMT.dollar_per_kl(null)).toBe('—');
  });
});
