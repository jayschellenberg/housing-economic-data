import { describe, it, expect } from 'vitest';
import { buildCommunityNarrative, muniPhrase, kmWords, communitiesSentence, communityFlags, communityServices,
  applyCorrections, parseCorrectionsCsv } from '../src/community-narrative.js';

const paras = (blocks) => blocks.filter(b => b.type === 'para').map(b => b.text).join('\n');
const base = {
  id: 'C:Kleefeld', name: 'Kleefeld', csd: '4602041', source: 'CGNDB', ambiguous: false, isCentre: false,
  centre: { name: 'Mitchell', km: 14.2, dir: 'southwest' }, wpg: { km: 32, dir: 'south' },
  service: { name: 'Steinbach', km: 15.4, dir: 'east' },
  roads: { on: ['PTH 59', 'PR 216'], near: null }, census: null, facilities: {},
};

describe('community narrative', () => {
  it('names the municipality in prose form', () => {
    expect(muniPhrase('Hanover (RM)')).toBe('the RM of Hanover');
    expect(muniPhrase('Killarney - Turtle Mountain (MU)')).toBe('the Municipality of Killarney - Turtle Mountain');
    expect(muniPhrase('Peguis 1B (IRI)')).toBe('Peguis 1B reserve');
    expect(kmWords(0.4)).toBe('less than 1 km');
    expect(kmWords(7.6)).toBe('about 8 km');
    expect(kmWords(14.2)).toBe('about 15 km');
  });

  it('places the community against the main town and Winnipeg, with its highways', () => {
    const t = paras(buildCommunityNarrative(base, 'Hanover (RM)').blocks);
    expect(t).toContain('Kleefeld is a community in the RM of Hanover, about 15 km southwest of Mitchell and roughly 30 km south of Winnipeg.');
    expect(t).toContain('It lies on PTH 59 and PR 216.');
  });

  it('calls the main town the centre and falls back to the nearest highway', () => {
    const t = paras(buildCommunityNarrative({ ...base, name: 'Mitchell', isCentre: true, centre: null,
      roads: { on: [], near: { route: 'PTH 12', km: 3.2, dir: 'east' } } }, 'Hanover (RM)').blocks);
    expect(t).toContain('Mitchell is the main centre of the RM of Hanover, roughly 30 km south of Winnipeg.');
    expect(t).toContain('PTH 12 passes about 3 km to the east.');
  });

  it('reads growth and seasonal dwellings from the census, without numbers', () => {
    const t = paras(buildCommunityNarrative({ ...base, census: { pop21: 2828, pop16: 2279, dwell: 883, occ: 858 } }, 'Hanover (RM)').blocks);
    expect(t).toContain("Between the 2016 and 2021 censuses, the community's population has grown strongly.");
    const lake = paras(buildCommunityNarrative({ ...base, census: { pop21: 300, pop16: 300, dwell: 900, occ: 300 } }, 'Gimli (RM)').blocks);
    expect(lake).toContain('Most of its dwellings are seasonal or recreational properties');
    expect(lake).not.toMatch(/\b(300|900)\b|%/);
  });

  it('lists facilities by kind and points to the nearest centre for what is missing', () => {
    const t = paras(buildCommunityNarrative({ ...base, facilities: {
      school: ['Kleefeld School'], church: 3, hall: 1, rink: 1, fuel: 1, store: 1,
    } }, 'Hanover (RM)').blocks);
    expect(t).toContain('Kleefeld School serves the community.');
    expect(t).toContain('Community facilities include churches, a community hall and an arena or rink.');
    expect(t).toContain('Commercial services include a convenience or general store and a gas station.');
    expect(t).toMatch(/^Kleefeld is a minimal-service community\. Residents look to Steinbach \(about \d+ km away\) for day-to-day services\./m);
  });

  it('rates the service level with the Census Profile rule', () => {
    const tier = (facilities, census = null) => communityServices({ ...base, facilities, census }).tier.key;
    expect(tier({})).toBe('minimal');
    expect(tier({ grocery: 1, school_hs: ['Green Valley School'] })).toBe('limited');
    // A hospital stands in for the medical clinic.
    expect(tier({ grocery: 2, bank: 1, hospital: ['Gimli Community Health Centre'], school_hs: ['Gimli High School'] })).toBe('full');
    expect(tier({ grocery: 8, bank: 6, clinic: 6, hospital: ['Bethesda Regional Health Centre'], school_hs: ['Steinbach Regional Secondary School'] },
      { pop21: 17589 })).toBe('regional');
    const nar = buildCommunityNarrative({ ...base, facilities: { grocery: 1, school_hs: ['Green Valley School'] } }, 'Hanover (RM)');
    expect(nar.tier).toBe('limited');
    expect(paras(nar.blocks)).toContain('Kleefeld is a limited-service community, with a grocery store and a school to Grade 12.');
    expect(paras(nar.blocks)).toMatch(/Residents look to Steinbach \(about \d+ km away\) for banking, medical and hospital services\./);
    const tbl = nar.tables[0];
    expect(tbl.title).toBe('Service level: limited-service community');
    expect(tbl.rows.find(r => r.area === 'School to Grade 12').values[0]).toBe('Green Valley School');
    expect(tbl.rows.find(r => r.area === 'Bank or credit union').values[0]).toBe('Not found');
  });

  it('applies hand corrections over OpenStreetMap and cites them', () => {
    const rows = parseCorrectionsCsv('# note\ncommunity,csd,facility,action,name,note\r\n' +
      'Kleefeld,4602041,grocery,add,,"Grocery store, per Jason"\nKleefeld,4602041,fuel,remove,,\nNowhere,,bank,add,,\n');
    expect(rows[0]).toMatchObject({ community: 'Kleefeld', facility: 'grocery', action: 'add', note: 'Grocery store, per Jason' });
    const src = [{ ...base, facilities: { fuel: 1, store: 2 } }];
    const { communities, unmatched } = applyCorrections(src, rows);
    expect(unmatched.map(r => r.community)).toEqual(['Nowhere']);
    expect(communities[0].facilities).toEqual({ store: 2, grocery: 1 });
    expect(src[0].facilities.fuel).toBe(1);                       // input left alone
    const nar = buildCommunityNarrative(communities[0], 'Hanover (RM)');
    expect(nar.tier).toBe('limited');
    expect(nar.tables[0].rows.find(r => r.area === 'Grocery store').values).toEqual(['Yes', 'Local correction']);
    // An add the data already has is reported, not cited.
    const again = applyCorrections([{ ...base, facilities: { grocery: 1 } }], rows.slice(0, 1));
    expect(again.redundant.map(r => r.facility)).toEqual(['grocery']);
    expect(again.communities[0].corrected).toBeUndefined();
  });

  it("borrows the municipality's commuting pattern, without numbers", () => {
    const commute = { total: 5125, withinCsd: 1490, otherCsdSameCd: 2830, otherCd: 775, otherProv: 30 };
    const nar = buildCommunityNarrative({ ...base, name: 'Blumenort' }, 'Hanover (RM)', { commute, commuteYear: '2021' });
    const t = paras(nar.blocks);
    expect(t).toContain('Like much of the RM of Hanover, Blumenort is largely a commuter community: most employed residents ' +
      'commute outside the municipality for work, mainly to nearby Steinbach, with some travelling to Winnipeg.');
    expect(t).not.toMatch(/%|5125/);
    expect(nar.tables[1].rows.map(r => r.values[0])).toEqual(['29%', '55%', '15%', '1%']);
    // Mostly local: nothing to say.
    const local = buildCommunityNarrative(base, 'Gimli (RM)', { commute: { total: 100, withinCsd: 63, otherCsdSameCd: 11, otherCd: 26, otherProv: 0 } });
    expect(local.blocks.some(b => b.text === 'Commuting')).toBe(false);
    // Winnipeg the main destination, a mid-sized local share.
    const split = paras(buildCommunityNarrative(base, 'Taché (RM)', { commute: { total: 100, withinCsd: 45, otherCsdSameCd: 5, otherCd: 50, otherProv: 0 } }).blocks);
    expect(split).toContain('As across the RM of Taché, many employed residents commute outside the municipality for work, mainly to Winnipeg.');
  });

  it('flags names that need checking and lists the overview communities', () => {
    expect(communityFlags({ ...base, ambiguous: true })[0]).toMatch(/More than one Manitoba place is named Kleefeld/);
    expect(communityFlags(base)).toEqual([]);
    expect(communitiesSentence('Hanover (RM)', ['Blumenort', 'Grunthal', 'Kleefeld']))
      .toBe('Communities within the RM of Hanover include Blumenort, Grunthal and Kleefeld.');
  });
});
