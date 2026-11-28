import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// A synthetic Local Data store shaped like r/16b's output. Made-up numbers:
// real WRREB figures must never be committed to this public repo.
const WRREB = {
  kind: 'wrreb-market-release', version: 1, asOf: 'March 2020', fetched: '2020-04-10', stale: false,
  sales: { value: 1000, vsPriorYearPct: -10, priorYearValue: 1111, vs5yrAvgPct: -2, fiveYrAvg: 1020 },
  active_listings: { value: 4000, vsPriorYearPct: 10, priorYearValue: 3636, vs5yrAvgPct: 5, fiveYrAvg: 3810 },
  sfd_avg_price: { value: 400000, vsPriorYearPct: 4, priorYearValue: 384615, vs5yrAvgPct: 7, fiveYrAvg: 373832 },
  condo_avg_price: { value: 250000, vsPriorYearPct: 1, priorYearValue: 247525, vs5yrAvgPct: 6, fiveYrAvg: 235849 },
};

// Same for the CREA HPI store (r/16's shape). Made-up numbers.
const CREA = {
  kind: 'crea-hpi', version: 1, asOf: 'March 2020', fetched: '2020-04-15', stale: false,
  series: [
    { id: 'mls.hpi.winnipeg.sf', chartLabel: 'Single-family benchmark', units: 'dollar', geo: 'Winnipeg',
      frequency: 'monthly', latestDate: '2020-03-01', latestValue: 300000 },
  ],
  records: [
    { id: 'mls.hpi.winnipeg.sf', date: '2020-02-01', value: 299000 },
    { id: 'mls.hpi.winnipeg.sf', date: '2020-03-01', value: 300000 },
  ],
  hpi: { benchmarkLatest: 300000, benchmarkLatestDate: 'March 2020', isRecordHigh: true, fiveYrChangePct: 12 },
};

const storeState = { data: null, crea: null };
vi.mock('../src/crea-store.js', () => ({ loadCrea: async () => storeState.crea }));
vi.mock('../src/wrreb-store.js', () => ({
  storeAvailable: () => true,
  getSavedDirectory: async () => null,
  directoryPermission: async () => 'denied',
  checkForUpdates: async () => null,
  importFromDirectory: async () => null,
  getData: async () => storeState.data,
}));

const { buildSections, initEconomicUpdate, WRREB_ABSENT_NOTICE, WRREB_LOADED_NOTICE,
  CREA_ABSENT_NOTICE, CREA_LOADED_NOTICE, BOTH_ABSENT_NOTICE } = await import('../src/economic-update.js');
const { validate } = await vi.importActual('../src/wrreb-store.js');
const { validate: validateCrea } = await vi.importActual('../src/crea-store.js');

// jsdom gives import.meta.url an http: scheme, so resolve from the web/ folder vitest runs in.
const ECON = resolve(process.cwd(), 'public/data/economy');
const PUBLIC_JSON = resolve(ECON, 'economic-update.json');
const publicData = JSON.parse(readFileSync(PUBLIC_JSON, 'utf8'));

const residential = (sections) => sections.find((s) => s.heading.startsWith('Residential Real Estate'));

describe('public economic-update.json', () => {
  it('ships no WRREB figures', () => {
    const mls = publicData.mls || {};
    for (const k of ['sales', 'active_listings', 'sfd_avg_price', 'sfa_avg_price', 'condo_avg_price'])
      expect(mls[k]).toBeUndefined();
    expect(JSON.stringify(publicData)).not.toMatch(/WRREB|winnipegregionalrealestate/i);
  });
  it('no longer ships the WRREB headline file', () => {
    expect(existsSync(resolve(ECON, 'mls_winnipeg.json'))).toBe(false);
  });
  it('ships no CREA HPI figures', () => {
    expect(publicData.mls).toBeUndefined();
    expect(publicData.charts?.hpi_benchmark).toBeUndefined();
    expect(JSON.stringify(publicData)).not.toMatch(/mls\.hpi|Home Price Index|benchmark/i);
    expect(existsSync(resolve(ECON, 'mls_benchmark.json'))).toBe(false);
  });
});

