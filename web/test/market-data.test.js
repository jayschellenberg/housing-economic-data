import { describe, it, expect } from 'vitest';
import { findSourceFolder, syncSource, SOURCES } from '../src/market-data.js';

// Minimal FileSystemDirectoryHandle stand-in: { name, kind, entries(),
// isSameEntry(), queryPermission() }.
function dir(name, children = [], { perm = 'granted' } = {}) {
  const h = {
    name,
    kind: 'directory',
    async *entries() { for (const c of children) yield [c.name, c]; },
    async isSameEntry(other) { return other === h; },
    async queryPermission() { return perm; },
  };
  return h;
}
const file = (name) => ({ name, kind: 'file' });

const capRates = dir('CapRates', [file('cap_rates.json')]);
const zoning = dir('Zoning', [file('zoning.json')]);
const sales = dir('SalesData', [dir('Winnipeg'), dir('Manitoba')]);
const amd = dir('AppMarketData', [capRates, zoning, sales]);

describe('findSourceFolder', () => {
  it('finds a subfolder of AppMarketData', async () => {
    expect(await findSourceFolder(amd, 'CapRates')).toBe(capRates);
  });
  it('is case-insensitive', async () => {
    expect(await findSourceFolder(amd, 'caprates')).toBe(capRates);
  });
  it('accepts the subfolder itself', async () => {
    expect(await findSourceFolder(zoning, 'Zoning')).toBe(zoning);
  });
  it('looks through a folder that holds AppMarketData', async () => {
    expect(await findSourceFolder(dir('SharedInfo', [amd]), 'Zoning')).toBe(zoning);
  });
  it('finds shared subfolders gathered into a folder of any name', async () => {
    expect(await findSourceFolder(dir('Market', [capRates]), 'CapRates')).toBe(capRates);
  });
  it('finds folders inside permission-tier folders', async () => {
    const ext = dir('AppMarketData-External', [capRates]);
    const int = dir('AppMarketData-Internal', [zoning]);
    const tiered = dir('AppMarketData', [ext, int]);
    expect(await findSourceFolder(tiered, 'CapRates')).toBe(capRates);
    expect(await findSourceFolder(tiered, 'Zoning')).toBe(zoning);
    expect(await findSourceFolder(int, 'Zoning')).toBe(zoning);
    expect(await findSourceFolder(dir('SharedInfo', [tiered]), 'Zoning')).toBe(zoning);
    // tier shares sitting at the top of a colleague's Dropbox
    expect(await findSourceFolder(dir('Dropbox', [ext, int]), 'CapRates')).toBe(capRates);
    expect(await findSourceFolder(tiered, 'SalesData')).toBeNull();
  });
  it('returns null when the folder is not there', async () => {
    expect(await findSourceFolder(amd, 'FCCFarmland')).toBeNull();
    expect(await findSourceFolder(dir('Other', [dir('Stuff')]), 'Zoning')).toBeNull();
  });
  it('ignores a file with the folder name', async () => {
    expect(await findSourceFolder(dir('Box', [file('Zoning')]), 'Zoning')).toBeNull();
  });
});

describe('SOURCES', () => {
  it('never reads SalesData', () => {
    expect(SOURCES.some((s) => /sales/i.test(s.folder))).toBe(false);
  });
  it('has one entry per tab id', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// A tab store stand-in that records what syncSource did to it.
function fakeStore({ saved = null, data = null, fail = null } = {}) {
  const s = {
    saved, data, imported: 0,
    async getSavedDirectory() { return s.saved; },
    async saveDirectory(h) { s.saved = h; },
    async importFromDirectory(h) {
      if (fail) throw new Error(fail);
      s.imported += 1; s.data = { from: h.name };
    },
  };
  return s;
}
const src = (store, folder = 'CapRates') => ({
  id: 'caprates', label: 'Cap Rates', folder,
  load: async () => store,
  hasData: async (s) => Boolean(s.data),
});

describe('syncSource', () => {
  it('saves the subfolder and imports into an empty tab', async () => {
    const store = fakeStore();
    expect(await syncSource(src(store), [amd])).toEqual({ status: 'loaded', imported: true });
    expect(store.saved).toBe(capRates);
    expect(store.imported).toBe(1);
  });
  it('does not re-import a tab that already has data', async () => {
    const store = fakeStore({ data: { old: true } });
    expect(await syncSource(src(store), [amd])).toEqual({ status: 'loaded' });
    expect(store.saved).toBe(capRates);
    expect(store.imported).toBe(0);
  });
  it('leaves a folder picked on the tab alone', async () => {
    const own = dir('CapRates', [], { perm: 'prompt' });
    const store = fakeStore({ saved: own });
    expect((await syncSource(src(store), [amd])).status).toBe('own-folder');
    expect(store.saved).toBe(own);
    expect(store.imported).toBe(0);
  });
  it('replaces a tab folder that was moved away', async () => {
    const moved = dir('CapRates');
    moved.entries = () => ({ next: async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); } });
    const store = fakeStore({ saved: moved, data: { old: true } });
    expect((await syncSource(src(store), [amd])).status).toBe('loaded');
    expect(store.saved).toBe(capRates);
  });
  it('keeps a tab folder it cannot list yet (no access this visit)', async () => {
    const locked = dir('CapRates', [], { perm: 'prompt' });
    locked.entries = () => ({ next: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } });
    const store = fakeStore({ saved: locked });
    expect((await syncSource(src(store), [amd])).status).toBe('own-folder');
  });
  it('replaces a tab folder Chrome can no longer open', async () => {
    const gone = dir('CapRates', [], { perm: 'denied' });
    const store = fakeStore({ saved: gone });
    expect((await syncSource(src(store), [amd])).status).toBe('loaded');
    expect(store.saved).toBe(capRates);
  });
  it('searches every connected folder', async () => {
    const store = fakeStore();
    const res = await syncSource(src(store, 'Zoning'), [dir('Market', [capRates]), dir('Other', [zoning])]);
    expect(res.status).toBe('loaded');
    expect(store.saved).toBe(zoning);
  });
  it('reports not-shared, or locked while a folder awaits Allow', async () => {
    expect((await syncSource(src(fakeStore(), 'FCCFarmland'), [amd])).status).toBe('not-shared');
    expect((await syncSource(src(fakeStore(), 'FCCFarmland'), [amd], { anyLocked: true })).status).toBe('locked');
  });
  it('reports an import failure without throwing', async () => {
    const res = await syncSource(src(fakeStore({ fail: 'bad file' })), [amd]);
    expect(res).toEqual({ status: 'error', message: 'bad file' });
  });
});
