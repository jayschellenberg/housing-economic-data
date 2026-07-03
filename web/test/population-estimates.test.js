import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadPopulationEstimates, _resetPopulationEstimatesCache } from '../src/population-estimates.js';

const SAMPLE = { asOf: 2025, series: { 46: [[2001, 1151451], [2025, 1509702]] } };

beforeEach(() => { _resetPopulationEstimatesCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('loadPopulationEstimates — single-flight', () => {
  it('fetches once for concurrent and repeat callers', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([loadPopulationEstimates(), loadPopulationEstimates()]);
    await loadPopulationEstimates();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);                                   // read-only data — shared object is fine
    expect(a.series['46'][1]).toEqual([2025, 1509702]);
  });

  it('returns null and allows a retry when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
    expect(await loadPopulationEstimates()).toBeNull();

    // Failure evicts the cache, so the next call re-fetches.
    const good = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', good);
    expect((await loadPopulationEstimates())?.asOf).toBe(2025);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('returns null when the fetch throws (offline)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await loadPopulationEstimates()).toBeNull();
  });
});
