import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// A synthetic Local Data store: what r/16b writes to AppMarketData-Internal.
const WRREB = {
  kind: 'wrreb-market-release', version: 1, asOf: 'October 2026', fetched: '2026-11-27', stale: false,
  sales: { value: 1192, vsPriorYearPct: -11, priorYearValue: 1339, vs5yrAvgPct: -1, fiveYrAvg: 1209 },
  active_listings: { value: 3985, vsPriorYearPct: 13, priorYearValue: 3519, vs5yrAvgPct: 6, fiveYrAvg: 3772 },
  sfd_avg_price: { value: 455860, vsPriorYearPct: 3, priorYearValue: 441981, vs5yrAvgPct: 8, fiveYrAvg: 420224 },
  condo_avg_price: { value: 303348, vsPriorYearPct: 2, priorYearValue: 297428, vs5yrAvgPct: 9, fiveYrAvg: 277498 },
};

const storeState = { data: null };
vi.mock('../src/wrreb-store.js', () => ({
  storeAvailable: () => true,
  getSavedDirectory: async () => null,
  directoryPermission: async () => 'denied',
  checkForUpdates: async () => null,
  importFromDirectory: async () => null,
  getData: async () => storeState.data,
}));

const { buildSections, initEconomicUpdate, WRREB_ABSENT_NOTICE, WRREB_LOADED_NOTICE } = await import('../src/economic-update.js');
const { validate } = await vi.importActual('../src/wrreb-store.js');

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
});

describe('buildSections', () => {
  it('says the WRREB figures are internal when the store is empty, and keeps the CREA HPI', () => {
    const r = residential(buildSections(publicData, null));
    expect(r.heading).toBe('Residential Real Estate (CREA)');
    expect(r.paras).toEqual([]);
    expect(r.notice).toBe(WRREB_ABSENT_NOTICE);
    expect(r.afterFigure[0]).toMatch(/Home Price Index/);
  });

  it('merges the WRREB figures from the store', () => {
    const r = residential(buildSections(publicData, WRREB));
    expect(r.heading).toBe('Residential Real Estate (WRREB / CREA)');
    expect(r.notice).toBe(WRREB_LOADED_NOTICE);
    expect(r.paras[0]).toContain('1,192 MLS® sales in October 2026 (down 11% from a year earlier');
    expect(r.paras[1]).toContain('single-family detached price was $455,860');
    expect(r.paras.some((p) => /attached/.test(p))).toBe(false);   // no sfa_avg_price in the store
    expect(r.banner).toBeNull();
  });

  it('flags stale store figures', () => {
    const r = residential(buildSections(publicData, { ...WRREB, stale: true }));
    expect(r.banner).toMatch(/could not be refreshed.*October 2026/);
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
    storeState.data = null;
    await initEconomicUpdate();
    const html = document.getElementById('eu-body').innerHTML;
    expect(html).toContain('for internal use only');
    expect(html).not.toContain('1,192');
  });

  it('renders the WRREB figures with the store', async () => {
    storeState.data = WRREB;
    await initEconomicUpdate();
    const text = document.getElementById('eu-body').textContent;
    expect(text).toContain('1,192 MLS® sales in October 2026');
    expect(text).toContain('Internal use only');
  });
});

describe('wrreb-store validate', () => {
  it('accepts r/16b output', () => expect(() => validate(WRREB)).not.toThrow());
  it('rejects other files', () => {
    expect(() => validate({ asOf: 'October 2026' })).toThrow(/not a WRREB/);
    expect(() => validate({ sales: { value: 1 } })).toThrow(/not a WRREB/);
  });
});
