import { describe, it, expect } from 'vitest';
import { percentTickFormat, MIRROR_Y_MARGIN } from '../src/plot-theme.js';

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
