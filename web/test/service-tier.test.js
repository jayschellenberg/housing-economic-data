import { describe, it, expect } from 'vitest';
import { classifyServices, servicesPara } from '../src/service-tier.js';

const CORE = ['grocery', 'bank', 'clinic', 'school_hs'];

describe('classifyServices', () => {
  it('full-service = grocery, bank, clinic and a school to Grade 12', () => {
    expect(classifyServices(CORE, { pop: 3300 }).tier.key).toBe('full');
  });
  it('regional centre needs a hospital AND a population of at least 5,000', () => {
    expect(classifyServices([...CORE, 'hospital'], { pop: 17800 }).tier.key).toBe('regional');
    expect(classifyServices([...CORE, 'hospital'], { pop: 1400 }).tier.key).toBe('full');
    expect(classifyServices([...CORE, 'hospital'], { pop: null }).tier.key).toBe('full');
    expect(classifyServices(CORE, { pop: 17800 }).tier.key).toBe('full');
  });
  it('some of the four = limited; none = minimal', () => {
    expect(classifyServices(['grocery', 'clinic']).tier.key).toBe('limited');
    expect(classifyServices(['hospital']).tier.key).toBe('limited');
    expect(classifyServices(['none']).tier.key).toBe('minimal');
  });
  it('an elementary-only school does not make it full-service', () => {
    expect(classifyServices(['grocery', 'bank', 'clinic', 'school_k8']).tier.key).toBe('limited');
  });
  it('says what the next tier needs', () => {
    expect(classifyServices(['grocery', 'bank']).missing).toEqual(['Medical clinic / physician', 'School to Grade 12']);
    expect(classifyServices(CORE, { pop: 3300 }).missing).toEqual(['Hospital', 'population of at least 5,000']);
  });
});

describe('servicesPara', () => {
  it('full-service implies the four — only the hospital dependency is named', () => {
    expect(servicesPara('Niverville', CORE, { name: 'Steinbach', km: 25 }, { pop: 5900 })).toBe(
      'Niverville is a full-service community. Residents look to Steinbach (about 25 km away) for hospital services.');
  });
  it('regional centres carry no amenity list or dependency clause', () => {
    expect(servicesPara('Steinbach', [...CORE, 'hospital'], null, { pop: 17800 })).toBe(
      'Steinbach is a full-service regional centre.');
  });
  it('limited-service names the gaps', () => {
    expect(servicesPara('Hamlet', ['grocery', 'school_hs'], { name: 'Selkirk' })).toBe(
      'Hamlet is a limited-service community, with a grocery store and a school to Grade 12. ' +
      'Residents look to Selkirk for banking, medical and hospital services.');
  });
  it('minimal-service relies on the nearest centre; nothing ticked → null', () => {
    expect(servicesPara('Tiny', ['none'], { name: 'Beausejour', km: 15 })).toBe(
      'Tiny is a minimal-service community. Residents look to Beausejour (about 15 km away) for day-to-day services.');
    expect(servicesPara('X', [])).toBeNull();
  });
  it('ignores ticks saved under the old 23-item checklist', () => {
    expect(servicesPara('Old', ['pharmacy', 'fire', 'grocery'])).toContain('limited-service community, with a grocery store.');
  });
});
