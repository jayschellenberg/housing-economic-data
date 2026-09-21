import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadWpgAddressIndex, _resetWpgAddressCache, lookupAddress, parseAddress, canon,
} from '../src/wpg-address.js';

// A miniature index in the real file's shape. Areas are
// [neighbourhood|null, cluster, communityArea].
const INDEX = {
  generated: '2026-09-21',
  areas: [
    ['Crescentwood', 'River Heights East', 'River Heights'],
    ['Earl Grey', 'River Heights East', 'River Heights'],
    ['Prairie Pointe', 'Fort Garry South', 'Fort Garry'],
    ['Exchange District', 'Downtown East', 'Downtown'],
    ['Norwood West', 'St. Boniface West', 'St. Boniface'],
  ],
  streets: {
    // Whole street in one area.
    'CORYDON AVE': 0,
    // Even side runs into Earl Grey past 700; odd side stays Crescentwood.
    'GROSVENOR AVE': [[[2, 0], [700, 1]], [[1, 0]]],
    // Street names that END in a type word — expanding them would miss.
    'PRAIRIE POINTE': 2,
    'THE PROMENADE': 3,
    'BLAIRMORE GARDENS': 1,
    // Same name, two types — ambiguous without one.
    'MAIN ST': 3,
    'MAIN AVE': 4,
    // Directional key + punctuation in the name.
    'ST MARYS RD': 4,
    "GOVERNOR'S RD": 0,
    'DR. DAVID MARSH WAY': 2,
  },
};

const stubFetch = (body = INDEX, ok = true) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })));

