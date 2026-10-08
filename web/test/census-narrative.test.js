import { describe, it, expect } from 'vitest';
import { buildCensusNarrative, regionStats, ratioPhrase, growthWord, proseName } from '../src/census-narrative.js';

const YEARS = ['2006', '2011', '2016', '2021'];

const trend = (population, types = {}) => ({ population, households: 1, dwellings: 1, ...types });
const steinbach = {
  uid: '4602044', level: 'CSD', name: 'Steinbach (CY)',
  trends: {
    '2006': trend(11066), '2011': trend(13524), '2016': trend(15829),
    '2021': trend(17806, { single_detached: 3750, apt_lt5: 1490, apt_ge5: 250, semi_detached: 625,
      row_house: 295, apt_duplex: 260, movable: 160, other_attached: 10 }),
  },
  demo: { '2021': {
    median_hh_income: 72500, median_dwelling_val: 300000, median_rent: 1010,
    tenure_total: 6835, owner: 4220, period_total: 6835, built_1960: 585,
    built_2001_2005: 525, built_2006_2010: 985, built_2011_2015: 860, built_2016_2021: 870,
  } },
};
const manitoba = {
  uid: '46', level: 'PR', name: 'Manitoba',
  trends: { '2006': trend(1148401), '2011': trend(1208268), '2016': trend(1278365), '2021': trend(1342153) },
  demo: { '2021': { median_hh_income: 79500, median_dwelling_val: 304000, median_rent: 1040 },
          '2016': { median_hh_income: {}, median_dwelling_val: 275473, median_rent: 868 } },
};
const wpgCma = {
  uid: '46602', level: 'CMA', name: 'Winnipeg (CMA)',
  trends: { '2016': trend(778489), '2021': trend(834678) },
  demo: { '2021': { median_hh_income: 83000, median_dwelling_val: 348000, median_rent: 1100 } },
};

const paras = (blocks) => blocks.filter(b => b.type === 'para').map(b => b.text).join('\n');

describe('ladders', () => {
  it('ratio phrases', () => {
    expect(ratioPhrase(1.0)).toBe('roughly in line with');
    expect(ratioPhrase(0.91)).toBe('modestly below');
    expect(ratioPhrase(0.6)).toBe('well below');
    expect(ratioPhrase(1.3)).toBe('well above');
  });
  it('prose names drop census type codes', () => {
    expect(proseName('Steinbach (CY)')).toBe('Steinbach');
    expect(proseName('Winnipeg (CMA)')).toBe('Winnipeg CMA');
    expect(proseName('Daniel McIntyre')).toBe('Daniel McIntyre');
  });
  it('growth words', () => {
    expect(growthWord(12.5)).toBe('growing rapidly');
    expect(growthWord(0.2)).toBe('stable');
    expect(growthWord(-3)).toBe('contracting');
  });
});

describe('regionStats', () => {
  it('computes latest and long-run change and shares', () => {
    const s = regionStats(steinbach, { years: YEARS, period: '2021' });
    expect(s.pop).toBe(17806);
    expect(s.chg5).toBeCloseTo(12.49, 1);
    expect(s.chg15).toBeCloseTo(60.9, 1);
    expect(s.ownerShare).toBeCloseTo(61.7, 1);
    expect(s.post2000).toBeCloseTo(47.4, 1);
    expect(s.types.shares[0].key).toBe('single_detached');
  });
  it('treats zero population and {} as missing', () => {
    const r = { name: 'X', level: 'CMA', trends: { '2011': trend(0), '2021': trend(100) }, demo: { '2021': { median_hh_income: {} } } };
    const s = regionStats(r, { years: YEARS, period: '2021' });
    expect(s.chg5).toBeNull();
    expect(s.hhIncome).toBeNull();
  });
});

describe('buildCensusNarrative', () => {
  const { blocks, table } = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba, wpgCma], years: YEARS, period: '2021' });
  const text = paras(blocks);

  it('reads growth against both benchmarks', () => {
    expect(text).toContain('population of 17,806 at the 2021 Census, a change of +12.5% from 2016 and +60.9% since 2006');
    expect(text).toContain('growing rapidly, faster than the provincial figure (+5.0%) and faster than Winnipeg CMA\'s (+7.2%)');
  });
  it('contrasts a contracting subject with its benchmarks instead of pacing it', () => {
    const shrinking = { ...steinbach, name: 'Oldtown', trends: { '2016': trend(10000), '2021': trend(9500) } };
    const { blocks: b } = buildCensusNarrative({ subject: shrinking, benchmarks: [manitoba], years: YEARS, period: '2021' });
    expect(paras(b)).toContain('the community is contracting, while the provincial figure grew +5.0% over the same period.');
  });
  it('caps the dwelling-mix year at the selected period', () => {
    const s = regionStats(steinbach, { years: YEARS, period: '2016' });
    expect(s.types).toBeNull();      // the fixture only carries type counts for 2021
  });
  it('reads income and values with the ratio ladder', () => {
    expect(text).toContain('Median household income was $72,500 in 2020, modestly below the provincial figure ($79,500) and below Winnipeg CMA\'s ($83,000).');
    expect(text).toContain('median value of owner-occupied dwellings was $300,000 at the 2021 Census, roughly in line with the provincial figure ($304,000) and below Winnipeg CMA\'s ($348,000).');
    expect(text).toContain('Median monthly rent was $1,010');
  });
  it('describes the housing stock', () => {
    expect(text).toContain('mainly single-detached houses (55% of occupied dwellings in 2021), with apartments and duplex units making up 29%');
    expect(text).toContain('comparatively new stock: about 47% of dwellings were built after 2000 and 9% before 1961');
    expect(text).toContain('Owner-occupancy stands at 62%.');
  });
  it('includes appraiser stubs and a supporting table', () => {
    expect(blocks.filter(b => b.type === 'bullet')).toHaveLength(3);
    expect(table.columns).toEqual(['Steinbach', 'Manitoba', 'Winnipeg CMA']);
    expect(table.rows[0].values).toEqual(['17,806', '1,342,153', '834,678']);
    expect(table.rows[3].values[0]).toBe('$72,500');
  });
  it('drops benchmark clauses when the benchmark is missing, never printing **', () => {
    const { blocks: b16 } = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba], years: YEARS, period: '2016' });
    const t16 = paras(b16);
    expect(t16).not.toContain('**');
    expect(t16).not.toContain('Median household income');     // subject has no 2016 demo at all
  });
  it('still writes a sentence when only one census is available', () => {
    const r = { name: 'Newtown', level: 'CSD', trends: { '2021': trend(900) }, demo: {} };
    const { blocks: b } = buildCensusNarrative({ subject: r, benchmarks: [manitoba], years: YEARS, period: '2021' });
    expect(paras(b)).toContain('earlier census counts are not published');
  });
});
