import { describe, it, expect } from 'vitest';
import { resolveAppFolder, filterAppFiles } from '../src/app-market-data.js';

// Minimal FileSystemDirectoryHandle stand-in: { name, kind, entries() }.
function dir(name, children = []) {
  return {
    name,
    kind: 'directory',
    async *entries() { for (const c of children) yield [c.name, c]; },
  };
}
const file = (name) => ({ name, kind: 'file' });

const rental = dir('RentalDashboard', [dir('export'), dir('evidence')]);
const manitoba = dir('Manitoba', [file('manifest.json')]);
const sales = dir('SalesData', [manitoba, dir('Winnipeg')]);
const root = dir('AppMarketData', [dir('CapRates'), rental, sales]);

describe('resolveAppFolder', () => {
  it('steps down from AppMarketData to the app folder', async () => {
    expect(await resolveAppFolder(root, ['RentalDashboard'])).toBe(rental);
  });
  it('steps down two levels, from AppMarketData or the middle folder', async () => {
    expect(await resolveAppFolder(root, ['SalesData', 'Manitoba'])).toBe(manitoba);
    expect(await resolveAppFolder(sales, ['SalesData', 'Manitoba'])).toBe(manitoba);
  });
  it('keeps the app folder itself', async () => {
    expect(await resolveAppFolder(rental, ['RentalDashboard'])).toBe(rental);
    expect(await resolveAppFolder(manitoba, ['SalesData', 'Manitoba'])).toBe(manitoba);
  });
  it('is case-insensitive', async () => {
    expect(await resolveAppFolder(dir('appmarketdata', [rental]), ['rentaldashboard'])).toBe(rental);
  });
  it('leaves an off-path pick alone (export, web-data, a renamed copy)', async () => {
    const exp = dir('export', [file('manifest.json')]);
    expect(await resolveAppFolder(exp, ['RentalDashboard'])).toBe(exp);
    const other = dir('Somewhere', [dir('Else')]);
    expect(await resolveAppFolder(other, ['SalesData', 'Manitoba'])).toBe(other);
  });
  it('leaves the pick alone when the path breaks part way', async () => {
    const partial = dir('AppMarketData', [dir('SalesData', [dir('Winnipeg')])]);
    expect(await resolveAppFolder(partial, ['SalesData', 'Manitoba'])).toBe(partial);
  });
});

describe('filterAppFiles', () => {
  const f = (p) => ({ name: p.split('/').pop(), webkitRelativePath: p });
  it('keeps only the app subfolder when a parent was selected', () => {
    const list = [
      f('AppMarketData/RentalDashboard/export/manifest.json'),
      f('AppMarketData/CommercialAvailability/export/manifest.json'),
    ];
    expect(filterAppFiles(list, ['RentalDashboard']).map((x) => x.webkitRelativePath))
      .toEqual(['AppMarketData/RentalDashboard/export/manifest.json']);
  });
  it('returns everything when the app folder was selected directly', () => {
    const list = [f('export/manifest.json'), f('export/listings.csv')];
    expect(filterAppFiles(list, ['RentalDashboard'])).toHaveLength(2);
  });
});