beforeEach(() => { _resetWpgAddressCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('canon', () => {
  it('strips periods, apostrophes and hyphens and upper-cases', () => {
    expect(canon("Governor's Rd")).toBe('GOVERNORS RD');
    expect(canon('Dr. David Marsh Way')).toBe('DR DAVID MARSH WAY');
    expect(canon('  st.  mary’s   road ')).toBe('ST MARYS ROAD');
  });
});

describe('parseAddress', () => {
  it('pulls the house number and normalizes the street', () => {
    expect(parseAddress('514 Corydon Avenue')).toEqual(
      { number: 514, raw: 'CORYDON AVENUE', name: 'CORYDON', type: 'AVE', dir: '' });
  });

  it('expands type and direction aliases', () => {
    expect(parseAddress('100 Kenaston Boulevard North')).toEqual(
      { number: 100, raw: 'KENASTON BOULEVARD NORTH', name: 'KENASTON', type: 'BLVD', dir: 'N' });
  });

  it('drops a letter suffix on the house number', () => {
    expect(parseAddress('123A Main St')).toMatchObject({ number: 123, name: 'MAIN' });
  });

  it('drops unit designators in either position', () => {
    expect(parseAddress('Unit 5 - 123 Main St')).toMatchObject({ number: 123, name: 'MAIN' });
    expect(parseAddress('123 Main St Apt 5')).toMatchObject({ number: 123, name: 'MAIN' });
    expect(parseAddress('5-123 Main St')).toMatchObject({ number: 123, name: 'MAIN' });
  });

  it('drops a trailing city and postal code', () => {
    expect(parseAddress('514 Corydon Ave, Winnipeg, MB R3L 0P3'))
      .toMatchObject({ number: 514, name: 'CORYDON', type: 'AVE' });
  });

  it('returns null without a leading house number', () => {
    expect(parseAddress('Corydon Avenue')).toBeNull();
    expect(parseAddress('')).toBeNull();
  });

  it('keeps the literal remainder alongside the expanded form', () => {
    expect(parseAddress('55 Prairie Pointe')).toEqual(
      { number: 55, raw: 'PRAIRIE POINTE', name: 'PRAIRIE', type: 'PT', dir: '' });
  });
});

describe('lookupAddress', () => {
  let idx;
  beforeEach(async () => { stubFetch(); idx = await loadWpgAddressIndex(); });

  it('resolves a single-area street', () => {
    expect(lookupAddress(idx, '514 Corydon Ave')).toMatchObject({
      ok: true, number: 514, street: 'CORYDON AVE',
      neighbourhood: 'Crescentwood', cluster: 'River Heights East',
      communityArea: 'River Heights',
    });
  });

  it('bisects parity runs, keeping the two sides independent', () => {
    // Even side crosses into Earl Grey at 700; the odd side never does.
    expect(lookupAddress(idx, '698 Grosvenor Ave')).toMatchObject({ neighbourhood: 'Crescentwood' });
    expect(lookupAddress(idx, '702 Grosvenor Ave')).toMatchObject({ neighbourhood: 'Earl Grey' });
    expect(lookupAddress(idx, '701 Grosvenor Ave')).toMatchObject({ neighbourhood: 'Crescentwood' });
  });

  it('falls back to the other side when a street has addresses on one side only', () => {
    // 'MAIN ST' is a plain area index, but exercise the run fallback via a
    // street whose odd side is the only one populated below its first even run.
    expect(lookupAddress(idx, '1 Grosvenor Ave')).toMatchObject({ neighbourhood: 'Crescentwood' });
  });

  it('resolves a neighbourhood the census build has no profile for', () => {
    // Prairie Pointe is one of the 26 City neighbourhoods newer than the 2021
    // DA vintage — it still resolves, and its cluster does have data.
    expect(lookupAddress(idx, '55 Prairie Pointe')).toMatchObject({
      ok: true, neighbourhood: 'Prairie Pointe', cluster: 'Fort Garry South',
      communityArea: 'Fort Garry',
    });
  });

  it('matches streets whose name ends in a type word', () => {
    // Real cases in the City's data: expanding the last word would miss.
    expect(lookupAddress(idx, '100 The Promenade')).toMatchObject(
      { ok: true, street: 'THE PROMENADE' });
    expect(lookupAddress(idx, '12 Blairmore Gardens')).toMatchObject(
      { ok: true, street: 'BLAIRMORE GARDENS' });
  });

  it('matches punctuation-insensitively', () => {
    expect(lookupAddress(idx, "10 Governors Road")).toMatchObject({ ok: true, street: "GOVERNOR'S RD" });
    expect(lookupAddress(idx, '10 Dr David Marsh Way')).toMatchObject({ ok: true });
    expect(lookupAddress(idx, '10 St. Mary’s Rd')).toMatchObject({ ok: true, street: 'ST MARYS RD' });
  });

  it('recovers when the street type is wrong but the name is unique', () => {
    expect(lookupAddress(idx, '514 Corydon Street')).toMatchObject({ ok: true, street: 'CORYDON AVE' });
  });

  it('reports ambiguity when a bare name has several types', () => {
    const r = lookupAddress(idx, '100 Main');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.suggestions.sort()).toEqual(['MAIN AVE', 'MAIN ST']);
  });

  it('suggests near misses for an unknown street', () => {
    const r = lookupAddress(idx, '514 Corydin Ave');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-street');
    expect(r.suggestions).toContain('CORYDON AVE');
  });

  it('reports a missing house number rather than guessing', () => {
    expect(lookupAddress(idx, 'Corydon Ave')).toMatchObject({ ok: false, reason: 'no-number' });
    expect(lookupAddress(idx, '   ')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('reports no-data when the index failed to load', () => {
    expect(lookupAddress(null, '514 Corydon Ave')).toMatchObject({ ok: false, reason: 'no-data' });
  });
});

describe('loadWpgAddressIndex', () => {
  it('fetches once and shares the parsed index', async () => {
    stubFetch();
    const [a, b] = await Promise.all([loadWpgAddressIndex(), loadWpgAddressIndex()]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);                       // read-only, so one shared copy is fine
  });

  it('returns null and allows a retry when the fetch fails', async () => {
    stubFetch({}, false);
    expect(await loadWpgAddressIndex()).toBeNull();

    stubFetch();
    expect(await loadWpgAddressIndex()).not.toBeNull();
  });

  it('returns null for a malformed file', async () => {
    stubFetch({ nope: true });
    expect(await loadWpgAddressIndex()).toBeNull();
  });
});
