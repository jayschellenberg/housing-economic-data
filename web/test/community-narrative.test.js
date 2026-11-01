import { describe, it, expect } from 'vitest';
import { buildCommunityNarrative, muniPhrase, kmWords, communitiesSentence, communityFlags } from '../src/community-narrative.js';

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
    expect(t).toContain('For groceries and most other shopping, residents travel to Steinbach, about 15 km to the east.');
    const bare = paras(buildCommunityNarrative(base, 'Hanover (RM)').blocks);
    expect(bare).toContain('There are few local commercial services; residents rely on Steinbach, about 15 km to the east, for shopping and most services.');
  });

  it('flags names that need checking and lists the overview communities', () => {
    expect(communityFlags({ ...base, ambiguous: true })[0]).toMatch(/More than one Manitoba place is named Kleefeld/);
    expect(communityFlags(base)).toEqual([]);
    expect(communitiesSentence('Hanover (RM)', ['Blumenort', 'Grunthal', 'Kleefeld']))
      .toBe('Communities within the RM of Hanover include Blumenort, Grunthal and Kleefeld.');
  });
});
