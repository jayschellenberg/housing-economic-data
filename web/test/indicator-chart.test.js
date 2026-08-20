import { describe, it, expect } from 'vitest';
import { periodLabel, yDomainFor, buildTipRows, renderDataTable, readOpenPanels } from '../src/indicator-chart.js';

const utc = (iso) => new Date(iso);

describe('periodLabel', () => {
  it('labels a monthly observation as month + year', () => {
    expect(periodLabel(utc('2023-05-01'), 'monthly')).toBe('May 2023');
  });
  it('labels a quarterly observation by quarter', () => {
    expect(periodLabel(utc('2023-04-01'), 'quarterly')).toBe('Q2 2023');
    expect(periodLabel(utc('2023-12-01'), 'quarterly')).toBe('Q4 2023');
  });
  it('labels an annual observation as the bare year', () => {
    expect(periodLabel(utc('2023-01-01'), 'annual')).toBe('2023');
  });
  it('keeps the day for daily / weekly series', () => {
    expect(periodLabel(utc('2026-05-14'), 'daily')).toBe('14 May 2026');
  });
});

describe('yDomainFor', () => {
  it('never takes a positive-only series below zero', () => {
    expect(yDomainFor([2, 3, 4])[0]).toBeGreaterThanOrEqual(0);
    // A range that reaches near zero clamps there rather than padding under it.
    expect(yDomainFor([0.05, 40])[0]).toBe(0);
  });
  it('lets a rate series that printed negative go below zero', () => {
    // Manitoba all-items CPI inflation ran -0.51% in May 2020; clamping the
    // axis at zero would draw that point outside the frame.
    const [lo, hi] = yDomainFor([-0.51, 1.2, 3.4]);
    expect(lo).toBeLessThan(-0.51);
    expect(hi).toBeGreaterThan(3.4);
  });
  it('always allows negatives for a balance of opinion', () => {
    const [lo] = yDomainFor([5, 12, 30], { balanceOfOpinion: true });
    expect(lo).toBeLessThanOrEqual(0);
  });
  it('keeps a reference band and line inside the domain', () => {
    // 2022-style readings: without this the 1-3% target band is cropped out.
    const [lo, hi] = yDomainFor([6.8, 8.1, 9.4], {
      refBand: { from: 1, to: 3 },
      refLine: { at: 2 },
    });
    expect(lo).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThanOrEqual(9.4);
  });
  it('falls back to a unit domain when nothing is finite', () => {
    expect(yDomainFor([NaN, null, undefined])).toEqual([0, 1]);
  });
});

describe('buildTipRows', () => {
  const fmt = (v) => `${v.toFixed(2)}%`;
  const points = [
    { date: utc('2023-05-01'), value: 3.4, label: 'Canada' },
    { date: utc('2023-06-01'), value: 2.8, label: 'Canada' },
    { date: utc('2023-05-01'), value: 3.45, label: 'Manitoba' },
    { date: utc('2023-06-01'), value: 3.1, label: 'Manitoba' },
  ];

  it('collapses one row per period, in date order', () => {
    const rows = buildTipRows(points, 'monthly', fmt);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => periodLabel(r.date, 'monthly'))).toEqual(['May 2023', 'Jun 2023']);
  });
  it('lists every series in the period on one tooltip', () => {
    const [may] = buildTipRows(points, 'monthly', fmt);
    expect(may.text).toBe('May 2023\nCanada: 3.40%\nManitoba: 3.45%');
  });
  it('anchors the tip between the highest and lowest line', () => {
    const [may] = buildTipRows(points, 'monthly', fmt);
    expect(may.anchor).toBeCloseTo((3.4 + 3.45) / 2, 5);
  });
  it('survives a period where every series is missing', () => {
    const rows = buildTipRows(
      [{ date: utc('2023-05-01'), value: NaN, label: 'Canada' }], 'monthly', fmt);
    expect(rows[0].anchor).toBe(0);
  });
});

describe('renderDataTable', () => {
  const fmt = (v) => `$${v}/t`;
  const seriesMeta = [{ chartLabel: 'Wheat' }, { chartLabel: 'Flaxseed' }];
  // Flaxseed reports in the older month only — the gap must render as "**",
  // which is the house convention for a missing observation.
  const periods = buildTipRows([
    { date: utc('2026-05-01'), value: 290, label: 'Wheat' },
    { date: utc('2026-05-01'), value: 660, label: 'Flaxseed' },
    { date: utc('2026-06-01'), value: 295, label: 'Wheat' },
  ], 'monthly', fmt);

  const render = () => {
    const wrap = document.createElement('div');
    const tsv = renderDataTable(wrap, periods, seriesMeta, 'monthly', fmt);
    return { wrap, tsv };
  };

  it('heads the table with Period plus one column per series', () => {
    const { wrap } = render();
    expect([...wrap.querySelectorAll('thead th')].map(th => th.textContent))
      .toEqual(['Period', 'Wheat', 'Flaxseed']);
  });
  it('orders rows newest first', () => {
    const { wrap } = render();
    expect([...wrap.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent))
      .toEqual(['Jun 2026', 'May 2026']);
  });
  it('marks a missing observation and flags the cell', () => {
    const { wrap } = render();
    const newest = wrap.querySelector('tbody tr');
    const cells = [...newest.children].map(td => td.textContent);
    expect(cells).toEqual(['Jun 2026', '$295/t', '**']);
    expect(newest.lastElementChild.className).toBe('cmhc-table-na');
  });
  it('returns the same grid as TSV for the copy button', () => {
    const { tsv } = render();
    expect(tsv.split('\n')).toEqual([
      'Period\tWheat\tFlaxseed',
      'Jun 2026\t$295/t\t**',
      'May 2026\t$290/t\t$660/t',
    ]);
  });
  it('replaces any previous table rather than appending', () => {
    const wrap = document.createElement('div');
    renderDataTable(wrap, periods, seriesMeta, 'monthly', fmt);
    renderDataTable(wrap, periods, seriesMeta, 'monthly', fmt);
    expect(wrap.querySelectorAll('table')).toHaveLength(1);
  });
});

describe('readOpenPanels', () => {
  // The Agriculture tab rebuilds its cards on every control change, so it
  // snapshots the open panels off the old card element before the wipe.
  const cardWith = ({ table = false, explainer = false } = {}) => {
    const card = document.createElement('section');
    card.className = 'cmhc-indicator-card';
    card.innerHTML =
      `<details class="cmhc-chart-table"${table ? ' open' : ''}></details>` +
      `<details class="cmhc-explainer"${explainer ? ' open' : ''}></details>`;
    return card;
  };

  it('reports nothing when both panels are closed', () => {
    expect(readOpenPanels(cardWith())).toEqual([]);
  });
  it('reports each open panel by key', () => {
    expect(readOpenPanels(cardWith({ table: true }))).toEqual(['table']);
    expect(readOpenPanels(cardWith({ explainer: true }))).toEqual(['explainer']);
    expect(readOpenPanels(cardWith({ table: true, explainer: true })))
      .toEqual(['table', 'explainer']);
  });
  it('ignores a card that has no panels at all', () => {
    expect(readOpenPanels(document.createElement('section'))).toEqual([]);
  });
  it('tolerates a missing card', () => {
    expect(readOpenPanels(null)).toEqual([]);
  });
});
