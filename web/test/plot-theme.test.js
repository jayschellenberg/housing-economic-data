import { describe, it, expect } from 'vitest';
import { percentTickFormat, MIRROR_Y_MARGIN, plotWidth, plotHeight, PLOT_FALLBACK_WIDTH } from '../src/plot-theme.js';

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
