import { describe, it, expect } from 'vitest';
import { leaseCrspiSeries } from '../src/cost-lease-tabs.js';

describe('leaseCrspiSeries', () => {
  it('uses the geography\'s own total for all building types', () => {
    expect(leaseCrspiSeries('winnipeg', 'total')).toEqual({ id: 'statscan.crspi.winnipeg.total', region: 'local' });
  });

  it('takes the Prairie Region split for a prairie geography', () => {
    expect(leaseCrspiSeries('winnipeg', 'office')).toEqual({ id: 'statscan.crspi.prairie.office', region: 'prairie' });
    expect(leaseCrspiSeries('manitoba', 'industrial').id).toBe('statscan.crspi.prairie.industrial');
    expect(leaseCrspiSeries('calgary', 'retail').region).toBe('prairie');
  });

  it('takes the national split anywhere else', () => {
    expect(leaseCrspiSeries('vancouver', 'retail')).toEqual({ id: 'statscan.crspi.canada.retail', region: 'canada' });
    expect(leaseCrspiSeries('canada', 'office').id).toBe('statscan.crspi.canada.office');
  });
});