describe('buildSections', () => {
  it('says both sources are internal when the stores are empty', () => {
    const r = residential(buildSections(publicData, null, null));
    expect(r.heading).toBe('Residential Real Estate');
    expect(r.paras).toEqual([]);
    expect(r.notice).toBe(BOTH_ABSENT_NOTICE);
    expect(r.figure).toBeNull();
    expect(r.afterFigure).toEqual([]);
  });

  it('adds the CREA HPI sentence and figure from its store', () => {
    const r = residential(buildSections(publicData, null, CREA));
    expect(r.heading).toBe('Residential Real Estate (CREA)');
    expect(r.notice).toBe(`${WRREB_ABSENT_NOTICE} ${CREA_LOADED_NOTICE}`);
    expect(r.figure).toBe('hpi');
    expect(r.afterFigure[0]).toContain('benchmark for Winnipeg was $300,000 in March 2020');
  });

  it('merges the WRREB figures from the store', () => {
    const r = residential(buildSections(publicData, WRREB, CREA));
    expect(r.heading).toBe('Residential Real Estate (WRREB / CREA)');
    expect(r.notice).toBe(`${WRREB_LOADED_NOTICE} ${CREA_LOADED_NOTICE}`);
    expect(r.paras[0]).toContain('1,000 MLS® sales in March 2020 (down 10% from a year earlier');
    expect(r.paras[1]).toContain('single-family detached price was $400,000');
    expect(r.paras.some((p) => /attached/.test(p))).toBe(false);   // no sfa_avg_price in the store
    expect(r.banner).toBeNull();
  });

  it('flags stale store figures', () => {
    const r = residential(buildSections(publicData, { ...WRREB, stale: true }));
    expect(r.banner).toMatch(/could not be refreshed.*March 2020/);
    expect(r.notice).toBe(`${WRREB_LOADED_NOTICE} ${CREA_ABSENT_NOTICE}`);
  });
});

describe('initEconomicUpdate (synthetic store)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p id="eu-asof"></p><div id="eu-body"></div><button id="eu-copy"></button><button id="eu-download-docx"></button>';
    // Charts are not under test here; leave them out so Plot does not render in jsdom.
    const { charts, ...noCharts } = publicData;
    void charts;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => noCharts }));
  });

  it('renders the internal notice without the store', async () => {
    storeState.data = null; storeState.crea = null;
    await initEconomicUpdate();
    const html = document.getElementById('eu-body').innerHTML;
    expect(html).toContain('for internal use only');
    expect(html).not.toContain('1,000 MLS');
  });

  it('renders the WRREB figures with the store', async () => {
    storeState.data = WRREB;
    await initEconomicUpdate();
    const text = document.getElementById('eu-body').textContent;
    expect(text).toContain('1,000 MLS® sales in March 2020');
    expect(text).toContain('Internal use only');
  });

  it('renders the CREA HPI sentence with its store', async () => {
    storeState.data = null; storeState.crea = { ...CREA, series: undefined, records: undefined };   // no chart in jsdom
    await initEconomicUpdate();
    const text = document.getElementById('eu-body').textContent;
    expect(text).toContain('benchmark for Winnipeg was $300,000');
    expect(text).toContain('CREA MLS® HPI loaded');
  });
});

describe('wrreb-store validate', () => {
  it('accepts r/16b output', () => expect(() => validate(WRREB)).not.toThrow());
  it('rejects other files', () => {
    expect(() => validate({ asOf: 'March 2020' })).toThrow(/not a WRREB/);
    expect(() => validate({ sales: { value: 1 } })).toThrow(/not a WRREB/);
  });
});

describe('crea-store validate', () => {
  it('accepts r/16 output', () => expect(() => validateCrea(CREA)).not.toThrow());
  it('rejects other files', () => {
    expect(() => validateCrea(WRREB)).toThrow(/not a CREA/);
    expect(() => validateCrea({ series: [{ id: 'statscan.nhpi.winnipeg', latestValue: 1 }] })).toThrow(/not a CREA/);
  });
});
