import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCensusProfile, _resetCensusProfileCache } from '../src/census-profile.js';

const SAMPLE = JSON.stringify({ regions: [{ uid: '46', name: 'Manitoba (Man.)', level: 'PR' }] });

beforeEach(() => { _resetCensusProfileCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('loadCensusProfile — single-flight', () => {
  it('fetches once for concurrent callers and parses per caller', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([loadCensusProfile(), loadCensusProfile()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);          // one download shared
    expect(a).toEqual(b);                                // same data
    expect(a).not.toBe(b);                               // ...but distinct objects
    a.regions[0].name = 'MUTATED';                       // one caller mutating…
    expect(b.regions[0].name).toBe('Manitoba (Man.)');   // …does not affect the other
  });

  it('reuses the cached text on a later call without re-fetching', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);

    await loadCensusProfile();
    await loadCensusProfile();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and allows a retry when the fetch fails', async () => {
    const bad = vi.fn(async () => ({ ok: false, text: async () => '' }));
    vi.stubGlobal('fetch', bad);
    expect(await loadCensusProfile()).toBeNull();

    // A non-ok response evicts the cache, so the next call re-fetches.
    const good = vi.fn(async () => ({ ok: true, text: async () => SAMPLE }));
    vi.stubGlobal('fetch', good);
    const data = await loadCensusProfile();
    expect(data?.regions?.[0]?.uid).toBe('46');
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('returns null when the body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'not json{' })));
    expect(await loadCensusProfile()).toBeNull();
  });
});
