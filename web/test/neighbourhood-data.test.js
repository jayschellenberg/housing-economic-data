import { describe, it, expect } from 'vitest';
import { sectionsOf, applyEdit, editStatus, editRecord, plainText, wordBlocks, areaGroups, NOTES_HEADING } from '../src/neighbourhood-data.js';
import { editFileName } from '../src/neighbourhood-store.js';

const blocks = [
  { type: 'title', text: 'Kleefeld — community profile' },
  { type: 'meta', text: 'source' },
  { type: 'heading', text: 'Location and access' },
  { type: 'para', text: 'Kleefeld is a community.' },
  { type: 'para', text: 'It lies on PTH 59.' },
  { type: 'heading', text: NOTES_HEADING },
  { type: 'bullet', text: 'Character: [..]' },
  { type: 'bullet', text: 'Facilities: [..]' },
];

describe('neighbourhood sections and edits', () => {
  it('turns blocks into one text per heading', () => {
    expect(sectionsOf(blocks)).toEqual([
      { heading: 'Location and access', text: 'Kleefeld is a community.\n\nIt lies on PTH 59.' },
      { heading: NOTES_HEADING, text: '• Character: [..]\n• Facilities: [..]' },
    ]);
  });

  it('lays a saved edit over the generated text and spots stale edits', () => {
    const gen = sectionsOf(blocks);
    const fresh = applyEdit(gen, { sections: { 'Location and access': 'Mine.' }, base: { 'Location and access': gen[0].text } });
    expect(fresh[0]).toMatchObject({ text: 'Mine.', edited: true, stale: false });
    expect(fresh[1].edited).toBe(false);
    expect(editStatus(fresh)).toBe('edited');
    const stale = applyEdit(gen, { sections: { 'Location and access': 'Mine.' }, base: { 'Location and access': 'older text' } });
    expect(editStatus(stale)).toBe('stale');
    expect(editStatus(applyEdit(gen, null))).toBe('generated');
  });

  it('saves only the sections that differ', () => {
    const applied = applyEdit(sectionsOf(blocks), null);
    const rec = editRecord('C:Kleefeld', 'Kleefeld', applied, ['Mine.\r\n', applied[1].text], ' JS ');
    expect(rec).toEqual({ id: 'C:Kleefeld', name: 'Kleefeld', by: 'JS',
      sections: { 'Location and access': 'Mine.' }, base: { 'Location and access': applied[0].text } });
    expect(editRecord('x', 'x', applied, applied.map(s => s.text))).toBeNull();
    expect(editFileName('WPG_NB:St. Boniface')).toBe('WPG_NB_St_Boniface.json');
  });

  it('formats copy text and Word blocks', () => {
    const s = sectionsOf(blocks);
    expect(plainText('Kleefeld', s)).toBe(`Kleefeld\n\nLocation and access\nKleefeld is a community.\n\nIt lies on PTH 59.\n\n${NOTES_HEADING}\n• Character: [..]\n• Facilities: [..]`);
    expect(wordBlocks('Kleefeld', s, { notes: false })).toEqual([
      { type: 'heading', text: 'Kleefeld' }, { type: 'heading', text: 'Location and access' },
      { type: 'para', text: 'Kleefeld is a community.' }, { type: 'para', text: 'It lies on PTH 59.' }]);
  });

  it('groups areas Winnipeg first', () => {
    const g = areaGroups({ groups: [{ id: '1', kind: 'muni' }, { id: 'W', kind: 'wpg' }] });
    expect(g.map(x => x.areas[0].id)).toEqual(['W', '1']);
  });
});
