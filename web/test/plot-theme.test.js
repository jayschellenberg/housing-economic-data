import { describe, it, expect } from 'vitest';
import { percentTickFormat, sfTickFormat, personsTickFormat, dateAxisTicks, MIRROR_Y_MARGIN, plotWidth, plotHeight, PLOT_FALLBACK_WIDTH } from '../src/plot-theme.js';

describe('sfTickFormat', () => {
  it('reads millions compactly, dropping trailing zeros', () => {
    const f = sfTickFormat([0, 3.6e6]);
    const ticks = [0, 5e5, 1e6, 1.5e6, 2e6, 2.5e6, 3e6, 3.5e6];
    expect(ticks.map((t, i) => f(t, i, ticks)))
      .toEqual(['0 sf', '0.5M sf', '1M sf', '1.5M sf', '2M sf', '2.5M sf', '3M sf', '3.5M sf']);
  });
  it('uses thousands on a smaller axis and raw sf on a tiny one', () => {
    expect(sfTickFormat([0, 8e5])(2.5e5)).toBe('250K sf');
    expect(sfTickFormat([0, 900])(500)).toBe('500 sf');
  });
});

describe('personsTickFormat', () => {
  it('reads a Canada-scale axis in whole millions', () => {
    const f = personsTickFormat([0, 21.1e6]);
    const ticks = [0, 5e6, 10e6, 15e6, 20e6];
    expect(ticks.map((t, i) => f(t, i, ticks))).toEqual(['0', '5M', '10M', '15M', '20M']);
  });
  it('reads a Manitoba-industry axis in thousands, never "0.1M"', () => {
    const f = personsTickFormat([14000, 102000]);
    const ticks = [20e3, 40e3, 60e3, 80e3, 100e3];
    expect(ticks.map((t, i) => f(t, i, ticks))).toEqual(['20k', '40k', '60k', '80k', '100k']);
  });
  it('adds a decimal only when ticks would otherwise collide', () => {
    const f = personsTickFormat([0, 1.6e6]);
    const ticks = [0, 2e5, 4e5, 6e5, 8e5, 1e6, 1.2e6, 1.4e6];
    expect(f(1.2e6, 6, ticks)).toBe('1.2M');
    expect(f(1e6, 5, ticks)).toBe('1M');
  });
});

describe('percentTickFormat', () => {
  it('drops to whole percents on a wide axis, like the reference chart', () => {
    const f = percentTickFormat([0, 8]);       // vacancy, or the cap-vs-rate card
    expect(f(6)).toBe('6%');
    expect(f(0)).toBe('0%');
  });

  it('keeps one place when whole percents would flatten the axis', () => {
    const f = percentTickFormat([2.4, 3.9]);   // a tight yield window
    expect(f(2.8)).toBe('2.8%');
  });

  it('keeps two places on a hair-thin spread', () => {
    const f = percentTickFormat([3.40, 3.55]);
    expect(f(3.45)).toBe('3.45%');
  });

  it('falls back to two places when the domain is unusable', () => {
    expect(percentTickFormat(undefined)(3.456)).toBe('3.46%');
    expect(percentTickFormat([NaN, NaN])(3.456)).toBe('3.46%');
  });

  it('adds places when whole percents would repeat a tick label', () => {
    const f = percentTickFormat([0, 6]);
    const ticks = [0, 0.5, 1, 1.5, 2];
    expect(ticks.map((t, i) => f(t, i, ticks))).toEqual(['0.0%', '0.5%', '1.0%', '1.5%', '2.0%']);
    const whole = [0, 1, 2, 3];
    expect(whole.map((t, i) => f(t, i, whole))).toEqual(['0%', '1%', '2%', '3%']);
  });

  it('reserves enough right margin for the mirrored axis labels', () => {
    expect(MIRROR_Y_MARGIN).toBeGreaterThan(40);
  });
});

describe('plotWidth', () => {
  it('fills the host it is given', () => {
    expect(plotWidth({ clientWidth: 831 })).toBe(831);
  });
  it('falls back to Plot\u2019s default when the host cannot be measured', () => {
    // Every tab panel but the open one is `hidden`, and a card can be built
    // before its section is attached — both measure zero.
    expect(plotWidth({ clientWidth: 0 })).toBe(PLOT_FALLBACK_WIDTH);
    expect(plotWidth(null)).toBe(PLOT_FALLBACK_WIDTH);
    expect(plotWidth(undefined, 500)).toBe(500);
  });
  it('does not draw narrower than the floor (the CSS scales it down instead)', () => {
    expect(plotWidth({ clientWidth: 240 })).toBeGreaterThanOrEqual(420);
  });
});

describe('plotHeight', () => {
  it('leaves a chart at the base width exactly as it was', () => {
    expect(plotHeight(640, 330)).toBe(330);
    expect(plotHeight(640, 340)).toBe(340);
  });
  it('grows with the width so a wide chart is not a letterbox', () => {
    expect(plotHeight(831, 330)).toBeGreaterThan(330);
    expect(plotHeight(1100, 330)).toBeGreaterThan(plotHeight(831, 330));
  });
  it('stops growing at a ceiling', () => {
    expect(plotHeight(4000, 330)).toBe(Math.round(330 * 1.3));
  });
  it('never returns a nonsense height', () => {
    expect(plotHeight(NaN, 330)).toBe(330);
    expect(plotHeight(831, undefined)).toBe(undefined);
  });
});

describe('dateAxisTicks', () => {
  const d = (s) => new Date(s + 'T00:00:00Z');
  it('puts one tick per year on a multi-year axis, labelled once each', () => {
    const { ticks, tickFormat } = dateAxisTicks(d('2021-01-01'), d('2026-09-01'));
    expect(ticks.map(tickFormat)).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
  });
  it('thins the ticks on long ranges', () => {
    const { ticks, tickFormat } = dateAxisTicks(d('1990-03-01'), d('2026-01-01'));
    expect(ticks.map(tickFormat)).toEqual(['1995', '2000', '2005', '2010', '2015', '2020', '2025']);
  });
  it('labels month and year on a short axis, at most six ticks', () => {
    const { ticks, tickFormat } = dateAxisTicks(d('2025-06-01'), d('2026-03-01'));
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(tickFormat(d('2025-09-01'))).toMatch(/Sep.*2025/);
  });
  it('uses six-monthly ticks on a 2-3 year axis', () => {
    const { ticks } = dateAxisTicks(d('2024-02-01'), d('2026-09-01'));
    expect(ticks.map(t => t.toISOString().slice(0, 7))).toEqual(['2024-07', '2025-01', '2025-07', '2026-01', '2026-07']);
  });
  it('spaces a ten-month axis every two months, on the calendar', () => {
    const { ticks } = dateAxisTicks(d('2025-11-01'), d('2026-09-01'));
    // Every second month from January: Nov, Jan, Mar, May, Jul, Sep.
    expect(ticks.map(t => t.toISOString().slice(0, 7))).toEqual(['2025-11', '2026-01', '2026-03', '2026-05', '2026-07', '2026-09']);
  });
});
