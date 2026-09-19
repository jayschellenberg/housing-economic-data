import { describe, it, expect } from 'vitest';
import { dashedCategories } from '../src/chart.js';

// The individual categories of a breakdown draw dashed and the aggregate
// ("Total" / "All") stays solid; a chart with no aggregate keeps every line
// solid. The aggregate is read off the canonical order, not the rendered
// domain, so a hidden "Total" doesn't flip the rest to solid.

describe('dashedCategories', () => {
  it('dashes everything but Total on a CMHC rental breakdown', () => {
    const order = ['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom +', 'Total'];
    const dashed = dashedCategories(order, order);
    expect([...dashed]).toEqual(['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom +']);
  });

  it('treats "All" (Starts & Completions) as the aggregate', () => {
    const order = ['Single', 'Semi-Detached', 'Row', 'Apartment', 'All'];
    const dashed = dashedCategories(order, order);
    expect(dashed.has('All')).toBe(false);
    expect(dashed.has('Row')).toBe(true);
  });

  it('keeps dashing the components when Total is toggled off', () => {
    const order = ['Studio', '1 Bedroom', 'Total'];
    const dashed = dashedCategories(['Studio', '1 Bedroom'], order);
    expect([...dashed]).toEqual(['Studio', '1 Bedroom']);
  });

  it('draws every line solid when the breakdown has no aggregate (Compare Areas)', () => {
    const areas = ['Winnipeg', 'Brandon', 'Steinbach'];
    expect(dashedCategories(areas, areas).size).toBe(0);
    expect(dashedCategories(areas, []).size).toBe(0);
  });
});
