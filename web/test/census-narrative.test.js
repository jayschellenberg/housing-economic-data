import { describe, it, expect } from 'vitest';
import { buildCensusNarrative, regionStats, ratioPhrase, growthPhrase, proseName } from '../src/census-narrative.js';

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
// Only 2016–2021 trends here, so its growth rate covers a different span than
// Steinbach's 15 years and is left out of the growth comparison.
const wpgCma = {
  uid: '46602', level: 'CMA', name: 'Winnipeg (CMA)',
  trends: { '2016': trend(778489), '2021': trend(834678) },
  demo: { '2021': { median_hh_income: 83000, median_dwelling_val: 348000, median_rent: 1100 } },
};

const paras = (blocks) => blocks.filter(b => b.type === 'para').map(b => b.text).join('\n');
const bullets = (blocks) => blocks.filter(b => b.type === 'bullet').map(b => b.text).join('\n');

describe('ladders', () => {
  it('ratio phrases use broad bands', () => {
    expect(ratioPhrase(1.0)).toBe('broadly in line with');
    expect(ratioPhrase(0.9)).toBe('below');
    expect(ratioPhrase(0.6)).toBe('well below');
    expect(ratioPhrase(1.3)).toBe('well above');
  });
  it('prose names drop census type codes', () => {
    expect(proseName('Steinbach (CY)')).toBe('Steinbach');
    expect(proseName('Winnipeg (CMA)')).toBe('Winnipeg CMA');
    expect(proseName('Daniel McIntyre')).toBe('Daniel McIntyre');
  });
  it('growth phrases from the annual rate', () => {
    expect(growthPhrase(3)).toBe('grown strongly');
    expect(growthPhrase(1)).toBe('grown steadily');
    expect(growthPhrase(0.2)).toBe('remained essentially stable');
    expect(growthPhrase(-1)).toBe('declined');
  });
});

describe('regionStats', () => {
  it('computes changes, annual rates and shares', () => {
    const s = regionStats(steinbach, { years: YEARS, period: '2021' });
    expect(s.chg5).toBeCloseTo(12.49, 1);
    expect(s.chg15).toBeCloseTo(60.9, 1);
    expect(s.rateLong).toBeCloseTo(3.22, 1);
    expect(s.rateLongYears).toBe(15);
    expect(s.ownerShare).toBeCloseTo(61.7, 1);
    expect(s.post2000).toBeCloseTo(47.4, 1);
    expect(s.types.shares[0].key).toBe('single_detached');
  });
  it('treats zero population and {} as missing', () => {
    const r = { name: 'X', level: 'CMA', trends: { '2011': trend(0), '2021': trend(100) }, demo: { '2021': { median_hh_income: {} } } };
    const s = regionStats(r, { years: YEARS, period: '2021' });
    expect(s.chg5).toBeNull();
    expect(s.rateLong).toBeNull();
    expect(s.hhIncome).toBeNull();
  });
  it('caps the dwelling-mix year at the selected period', () => {
    expect(regionStats(steinbach, { years: YEARS, period: '2016' }).types).toBeNull();   // fixture has 2021 types only
  });
});

