import { describe, it, expect } from 'vitest';
import { toQuarterly, chain, averageSeries, periodIndex, indexToCurrent, fmtQuarter } from '../src/index-tool-math.js';

const q = (pairs) => pairs.map(([qq, value]) => ({ q: qq, value }));

describe('toQuarterly', () => {
  it('passes a quarterly series through', () => {
    const out = toQuarterly([{ date: '2017-04-01', value: 2 }, { date: '2017-01-01', value: 1 }]);
    expect(out).toEqual([{ q: '2017-01', value: 1 }, { q: '2017-04', value: 2 }]);
  });

  it('averages monthly series and drops an incomplete last quarter', () => {
    // CPI published to August: Q3 has only two months, so the newest
    // quarter is Q2, not a two-month average posing as Q3.
    const recs = ['01', '02', '03', '04', '05', '06', '07', '08']
      .map((m, i) => ({ date: `2026-${m}-01`, value: 100 + i }));
    const out = toQuarterly(recs);
    expect(out.map((p) => p.q)).toEqual(['2026-01', '2026-04']);
    expect(out[0].value).toBeCloseTo(101);
    expect(out[1].value).toBeCloseTo(104);
  });
});

describe('chain', () => {
  it('rescales the proxy to the primary at the link quarter', () => {
    const primary = q([['2017-01', 80], ['2017-04', 84]]);
    const proxy = q([['2016-07', 45], ['2016-10', 48], ['2017-01', 50], ['2017-04', 99]]);
    const { series, linkQ } = chain(primary, proxy);
    expect(linkQ).toBe('2017-01');
    // factor 80/50 = 1.6: proxy movement only, primary level.
    expect(series.map((p) => +p.value.toFixed(2))).toEqual([72, 76.8, 80, 84]);
    expect(series.filter((p) => p.spliced).map((p) => p.q)).toEqual(['2016-07', '2016-10']);
  });

  it('returns the primary alone when the proxy misses the link quarter', () => {
    const primary = q([['2017-01', 80]]);
    expect(chain(primary, q([['2016-10', 48]]))).toEqual({ series: primary, linkQ: null });
    expect(chain(primary, null).linkQ).toBeNull();
  });
});

describe('averageSeries', () => {
  it('averages the quarters both series publish', () => {
    expect(averageSeries(q([['2000-01', 10], ['2000-04', 20]]), q([['2000-04', 30]])))
      .toEqual(q([['2000-04', 25]]));
  });
});

describe('periodIndex', () => {
  const s = q([['2019-01', 1], ['2019-04', 2], ['2019-07', 3], ['2019-10', 4], ['2020-01', 8]]);

  it('averages a full year', () => {
    expect(periodIndex(s, 2019, null)).toMatchObject({ value: 2.5, partial: false });
  });

  it('flags a year with fewer than four quarters', () => {
    expect(periodIndex(s, 2020, null)).toMatchObject({ value: 8, partial: true });
  });

  it('reads one quarter', () => {
    expect(periodIndex(s, 2019, 3)).toMatchObject({ value: 3, quarters: ['2019-07'], partial: false });
  });

  it('returns null outside the series', () => {
    expect(periodIndex(s, 2010, null)).toBeNull();
  });
});

describe('indexToCurrent', () => {
  it('scales the amount by current ÷ base', () => {
    const s = q([['2019-01', 100], ['2019-04', 100], ['2019-07', 100], ['2019-10', 100], ['2026-07', 150]]);
    const r = indexToCurrent(s, 200, 2019, null);
    expect(r.factor).toBeCloseTo(1.5);
    expect(r.indexed).toBeCloseTo(300);
    expect(r.current.q).toBe('2026-07');
    expect(r.cagr).toBeGreaterThan(5);
    expect(r.cagr).toBeLessThan(6.5);
  });
});

describe('fmtQuarter', () => {
  it('names the quarter', () => {
    expect(fmtQuarter('2017-10')).toBe('Q4 2017');
  });
});
