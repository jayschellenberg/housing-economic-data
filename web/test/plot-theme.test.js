import { describe, it, expect } from 'vitest';
import { percentTickFormat, dateAxisTicks, MIRROR_Y_MARGIN, plotWidth, plotHeight, PLOT_FALLBACK_WIDTH } from '../src/plot-theme.js';

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
  it('labels month and year on a short axis', () => {
    const { ticks, tickFormat } = dateAxisTicks(d('2025-06-01'), d('2026-03-01'));
    expect(ticks).toBeUndefined();
    expect(tickFormat(d('2025-09-01'))).toMatch(/Sep.*2025/);
  });
});
