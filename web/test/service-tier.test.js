import { describe, it, expect } from 'vitest';
import { classifyServices, servicesPara, TIERS, AMENITIES } from '../src/service-tier.js';

const FULL = ['grocery', 'pharmacy', 'bank', 'school_k8', 'school_hs', 'clinic', 'munioffice', 'fire'];
const REGIONAL = [...FULL, 'hospital', 'rcmp', 'hardware', 'hotel'];

describe('classifyServices', () => {
  it('rubric keys are all real amenities', () => {
    const keys = new Set(AMENITIES.map(a => a.key));
    for (const t of TIERS) for (const r of t.requires) for (const k of (Array.isArray(r) ? r : [r])) expect(keys.has(k), k).toBe(true);
  });
  it('classes regional / full / limited / minimal', () => {
    expect(classifyServices(REGIONAL).tier.key).toBe('regional');
    expect(classifyServices(FULL).tier.key).toBe('full');
    expect(classifyServices(['convenience', 'school_k8', 'postoffice']).tier.key).toBe('limited');
    expect(classifyServices(['fuel']).tier.key).toBe('minimal');
    expect(classifyServices([]).tier.key).toBe('minimal');
  });
  it('explains what the next tier needs, with any-of groups spelled out', () => {
    const { missing } = classifyServices(['grocery', 'school_k8', 'school_hs', 'clinic', 'munioffice']);
    expect(missing).toEqual(['Pharmacy or Bank or credit union branch', 'Fire hall']);
  });
});

describe('servicesPara', () => {
  it('writes a full-service sentence and the hospital dependency', () => {
    expect(servicesPara('Niverville', FULL, { name: 'Steinbach', km: 25 })).toBe(
      'Niverville is a full-service community, with a full-line grocery store, a pharmacy, a bank or credit union, ' +
      'a K–8 school, a high school, a medical clinic, the municipal office and a fire hall. ' +
      'Residents look to Steinbach (about 25 km away) for hospital services.');
  });
  it('regional centres carry no dependency clause; empty checklist → null', () => {
    expect(servicesPara('Steinbach', REGIONAL)).not.toContain('Residents look');
    expect(servicesPara('X', [])).toBeNull();
  });
});
