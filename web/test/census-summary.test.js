import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildCensusSummary, summarizeRegion } from '../src/census-summary.js';

const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/data/housing/census_profile.json'), 'utf8'));
const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8'));

describe('census summary feed', () => {
  const out = buildCensusSummary(profile, '2026-01-01T00:00:00Z');
  const byUid = new Map(out.regions.map((r) => [r.uid, r]));

  it('keeps Manitoba only, plus the Winnipeg CMA and Winnipeg sub-areas', () => {
    expect(byUid.has('46')).toBe(true);
    expect(byUid.has('46602')).toBe(true);
    expect(out.regions.filter((r) => r.level === 'CSD').every((r) => r.uid.startsWith('46'))).toBe(true);
    expect(out.regions.some((r) => r.level === 'PR' && r.uid !== '46')).toBe(false);
    expect(out.regions.filter((r) => r.level === 'WPG_Nbhd').length).toBeGreaterThan(200);
  });

  it('reads Steinbach correctly from the source file', () => {
    const s = byUid.get('4602044');
    expect(s.name).toBe('Steinbach (CY)');
    expect(s.year).toBe('2021');
    expect(s.population).toBe(17806);
    expect(s.population_prior).toBe(15829);
    expect(s.population_change_pct).toBe(12.5);
    expect(s.median_household_income).toBe(72500);
    expect(s.renter_pct).toBe(38.3);
  });

  it('labels the CMA "Winnipeg CMA" and leaves CSD names alone', () => {
    expect(byUid.get('46602').name).toBe('Winnipeg CMA');
    expect(byUid.get('4602044').name).toBe('Steinbach (CY)');
  });

  it('turns suppressed {} cells into null, never 0', () => {
    const r = summarizeRegion({ uid: 'x', name: 'x', level: 'CSD', trends: { 2021: { population: 10 } }, demo: { 2021: { median_age: {}, owner: {}, tenure_total: 5 } } }, ['2021']);
    expect(r.median_age).toBeNull();
    expect(r.owner_pct).toBeNull();
    expect(r.population_change_pct).toBeNull();
  });

  it('stays small enough to fetch on demand', () => {
    expect(JSON.stringify(out).length).toBeLessThan(400_000);
  });

  it('is open to other origins in vercel.json', () => {
    const rule = vercel.headers.find((h) => h.source === '/data/housing/census-summary.json');
    expect(rule?.headers).toContainEqual({ key: 'Access-Control-Allow-Origin', value: '*' });
  });
});
