import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMuniIndex, neighboursOf, effectiveMunis, groupByRegion, UNGROUPED } from '../src/lib/munis.js';
import { UNASSIGNED } from '../src/lib/filters.js';

const RAW = [
  { muni_no: 400, name: 'TOWN OF ALTONA', list_name: 'ALTONA (TOWN)', region: 'South-Central / Central Plains', adjacent: ['164'] },
  { muni_no: 164, name: 'RM OF RHINELAND', list_name: 'RHINELAND (RM)', region: 'South-Central / Central Plains', adjacent: ['400', '203'] },
  { muni_no: 203, name: 'RM OF STANLEY', list_name: 'STANLEY (RM)', region: 'South-Central / Central Plains', adjacent: ['164'] },
  { muni_no: 100, name: 'CITY OF WINNIPEG', list_name: 'WINNIPEG (CITY)', region: 'Winnipeg', adjacent: ['198'] },
  { muni_no: 198, name: 'RM OF SPRINGFIELD', list_name: 'SPRINGFIELD (RM)', region: 'Southeast', adjacent: ['100'] },
  { muni_no: 999, name: 'NOWHERE' },                        // missing fields tolerated
  { name: 'no number' },                                    // dropped
];
const index = buildMuniIndex(RAW);

test('buildMuniIndex tolerates sparse rows', () => {
  assert.equal(index.byNo.size, 6);
  assert.equal(index.byName.get('NOWHERE').region, UNGROUPED);
  assert.deepEqual(index.byName.get('NOWHERE').adjacent, []);
  assert.equal(index.byNo.get('400').list_name, 'ALTONA (TOWN)');
});

test('neighboursOf: one hop, excludes picks, honours availability', () => {
  assert.deepEqual([...neighboursOf(['TOWN OF ALTONA'], index)], ['RM OF RHINELAND']);
  assert.deepEqual([...neighboursOf(['TOWN OF ALTONA', 'RM OF RHINELAND'], index)].sort(), ['RM OF STANLEY']);
  assert.deepEqual([...neighboursOf(['TOWN OF ALTONA'], index, new Set(['TOWN OF ALTONA']))], []);
  assert.deepEqual([...neighboursOf(['UNKNOWN'], index)], []);
});

test('effectiveMunis', () => {
  assert.deepEqual(effectiveMunis({ munis: [] }, index), []);
  assert.deepEqual(effectiveMunis({ munis: ['TOWN OF ALTONA'], adjacent: false }, index), ['TOWN OF ALTONA']);
  assert.deepEqual(effectiveMunis({ munis: ['TOWN OF ALTONA'], adjacent: true }, index), ['TOWN OF ALTONA', 'RM OF RHINELAND']);
  assert.deepEqual(effectiveMunis({ munis: ['TOWN OF ALTONA'], adjacent: true, muniExcluded: ['RM OF RHINELAND'] }, index), ['TOWN OF ALTONA']);
  assert.deepEqual(effectiveMunis({ munis: ['TOWN OF ALTONA'], adjacent: true }, null), ['TOWN OF ALTONA']);
});

test('groupByRegion: alphabetical regions, Other last, unassigned last in Other', () => {
  const tally = [
    { value: 'CITY OF WINNIPEG', count: 11921 }, { value: UNASSIGNED, count: 936 },
    { value: 'TOWN OF ALTONA', count: 5 }, { value: 'RM OF RHINELAND', count: 2 }, { value: 'MYSTERY TOWN', count: 1 },
  ];
  const g = groupByRegion(tally, index);
  assert.deepEqual(g.map((x) => x.region), ['South-Central / Central Plains', 'Winnipeg', UNGROUPED]);
  assert.deepEqual(g[0].rows.map((r) => r.label), ['ALTONA (TOWN)', 'RHINELAND (RM)']);
  assert.deepEqual(g[2].rows.map((r) => r.name), ['MYSTERY TOWN', UNASSIGNED]);
  assert.equal(g[2].rows[1].label, '(unassigned — outside every polygon)');
  assert.equal(g[1].rows[0].muni_no, '100');
});
