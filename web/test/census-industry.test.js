import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCensusIndustry, _resetCensusIndustryCache } from '../src/census-industry.js';

const SAMPLE = { years: ['2021', '2016'], sectors: [{ code: '11', label: 'Agriculture' }],
  regions: [{ uid: '46', name: 'Manitoba', level: 'PR', data: { 2021: { labourForce: 100, notApplicable: 2, counts: [5] } } }] };

beforeEach(() => { _resetCensusIndustryCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('loadCensusIndustry — single-flight', () => {
  it('fetches once for concurrent and repeat callers', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadCensusIndustry(), loadCensusIndustry()]);
    await loadCensusIndustry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.regions[0].data['2021'].counts).toEqual([5]);
  });

  it('returns null and allows a retry when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
    expect(await loadCensusIndustry()).toBeNull();
    const good = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', good);
    expect((await loadCensusIndustry())?.years).toEqual(['2021', '2016']);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
