import { describe, it, expect, beforeEach } from 'vitest';
import { getFirm, setFirm, onFirmChange, DEFAULT_FIRM } from '../src/firm.js';

// The company name signs every indicator chart's caption. It is shared: the
// header box, the Cap vs Interest box and every open card are views of one
// saved value, kept together by the change event rather than a re-render.

describe('firm name', () => {
  beforeEach(() => localStorage.clear());

  it('starts at the default when nothing has been saved', () => {
    expect(getFirm()).toBe(DEFAULT_FIRM);
  });

  it('reads back what was saved', () => {
    setFirm('JKS Consulting Inc.');
    expect(getFirm()).toBe('JKS Consulting Inc.');
  });

  it('treats a blank name as a real choice, not as "unset"', () => {
    // Someone who clears the box wants unsigned charts; falling back to the
    // default here would put a name they deleted back under every figure.
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
