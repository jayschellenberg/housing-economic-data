import { describe, it, expect } from 'vitest';
import {
  periodLabel, changeIndex, regionIndex, provRegions, years, tableYears, changeCardInput, regionCardInput,
  regionTableRows, changeTable, narrativesFor, narrativeYears, markRegions, fmtMoney, fmtPct, fmtRange,
} from '../src/fcc-data.js';

const data = {
  provinces: [{ code: 'CA', name: 'Canada' }, { code: 'MB', name: 'Manitoba' }],
  prov_change: [[2024, 'CA', 9.3], [2025, 'CA', 9.3], [2024, 'MB', 6.5], [2025, 'MB', 12.2], [2025, 'NL', null]],
  regions: [
    { id: 'MB:c:westman', prov: 'MB', name: 'Westman', land: 'cultivated' },
    { id: 'MB:c:wcppv-irr', prov: 'MB', name: 'Westman and Central Plains-Pembina Valley (irrigated)', land: 'cultivated' },
    { id: 'MB:p:westman', prov: 'MB', name: 'Westman', land: 'pasture' },
    { id: 'MB:c:old', prov: 'MB', name: 'Old Region', land: 'cultivated' },
  ],
  region_obs: [
    [2019, 'MB:c:westman', 2711, 2.7, 1300, 3800, 2711],
    [2021, 'MB:c:westman', 3100, 12.2, 1500, 4200, 3100],
    [2025, 'MB:c:westman', 4700, 15.1, 2300, 6400, 4700],
    [2025, 'MB:c:wcppv-irr', 12900, 0, 7500, 15100, 12900],
    [2025, 'MB:p:westman', 700, 4.0, 600, 1700, 700],
    [2010, 'MB:c:old', 900, null, null, null, null],
    [2016, 'MB:c:westman', 2174, null, null, null, null],
  ],
  narratives: [
    { year: 2025, period: 'annual', prov: 'MB', paras: ['a'], report: 'r25.pdf' },
    { year: 2026, period: 'mid', prov: 'MB', paras: ['b'], report: 'm26.pdf' },
    { year: 2008, period: 'spring', prov: 'MB', paras: ['c'], report: 's08.pdf' },
    { year: 2008, period: 'fall', prov: 'MB', paras: ['d'], report: 'f08.pdf' },
    { year: 2025, period: 'annual', prov: 'CA', paras: ['e'], report: 'r25.pdf' },
  ],
};

describe('fcc-data', () => {
  const cIdx = changeIndex(data);
  const rIdx = regionIndex(data);

  it('labels report periods with the months they cover', () => {
    expect(periodLabel(2008, 'spring')).toBe('Spring 2008 report (July–December 2007)');
    expect(periodLabel(2008, 'fall')).toBe('Fall 2008 report (January–June 2008)');
    expect(periodLabel(2025, 'annual')).toMatch(/January–December 2025/);
  });

  it('groups regions and drops retired ones', () => {
    const all = provRegions(data, rIdx, 'MB');
    expect(all.cultivated.map(r => r.name)).toEqual(['Old Region', 'Westman']);
    expect(all.irrigated).toHaveLength(1);
    expect(all.pasture).toHaveLength(1);
    expect(provRegions(data, rIdx, 'MB', { activeSince: 2022 }).cultivated.map(r => r.name)).toEqual(['Westman']);
  });

  it('lists years and table years', () => {
    expect(years(data)).toEqual([2010, 2016, 2019, 2021, 2024, 2025]);
    expect(tableYears(data)).toEqual([2019, 2021, 2025]);
  });

  it('builds % change lines, skipping nulls and honouring the range', () => {
    const { records, seriesMeta } = changeCardInput('x', cIdx, [{ prov: 'MB', label: 'Manitoba' }, { prov: 'NL', label: 'NL' }], { from: 2025 });
    expect(records).toEqual([{ id: 'x:MB', date: '2025-01-01', value: 12.2 }]);
    expect(seriesMeta).toHaveLength(1);
    expect(seriesMeta[0].units).toBe('percent');
  });

  it('breaks a region line over a gap of more than a year', () => {
    const regs = [data.regions[0]];
    const { records } = regionCardInput('v', rIdx, regs);
    expect(records.map(r => [r.date.slice(0, 4), r.value])).toEqual([
      ['2016', 2174], ['2017', null], ['2019', 2711], ['2020', null], ['2021', 3100], ['2022', null], ['2025', 4700]]);
  });

  it('reads one year of the region table', () => {
    const rows = regionTableRows(rIdx, data.regions.slice(0, 2), 2025);
    expect(rows.map(r => [r.region.name, r.value, r.pct, r.lo, r.hi])).toEqual([
      ['Westman', 4700, 15.1, 2300, 6400],
      ['Westman and Central Plains-Pembina Valley (irrigated)', 12900, 0, 7500, 15100],
    ]);
  });

  it('tabulates provinces by year, latest first', () => {
    expect(changeTable(cIdx, ['CA', 'MB'])).toEqual([
      { year: 2025, values: [9.3, 12.2] }, { year: 2024, values: [9.3, 6.5] }]);
  });

  it('orders narratives newest first, annual before mid-year', () => {
    expect(narrativesFor(data, 'MB').map(n => `${n.year}${n.period}`)).toEqual(['2026mid', '2025annual', '2008fall', '2008spring']);
    expect(narrativeYears(data, 'MB')).toEqual([2026, 2025, 2008]);
  });

  it('marks region names, longest first, across dash variants', () => {
    const runs = markRegions('Westman and Central Plains–Pembina Valley held; Westman rose.',
      ['Westman', 'Westman and Central Plains-Pembina Valley (irrigated)']);
    expect(runs.filter(r => r.region).map(r => r.text)).toEqual(['Westman and Central Plains–Pembina Valley', 'Westman']);
    expect(runs.map(r => r.text).join('')).toBe('Westman and Central Plains–Pembina Valley held; Westman rose.');
  });

  it('formats with the ** missing mark', () => {
    expect(fmtMoney(12900)).toBe('$12,900');
    expect(fmtPct(12.2)).toBe('12.2%');
    expect(fmtPct(null)).toBe('**');
    expect(fmtRange(600, 1700)).toBe('$600 – $1,700');
    expect(fmtRange(null, 1)).toBe('**');
  });
});
