import { describe, it, expect } from 'vitest';
import {
  catValue, columnValue, egiOf, totalExpenses, utilitiesTotal, normalize, filterRecords,
  summarize, kindGroup, isProjected, heatGroup, sameProperty, sortRecords, COLUMNS,
} from '../src/apartment-comps-data.js';

const dbRow = {
  id: 'db:Wpg MF Comps:35', src: 'db', kind: 'Closed Sale', ptype: 'apartment', date: '2025-09-22',
  address: '1518 Logan Ave', key: '1518 logan', suites: 4, yr: 2019, price: 625000, heat: 'Gas Boiler',
  pays: { hydro: 'Y', heat: 'N', water: 'N' },
  inc: { rent: { v: 62280 }, other_income: { v: 3060 }, vacancy: { v: 1960.2, a: 1 } },
  exp: { tax: { v: 7719 }, insurance: { v: 3015 }, water: { v: 2872 }, rm: { v: 3200, a: 1 }, mgmt: { v: 3802.79, a: 1 } },
  egi: 63379.8, noi: 42771, cap: 0.0684,
};
const docRow = {
  id: 'doc:7:1', src: 'doc', kind: 'cim', conf: 1, ptype: 'apartment', date: '2025-09',
  address: '568 Agnes St', key: '568 agnes', suites: 11, scenario: 'stabilized', period: 'Year 1',
  inc: { rent: { v: 133320 }, vacancy: { v: 15060 } },
  exp: { tax: { v: 9000 }, heat_hydro: { v: 12000 }, payroll: { v: 6000 } },
};
const listing = { id: 'doc:11', src: 'doc', kind: 'listing', ptype: 'apartment', date: '2022-12', address: '472 Balmoral St', key: '472 balmoral', suites: 15, checked: 1 };

describe('apartment comps figures', () => {
  it('leaves database allowances out unless asked', () => {
    expect(catValue(dbRow, 'rm')).toBeNull();
    expect(catValue(dbRow, 'rm', { assumed: true })).toBe(3200);
    expect(totalExpenses(dbRow)).toBeCloseTo(7719 + 3015 + 2872);
    expect(totalExpenses(dbRow, { assumed: true })).toBeCloseTo(7719 + 3015 + 2872 + 3200 + 3802.79);
    expect(columnValue(dbRow, ['rm', 'mgmt'], { assumed: true }).assumed).toBe(true);
  });

  it('uses stated EGI, else income less vacancy', () => {
    expect(egiOf(dbRow)).toBe(63379.8);
    expect(egiOf(docRow)).toBe(133320 - 15060);
    expect(egiOf(listing)).toBeNull();
  });

  it('normalizes per suite and by EGI', () => {
    expect(normalize(8000, dbRow, 'suite')).toBe(2000);
    expect(normalize(6337.98, dbRow, 'egi')).toBeCloseTo(0.1);
    expect(normalize(100, { suites: null }, 'suite')).toBeNull();
    expect(normalize(100, dbRow, 'annual')).toBe(100);
  });

  it('counts combined utility lines in all utilities only', () => {
    expect(utilitiesTotal(docRow)).toBe(12000);
    const util = COLUMNS.find(c => c.id === 'util_comb');
    expect(columnValue(docRow, util.cats).v).toBe(12000);
    expect(columnValue(docRow, ['hydro'])).toBeNull();
  });

  it('classifies kinds, projections and heat', () => {
    expect(kindGroup(dbRow)).toBe('sale');
    expect(kindGroup(docRow)).toBe('cim');
    expect(kindGroup({ src: 'db', kind: 'Withdrawn' })).toBe('expired');
    expect(isProjected(docRow)).toBe(true);
    expect(isProjected({ scenario: 'actual', period: '2024 actual' })).toBe(false);
    expect(heatGroup(dbRow)).toBe('gas');
    expect(heatGroup({ heat: 'Electric Baseboards' })).toBe('electric');
    expect(heatGroup({ heat: 'Individ-Furnace' })).toBe('furnace');
  });
});

describe('filtering and summary', () => {
  const all = [dbRow, docRow, listing];
  const base = { kinds: new Set(['sale', 'cim', 'listing']), showConf: true };

  it('filters by expenses, confidentiality, dates, year built and utilities', () => {
    expect(filterRecords(all, { ...base, withExpenses: true }).map(r => r.id)).toEqual([dbRow.id, docRow.id]);
    expect(filterRecords(all, { ...base, showConf: false }).map(r => r.id)).toEqual([dbRow.id, listing.id]);
    expect(filterRecords(all, { ...base, dateFrom: '2025-01' }).length).toBe(2);
    expect(filterRecords(all, { ...base, yrFrom: 2000 }).map(r => r.id)).toEqual([dbRow.id]);
    expect(filterRecords(all, { ...base, pays: { hydro: 'Y' } }).map(r => r.id)).toEqual([dbRow.id]);
    expect(filterRecords(all, { ...base, q: 'agnes' }).map(r => r.id)).toEqual([docRow.id]);
    expect(filterRecords(all, { ...base, projected: 'actual' }).map(r => r.id)).toEqual([dbRow.id, listing.id]);
    expect(filterRecords(all, { ...base, unchecked: true }).map(r => r.id)).toEqual([docRow.id]);
  });

  it('summarizes per suite over the records that have each category', () => {
    const s = summarize([dbRow, docRow], { mode: 'suite' });
    const tax = s.find(x => x.id === 'tax');
    expect(tax.n).toBe(2);
    expect(tax.median).toBeCloseTo((7719 / 4 + 9000 / 11) / 2);
    expect(s.find(x => x.id === 'rm').n).toBe(0);
    expect(summarize([dbRow, docRow], { mode: 'suite', assumed: true }).find(x => x.id === 'rm').n).toBe(1);
  });

  it('finds other records of the same property and sorts with blanks last', () => {
    const relist = { ...listing, id: 'doc:10', date: '2022-10' };
    expect(sameProperty([...all, relist], listing).map(r => r.id)).toEqual(['doc:10']);
    const sorted = sortRecords(all, 'yr', 'desc', { mode: 'suite' });
    expect(sorted[0].id).toBe(dbRow.id);
  });
});
