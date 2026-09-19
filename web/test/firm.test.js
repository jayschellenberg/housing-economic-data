import { describe, it, expect, beforeEach } from 'vitest';
import { getFirm, setFirm, onFirmChange, DEFAULT_FIRM } from '../src/firm.js';

// The company name signs every indicator chart's caption. It is set in one
// place — the header box — and every open card follows it through the change
// event rather than a re-render. It is saved per browser, so a name typed once
// is still under the charts on the next visit.

describe('firm name', () => {
  beforeEach(() => localStorage.clear());

  it('is nobody’s name until one is typed', () => {
    // The field signs every chart on the site, so an unset one must not put
    // some other firm's name under a stranger's figures.
    expect(DEFAULT_FIRM).toBe('');
    expect(getFirm()).toBe('');
  });

  it('reads back what was saved', () => {
    setFirm('JKS Consulting Inc.');
    expect(getFirm()).toBe('JKS Consulting Inc.');
  });

  it('keeps a name once it is set, which is the point of saving it', () => {
    setFirm('JKS Consulting Inc.');
    // What a fresh page load does: read the pref through a new getFirm().
    expect(JSON.parse(localStorage.getItem('hed:prefs')).firmName)
      .toBe('JKS Consulting Inc.');
    expect(getFirm()).toBe('JKS Consulting Inc.');
  });

  it('treats a cleared box as a real choice, not as "unset"', () => {
    // Someone who clears the box wants unsigned charts; it must not creep
    // back on the next load.
    setFirm('JKS Consulting Inc.');
    setFirm('');
    expect(getFirm()).toBe('');
  });

  it('trims what it is given, and tolerates nothing at all', () => {
    setFirm('  Red River Group  ');
    expect(getFirm()).toBe('Red River Group');
    setFirm(undefined);
    expect(getFirm()).toBe('');
  });

  it('tells every listener, with the new name', () => {
    const seen = [];
    const off = onFirmChange((name) => seen.push(name));
    setFirm('First');
    setFirm('Second');
    off();
    setFirm('After unsubscribing');
    expect(seen).toEqual(['First', 'Second']);
  });
});
