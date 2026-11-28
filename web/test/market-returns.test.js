import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeInvest } from '../src/discount-rates.js';
import { validate } from '../src/market-returns-store.js';

// jsdom gives import.meta.url an http: scheme, so resolve from the web/ folder vitest runs in.
const PUBLIC_JSON = resolve(process.cwd(), 'public/data/economy/investment_context.json');
const publicData = JSON.parse(readFileSync(PUBLIC_JSON, 'utf8'));

// A synthetic store shaped like r/28b's output. Made-up numbers: real Yahoo
// prices must never be committed to this public repo.
const RETURNS = {
  kind: 'market-returns', version: 1, built: '2020-04-10', stale: false,
  series: [
    { id: 'xic', label: 'S&P/TSX Total Return', frequency: 'daily', dates: ['2020-01-02', '2020-04-09'], values: [10, 11] },
    { id: 'zfl', label: 'Govt Bonds (10yr+) TR', frequency: 'daily', dates: ['2020-01-02', '2020-04-09'], values: [20, 21] },
  ],
};

describe('public investment_context.json', () => {
  it('ships no Yahoo Finance prices', () => {
    expect(publicData.series.map((s) => s.id)).toEqual(['cpi']);
    expect(JSON.stringify(publicData)).not.toMatch(/XIC|ZFL|yahoo/i);
  });
  it('keeps the CPI line and GIC rates', () => {
    expect(publicData.series[0].dates.length).toBeGreaterThan(60);
    expect(publicData.gic.length).toBeGreaterThan(0);
  });
});

describe('mergeInvest', () => {
  it('returns the public file unchanged without the store', () => {
    expect(mergeInvest(publicData, null).series.map((s) => s.id)).toEqual(['cpi']);
  });
  it('puts the store series in front of the CPI line', () => {
    const m = mergeInvest(publicData, RETURNS);
    expect(m.series.map((s) => s.id)).toEqual(['xic', 'zfl', 'cpi']);
    expect(m.gic).toBe(publicData.gic);
  });
  it('ignores a CPI series in the store', () => {
    const m = mergeInvest(publicData, { series: [...RETURNS.series, { id: 'cpi', dates: [], values: [] }] });
    expect(m.series.filter((s) => s.id === 'cpi')).toHaveLength(1);
    expect(m.series.find((s) => s.id === 'cpi')).toBe(publicData.series[0]);
  });
  it('is null without the public file', () => expect(mergeInvest(null, RETURNS)).toBeNull());
});

describe('market-returns-store validate', () => {
  it('accepts r/28b output', () => expect(() => validate(RETURNS)).not.toThrow());
  it('rejects other files', () => {
    expect(() => validate({ series: [] })).toThrow(/not a market-returns/);
    expect(() => validate({ series: [{ id: 'xic', dates: ['2020-01-02'], values: [1, 2] }] })).toThrow(/not a market-returns/);
  });
});