describe('buildCensusNarrative — general prose', () => {
  const { blocks, table } = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba, wpgCma], years: YEARS, period: '2021' });
  const text = paras(blocks);

  it('never states population counts, dollar figures or percentages', () => {
    expect(text).not.toMatch(/17,806|\$\d|\d%/);
  });
  it('reads long-run growth against benchmarks covering the same span', () => {
    expect(text).toContain('Over the past fifteen years, the population has grown strongly, faster than the province.');
  });
  it('contrasts a declining subject with growing benchmarks', () => {
    const shrinking = { ...steinbach, name: 'Oldtown', trends: { '2016': trend(10000), '2021': trend(9500) } };
    const { blocks: b } = buildCensusNarrative({ subject: shrinking, benchmarks: [manitoba], years: YEARS, period: '2021' });
    expect(paras(b)).toContain('Between the last two censuses, the population has declined, while the province continued to grow.');
  });
  it('flags a latest census that runs against a stable long-run trend', () => {
    const dip = { ...steinbach, name: 'Lakeside', trends: { '2006': trend(1000), '2016': trend(1080), '2021': trend(1050) } };
    const { blocks: b } = buildCensusNarrative({ subject: dip, benchmarks: [], years: YEARS, period: '2021' });
    expect(paras(b)).toContain('the population has remained essentially stable, with a slight decline in the most recent census period.');
  });
  it('groups incomes, values and rents that read the same', () => {
    expect(text).toContain('Household incomes are below the provincial and Winnipeg CMA levels, ' +
      'while home values and rents are broadly in line with the provincial level but below the Winnipeg CMA level.');
  });
  it('describes the housing mix and age in words', () => {
    expect(text).toContain('Housing is largely owner-occupied and consists of a mix of single-family homes and multi-unit dwellings.');
    expect(text).toContain('Much of the stock has been built since 2000.');
  });
  it('keeps tables and prose in Area 1/2/3 order', () => {
    const r = buildCensusNarrative({ subject: steinbach, benchmarks: [wpgCma, manitoba], years: YEARS, period: '2021' });
    expect(r.table.columns).toEqual(['Steinbach', 'Winnipeg CMA', 'Manitoba']);
    expect(paras(r.blocks)).toContain('Household incomes are below the Winnipeg CMA and provincial levels');
  });
  it('supporting table carries the numbers but no population count', () => {
    expect(table.columns).toEqual(['Steinbach', 'Manitoba', 'Winnipeg CMA']);
    expect(table.rows.map(r => r.area)).not.toContain('Population (2021)');
    expect(table.rows[0]).toEqual({ area: 'Population change, 2016–2021', values: ['+12.5%', '+5.0%', '+7.2%'] });
    expect(table.rows[2].values[0]).toBe('$72,500');
  });
  it('drops sentences without data, never printing **', () => {
    const { blocks: b16 } = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba], years: YEARS, period: '2016' });
    expect(paras(b16)).not.toContain('**');
    expect(paras(b16)).not.toContain('Household incomes');     // subject has no 2016 demo at all
    const single = { name: 'Newtown', level: 'CSD', trends: { '2021': trend(900) }, demo: {} };
    expect(paras(buildCensusNarrative({ subject: single, benchmarks: [manitoba], years: YEARS, period: '2021' }).blocks)).toBe('');
  });

  describe('economy (census_industry.json)', () => {
    // 4 sectors is enough to exercise top-3 + standouts.
    const sectors = [{ code: '11', label: 'Agriculture, forestry, fishing and hunting' }, { code: '31-33', label: 'Manufacturing' },
      { code: '44-45', label: 'Retail trade' }, { code: '62', label: 'Health care and social assistance' }];
    const industry = { years: ['2021', '2016'], sectors, regions: [
      { uid: '4602044', name: 'Steinbach (CY)', level: 'CSD', data: { 2021: { labourForce: 1000, notApplicable: 10, counts: [50, 300, 250, 400] } } },
      { uid: '46', name: 'Manitoba', level: 'PR', data: { 2021: { labourForce: 10000, notApplicable: 100, counts: [400, 1500, 3100, 5000] } } },
    ] };
    const { blocks: b, industryTable } = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba, wpgCma], years: YEARS, period: '2021', industry });

    it('names leading sectors and standouts in words', () => {
      // manufacturing LQ = 30/15 = 2.0 (standout); agriculture 5/4 = 1.25 (under LQ_MIN)
      expect(paras(b)).toContain('Employment is led by health care, manufacturing and retail; manufacturing is notably more prominent than across the province.');
    });
    it('keeps the industry table with exact shares', () => {
      expect(industryTable.rows[0]).toEqual({ area: 'Labour force aged 15+', values: ['1,000', '10,000', '**'] });
      expect(industryTable.rows[1]).toEqual({ area: '62 Health care and social assistance', values: ['40.0%', '50.0%', '**'] });
    });
    it('swaps the economic-base stub for a major-employers stub', () => {
      expect(b.find(x => x.type === 'bullet').text).toMatch(/^Major employers/);
    });
    it('says diversified when nothing stands out; omits without data', () => {
      const flat = { ...industry, regions: [{ ...industry.regions[0], data: { 2021: { labourForce: 1000, counts: [40, 150, 310, 500] } } }, industry.regions[1]] };
      expect(paras(buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba], years: YEARS, period: '2021', industry: flat }).blocks))
        .toContain('a broadly diversified mix.');
      const r = buildCensusNarrative({ subject: steinbach, benchmarks: [manitoba], years: YEARS, period: '2016', industry });
      expect(paras(r.blocks)).not.toContain('Employment');
      expect(r.industryTable).toBeNull();
    });
  });

  describe('location and access (mb_csd_highways.json)', () => {
    const hw = (rec) => ({ csd: { '4602044': rec } });
    const run = (h, subj = steinbach) => paras(buildCensusNarrative({ subject: subj, benchmarks: [], years: YEARS, period: '2021', highways: h }).blocks);

    it('rounds the Winnipeg distance to 5 km and names only the PTHs', () => {
      const t = run(hw({ through: ['PTH 12', 'PTH 52', 'PR 311'], nearby: [{ route: 'PR 303', km: 2.5, dir: 'south' }], wpgKm: 34, wpgDir: 'southeast' }));
      expect(t).toContain('Steinbach is located roughly 35 km southeast of Winnipeg.');
      expect(t).toContain('Steinbach is served by PTH 12 and PTH 52.');
      expect(t).not.toContain('PR 303');
    });
    it('handles adjoining, nearby-only and fly-in cases', () => {
      expect(run(hw({ through: ['PTH 1', 'PTH 12', 'PR 206'], nearby: [], wpgKm: 0, wpgDir: 'east' })))
        .toContain('Steinbach adjoins the City of Winnipeg to the east.');
      expect(run(hw({ through: [], nearby: [{ route: 'PR 210', km: 1, dir: 'west' }, { route: 'PTH 59', km: 4, dir: 'west' }], wpgKm: 58, wpgDir: 'southeast' })))
        .toContain('PTH 59 passes nearby.');
      expect(run(hw({ through: [], nearby: [], wpgKm: 400, wpgDir: 'north' })))
        .toContain('reached by air, water or winter road');
    });
    it('drops the location stub when covered, keeps it otherwise; ignores non-CSD subjects', () => {
      const covered = buildCensusNarrative({ subject: steinbach, benchmarks: [], years: YEARS, period: '2021', highways: hw({ through: [], nearby: [], wpgKm: 30, wpgDir: 'east' }) }).blocks;
      expect(bullets(covered)).not.toMatch(/Location and access/);
      expect(bullets(buildCensusNarrative({ subject: steinbach, benchmarks: [], years: YEARS, period: '2021' }).blocks)).toMatch(/Location and access/);
      expect(run({ csd: { '46': { through: ['PTH 1'], nearby: [] } } }, manitoba)).not.toContain('served by');
    });
  });

  it('services checklist fills the paragraph and drops the stub', () => {
    const svc = { checked: ['grocery', 'school_k8', 'munioffice'], nearest: { name: 'Steinbach', km: 20 } };
    const { blocks: b } = buildCensusNarrative({ subject: steinbach, benchmarks: [], years: YEARS, period: '2021', services: svc });
    expect(paras(b)).toContain('Steinbach is a limited-service community');
    expect(bullets(b)).not.toMatch(/Services and amenities/);
  });
});
