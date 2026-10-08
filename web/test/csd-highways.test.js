import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCsdHighways, _resetCsdHighwaysCache } from '../src/csd-highways.js';

const SAMPLE = { nearbyKm: 15, csd: { 4602044: { through: ['PTH 12', 'PTH 52'], nearby: [], wpgKm: 45, wpgDir: 'southeast' } } };

beforeEach(() => { _resetCsdHighwaysCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('loadCsdHighways — single-flight', () => {
  it('fetches once for concurrent and repeat callers', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadCsdHighways(), loadCsdHighways()]);
    await loadCsdHighways();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.csd['4602044'].through).toEqual(['PTH 12', 'PTH 52']);
  });

  it('returns null and allows a retry when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
    expect(await loadCsdHighways()).toBeNull();
    const good = vi.fn(async () => ({ ok: true, json: async () => SAMPLE }));
    vi.stubGlobal('fetch', good);
    expect((await loadCsdHighways())?.nearbyKm).toBe(15);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
