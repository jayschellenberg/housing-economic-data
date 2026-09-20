import { describe, it, expect, beforeEach } from 'vitest';
import { resolveProvinces, provincesLabel, scopedSeries, resolveCanada } from '../src/agriculture.js';

// The Agriculture tab scopes its charts to the provinces checked in the
// sidebar. The selection is remembered per browser and is never empty — an
// empty one would render a page of blank cards.

describe('resolveProvinces', () => {
  beforeEach(() => localStorage.clear());

  it('restores a saved selection, in PROVS order', () => {
    // Saved in the order they happened to be checked; the tab always reads
    // west-to-east as the sidebar lists them.
    const picked = resolveProvinces(['48', '46']);
    expect(picked.map((p) => p.abbr)).toEqual(['MB', 'AB']);
  });

  it('falls back to the home province when nothing is saved', () => {
    localStorage.setItem('hed:prefs', JSON.stringify({ province: '47' }));
    expect(resolveProvinces(null).map((p) => p.abbr)).toEqual(['SK']);
  });

  it('defaults to Manitoba with no saved province at all', () => {
    expect(resolveProvinces(undefined).map((p) => p.abbr)).toEqual(['MB']);
  });

  it('ignores codes this tab does not cover rather than blanking the page', () => {
    // Ontario has no agricultural series here; a stale or hand-edited pref
    // naming it must not leave the selection empty.
    expect(resolveProvinces(['35']).map((p) => p.abbr)).toEqual(['MB']);
    expect(resolveProvinces([]).map((p) => p.abbr)).toEqual(['MB']);
    expect(resolveProvinces('46').map((p) => p.abbr)).toEqual(['MB']);
  });
});

describe('provincesLabel', () => {
  const prov = (name) => ({ name });

  it('names the provinces rather than counting them', () => {
    expect(provincesLabel([prov('Manitoba')])).toBe('Manitoba');
    expect(provincesLabel([prov('Manitoba'), prov('Saskatchewan')]))
      .toBe('Manitoba & Saskatchewan');
    expect(provincesLabel([prov('Manitoba'), prov('Saskatchewan'), prov('Alberta')]))
      .toBe('Manitoba, Saskatchewan & Alberta');
  });

  it('is empty when there is nothing to name', () => {
    expect(provincesLabel([])).toBe('');
    expect(provincesLabel()).toBe('');
  });
});

describe('scopedSeries', () => {
  const S = [{ geo: 'CA' }, { geo: 'MB' }, { geo: 'SK' }, { geo: 'AB' }, { geo: 'BC' }];
  const geos = (out) => out.map((s) => s.geo);

  it('keeps exactly the checked geographies', () => {
    // Reported against the sidebar: with only Manitoba checked, farmland was
    // still drawing all four provinces.
    expect(geos(scopedSeries(S, new Set(['MB'])))).toEqual(['MB']);
    expect(geos(scopedSeries(S, new Set(['MB', 'AB'])))).toEqual(['MB', 'AB']);
  });

  it('draws the national line when Canada is one of them', () => {
    expect(geos(scopedSeries(S, new Set(['CA', 'MB'])))).toEqual(['CA', 'MB']);
  });

  it('leaves a chart with no national series alone either way', () => {
    // Year-over-year is derived per province, so the Canada box has nothing
    // to add to it and nothing to take away.
    const noNational = [{ geo: 'MB' }, { geo: 'SK' }];
    expect(geos(scopedSeries(noNational, new Set(['CA', 'MB'])))).toEqual(['MB']);
  });

  it('tolerates a chart with no series', () => {
    expect(scopedSeries(undefined, new Set(['MB']))).toEqual([]);
  });
});

describe('resolveCanada', () => {
  it('is on until it is turned off', () => {
    // Farmland value is read against the national benchmark, so it starts on;
    // only an explicit false — the box actually unchecked — turns it off.
    expect(resolveCanada(null)).toBe(true);
    expect(resolveCanada(undefined)).toBe(true);
    expect(resolveCanada(true)).toBe(true);
    expect(resolveCanada(false)).toBe(false);
  });
});
