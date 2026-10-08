import { describe, it, expect } from 'vitest';
import { CENTRES, UNITS, rentalsCaPoints, yardiPoints, cmhcPoints, since, asOfLabel, reportParagraphs, latestBySource } from '../src/rent-compare-data.js';

const wpg = CENTRES.find(c => c.id === 'Winnipeg');
const canada = CENTRES.find(c => c.id === 'Canada');
const u = (id) => UNITS.find(x => x.id === id);

const rc = { obs: [
  ['2026-08', 'Winnipeg', 'city', 'all', '1br', 'rent', 1426, 't'],
  ['2026-09', 'Winnipeg', 'city', 'all', '1br', 'rent', 1435, 't'],
  ['2026-09', 'Winnipeg', 'city', 'ac', '1br', 'rent', 1432, 't'],
  ['2026-09', 'Canada', 'national', 'all', '1br', 'rent', 1756, 't'],
  ['2026-09', 'Canada', 'province', 'ac', '1br', 'rent', 1800, 't'],
  ['2026-09', 'Winnipeg', 'city', 'all', '1br', 'mom', 0.6, 't'],
] };
const yd = { obs: [
  ['2026Q2', 'Winnipeg', '1br', 'rent', 1389, 't', '2026Q2'],
  ['2026Q1', 'Winnipeg', '1br', 'rent', 1374, 't', '2026Q1'],
  ['2026Q2', 'National', 'total', 'rent', 1774, 'c', '2026Q2'],
] };
const shard = { records: [
  { year: 2025, series: 'Average Rent', dimension: 'Bedroom Type', category: '1 Bedroom', dwellingType: 'Apartment', value: 1232 },
  { year: 2025, series: 'Average Rent', dimension: 'Bedroom Type', category: '1 Bedroom', dwellingType: 'All', value: 1240 },
  { year: 2024, series: 'Average Rent', dimension: 'Bedroom Type', category: '1 Bedroom', dwellingType: 'Apartment', value: 1179 },
  { year: 2025, series: 'Vacancy Rate', dimension: 'Bedroom Type', category: '1 Bedroom', dwellingType: 'Apartment', value: 3 },
] };

describe('rent comparison sources', () => {
  it('reads Rentals.ca city rents for the chosen property types', () => {
    expect(rentalsCaPoints(rc, wpg, u('1br'))).toEqual([
      { date: '2026-08-01', value: 1426, src: 't' }, { date: '2026-09-01', value: 1435, src: 't' }]);
    expect(rentalsCaPoints(rc, wpg, u('1br'), 'ac').map(p => p.value)).toEqual([1432]);
    expect(rentalsCaPoints(rc, wpg, u('0br'))).toEqual([]);
  });
  it('reads Canada from the national row, or the province table for apartments & condos', () => {
    expect(rentalsCaPoints(rc, canada, u('1br')).map(p => p.value)).toEqual([1756]);
    expect(rentalsCaPoints(rc, canada, u('1br'), 'ac').map(p => p.value)).toEqual([1800]);
  });
  it('reads Yardi quarters in order, keeping the chart-read marker', () => {
    expect(yardiPoints(yd, wpg, u('1br')).map(p => [p.date, p.value])).toEqual([['2026-01-01', 1374], ['2026-04-01', 1389]]);
    expect(yardiPoints(yd, canada, u('total'))).toEqual([{ date: '2026-04-01', value: 1774, src: 'c' }]);
  });
  it('reads CMHC October apartment rents only', () => {
    expect(cmhcPoints(shard, u('1br'))).toEqual([
      { date: '2024-10-01', value: 1179, src: 't' }, { date: '2025-10-01', value: 1232, src: 't' }]);
    expect(cmhcPoints(null, u('1br'))).toEqual([]);
  });
  it('filters by start date and labels each source in its own period', () => {
    expect(since(cmhcPoints(shard, u('1br')), '2025-01-01').map(p => p.value)).toEqual([1232]);
    expect(asOfLabel('yardi', '2026-04-01')).toBe('Q2 2026');
    expect(asOfLabel('cmhc', '2025-10-01')).toMatch(/October 2025/);
  });
});

describe('report paragraphs', () => {
  it('words the three sources and the gaps, flagging approximate figures', () => {
    const latest = {
      '1br': { rc: { value: 1435, date: '2026-09-01', src: 't' }, yardi: { value: 1389, date: '2026-04-01', src: 't' }, cmhc: { value: 1232, date: '2025-10-01', src: 't' } },
      total: { rc: null, yardi: { value: 1599, date: '2026-04-01', src: 'c' }, cmhc: { value: 1392, date: '2025-10-01', src: 't' } },
    };
    const [p1, pt] = reportParagraphs({ centre: wpg, units: [u('1br'), u('total')], latest, segLabel: 'all property types' });
    expect(p1.text).toMatch(/September 2026, the average asking rent for 1-bedroom units listed for rent in Winnipeg on Rentals\.ca \(all property types\) was \$1,435\./);
    expect(p1.text).toMatch(/in-place rent of \$1,389 for professionally managed apartments in Q2 2026/);
    expect(p1.text).toMatch(/Asking rents were 3\.3% above in-place rents and 16\.5% above the CMHC average\./);
    expect(pt.text).toMatch(/^For all units in Winnipeg, Yardi reported an average in-place rent of approximately \$1,599/);
    expect(pt.text).toMatch(/In-place rents were 14\.9% above the CMHC average\./);
  });
  it('skips a unit with no figures and picks each source’s latest point', () => {
    expect(reportParagraphs({ centre: wpg, units: [u('3br')], latest: {}, segLabel: '' })).toEqual([]);
    const l = latestBySource({ '1br': { rc: [{ value: 1 }, { value: 2 }], yardi: [], cmhc: null } });
    expect(l['1br']).toEqual({ rc: { value: 2 }, yardi: null, cmhc: null });
  });
});
