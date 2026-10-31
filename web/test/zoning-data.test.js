import { describe, it, expect } from 'vitest';
import {
  oxford, useList, usesSentence, narrativeParagraphs, nameableConditional, formatValue, bulkRows,
  currencyVerdict, currencyMessage, currencyQueryUrl, normBylaw, zoneShortName, zoneDescription,
} from '../src/zoning-data.js';

const zone = {
  code: 'CH',
  narrative: { intent: 'This zoning accommodates highway commercial.', uses: 'x', bulk: 'The minimum lot area is 15,000 square feet.' },
  uses: [
    { name: 'Hotel / Motel', prose: 'hotel/motel', status: 'P', qualifier: null },
    { name: 'Retail Store, General', prose: 'general retail store', status: 'P', qualifier: null },
    { name: 'Service Station', prose: 'service station', status: 'P', qualifier: null },
    { name: 'Drive-Through Facilities', prose: 'drive-through facilities', status: 'P', qualifier: 'accessory_only' },
    { name: 'Kennel', prose: 'kennel', status: 'C', qualifier: null },
  ],
  bulk: [
    { building: 'accessory', attribute: 'setback_rear', value: '10', unit: 'ft' },
    { building: 'principal', attribute: 'max_height', value: '35', unit: 'ft' },
    { building: 'principal', attribute: 'min_site_area', value: '15000', unit: 'sq ft', value_alt: '1393.54', unit_alt: 'sq m' },
  ],
};

describe('oxford', () => {
  it('joins with serial comma', () => {
    expect(oxford(['a'])).toBe('a');
    expect(oxford(['a', 'b'])).toBe('a and b');
    expect(oxford(['a', 'b', 'c'])).toBe('a, b, and c');
  });
});

describe('usesSentence', () => {
  it('names the ticked uses alphabetically and adds "among others" when some are left out', () => {
    expect(usesSentence(zone, ['Service Station', 'Hotel / Motel'])).toBe(
      'Some permitted uses within the current zoning designation include hotel/motel and service station, among others. There is also one conditional use: kennel.');
  });
  it('omits "among others" when every nameable use is ticked; accessory-only uses do not count', () => {
    const s = usesSentence(zone, ['Hotel / Motel', 'Retail Store, General', 'Service Station']);
    expect(s).toContain('general retail store, hotel/motel, and service station.');
    expect(s).not.toContain('among others');
  });
  it('handles nothing ticked when the zone has permitted uses', () => {
    const z = { uses: [{ name: 'Hotel', prose: 'hotel', status: 'P', qualifier: null }, { name: 'Motel', prose: 'motel', status: 'P', qualifier: null }] };
    expect(usesSentence(z, [])).toBe('The zone lists no permitted uses other than accessory and utility uses.');
  });
});

describe('narrativeParagraphs', () => {
  it('is intent, uses, bulk', () => {
    const p = narrativeParagraphs(zone, ['Hotel / Motel']);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatch(/^This zoning/);
    expect(p[2]).toMatch(/^The minimum lot area/);
  });
  it('adds the parking paragraph last when the zone has one', () => {
    const z = { ...zone, narrative: { ...zone.narrative, parking: 'Off-street parking requirements are 1 space per 200 square feet.' } };
    const p = narrativeParagraphs(z, ['Hotel / Motel']);
    expect(p).toHaveLength(4);
    expect(p[3]).toMatch(/^Off-street parking/);
  });
});

describe('formatValue', () => {
  it('puts imperial first', () => {
    expect(formatValue({ value: '15000', unit: 'sq ft', value_alt: '1393.54', unit_alt: 'sq m' })).toBe('15,000 sq ft (1,393.54 sq m)');
    expect(formatValue({ value: '4.5', unit: 'm', value_alt: '15', unit_alt: 'ft' })).toBe('15 ft (4.5 m)');
  });
  it('falls back to text and handles percent', () => {
    expect(formatValue({ value: null, value_text: 'no maximum (-)' })).toBe('no maximum (-)');
    expect(formatValue({ value: '60', unit: '%' })).toBe('60%');
  });
});

describe('bulkRows', () => {
  it('shows the principal building only, site area first', () => {
    expect(bulkRows(zone).map(r => r.attribute)).toEqual(['min_site_area', 'max_height']);
  });
  it('can include accessory rows after the principal ones', () => {
    expect(bulkRows(zone, { includeAccessory: true }).map(r => r.attribute)).toEqual(['min_site_area', 'max_height', 'setback_rear']);
  });
});

describe('currency', () => {
  const muni = { label: 'RM of Macdonald', bylaw_no: '10/25', amendments_included: ['11/25'] };
  it('normalises by-law numbers', () => { expect(normBylaw('13-20')).toBe(normBylaw('13/20')); });
  it('flags new amendments', () => {
    const v = currencyVerdict(muni, [{ attributes: { ZBL: '10/25', ZBL_A: null } }, { attributes: { ZBL: '10/25', ZBL_A: '11/25' } }, { attributes: { ZBL: '10/25', ZBL_A: '9/26' } }]);
    expect(v.status).toBe('amended');
    expect(v.newAmendments).toEqual(['9/26']);
    expect(currencyMessage(muni, v, '2026-10-08')).toContain('9/26');
  });
  it('is current when nothing new, stale when the base by-law changed, unverified when empty', () => {
    expect(currencyVerdict(muni, [{ attributes: { ZBL: '10/25', ZBL_A: '<Null>' } }]).status).toBe('current');
    expect(currencyVerdict(muni, [{ attributes: { ZBL: '4/27', ZBL_A: null } }]).status).toBe('stale');
    expect(currencyVerdict(muni, []).status).toBe('unverified');
  });
  it('builds the query url', () => {
    const u = currencyQueryUrl('https://example.test/FeatureServer/0/query', 146);
    expect(u).toContain('where=MUNI_NO+%3D+146');
    expect(u).toContain('f=json');
  });
});

describe('zoning designation', () => {
  it('uses the by-law name, adding "Zone" when missing', () => {
    expect(zoneShortName({ name: 'Central Commercial Zone' })).toBe('Central Commercial Zone');
    expect(zoneShortName({ name: 'Commercial Highway' })).toBe('Commercial Highway Zone');
  });
  it('builds the description from the intent clause', () => {
    expect(zoneDescription({ name: 'Central Commercial Zone', intent: 'provides for compact mixed-use development along Park Avenue.' }))
      .toBe('The Central Commercial Zone provides for compact mixed-use development along Park Avenue.');
    expect(zoneDescription({ name: 'Agricultural Limited Zone', intent: 'is intended to provide for limited agricultural uses' }))
      .toBe('The Agricultural Limited Zone is intended to provide for limited agricultural uses.');
    expect(zoneDescription({ name: 'X', intent: '' })).toBe('');
  });
});

describe('conditional uses', () => {
  const z = {
    uses: [
      { name: 'Hotel / Motel', prose: 'hotel/motel', status: 'P', qualifier: null },
      { name: 'Planned Unit Development', prose: 'planned unit development', status: 'C', qualifier: null },
      { name: 'Single Room Occupancy', prose: 'single room occupancy', status: 'C', qualifier: null },
      { name: 'Day Care Centre', prose: 'day care centre', status: 'C', qualifier: 'accessory_only' },
    ],
  };
  it('lists principal conditional uses only', () => {
    expect(nameableConditional(z).map(u => u.name)).toEqual(['Planned Unit Development', 'Single Room Occupancy']);
  });
  it('acknowledges conditional uses when none are ticked', () => {
    expect(usesSentence(z, ['Hotel / Motel'])).toMatch(/There are several conditional uses as well\.$/);
  });
  it('names ticked conditional uses, with "among others" when some are left out', () => {
    expect(usesSentence(z, ['Hotel / Motel'], ['Single Room Occupancy'])).toMatch(/ Conditional uses include single room occupancy, among others\.$/);
    expect(usesSentence(z, ['Hotel / Motel'], ['Single Room Occupancy', 'Planned Unit Development']))
      .toMatch(/ Conditional uses include planned unit development and single room occupancy\.$/);
  });
});

describe('uses sentence edge cases', () => {
  it('names a single permitted use as "the permitted use"', () => {
    const z = { uses: [{ name: 'Public Utility Services', prose: 'public utility services', status: 'P', qualifier: null }] };
    expect(usesSentence(z, ['Public Utility Services'])).toBe('The permitted use within the current zoning designation is public utility services.');
  });
  it('says so when every listed use is conditional', () => {
    const z = { uses: [{ name: 'Utilities', prose: 'utilities', status: 'C', qualifier: null }, { name: 'Kennel', prose: 'kennel', status: 'C', qualifier: null }] };
    expect(usesSentence(z, [])).toBe('All uses listed for this zone are conditional uses.');
    expect(usesSentence(z, [], ['Kennel'])).toBe('All uses listed for this zone are conditional uses. They include kennel, among others.');
  });
  it('does not claim conditional uses when the only ones are accessory', () => {
    const z = { uses: [{ name: 'Dwelling', prose: 'dwelling', status: 'P', qualifier: null },
      { name: 'Home Industry', prose: 'home industry', status: 'C', qualifier: 'accessory_only' }] };
    expect(usesSentence(z, ['Dwelling'])).toBe('The permitted use within the current zoning designation is dwelling.');
  });
  it('handles a zone with no uses', () => {
    expect(usesSentence({ uses: [] }, [])).toBe('The by-law lists no uses for this zone.');
  });
  it('gives an overlay without listed uses no uses sentence, and appends the overlay paragraph', () => {
    const ov = { category: 'overlay', uses: [{ name: 'Gas Bar', prose: 'gas bar', status: 'X', qualifier: null }],
      narrative: { intent: 'This overlay protects the corridor.', bulk: 'b', overlay: 'Within the overlay, gas bar is not permitted.' } };
    expect(usesSentence(ov, [])).toBe('');
    expect(narrativeParagraphs(ov, [])).toEqual(['This overlay protects the corridor.', 'b', 'Within the overlay, gas bar is not permitted.']);
  });
  it('names an all-conditional overlay\'s ticked uses; overlay names take no "Zone"', () => {
    const ov = { category: 'overlay', uses: [
      { name: 'Car Wash', prose: 'car wash', status: 'C', qualifier: null },
      { name: 'Truck Stop', prose: 'truck stop', status: 'C', qualifier: null }] };
    expect(usesSentence(ov, [], ['Car Wash'])).toBe('Within the overlay, car wash, among others, is a conditional use.');
    expect(usesSentence(ov, [])).toBe('The uses the overlay lists are all conditional uses.');
    expect(zoneShortName({ name: 'Pembina Connection Zoning District Overlay' })).toBe('Pembina Connection Zoning District Overlay');
  });
  it('words overlay uses as "within the overlay", and the same use permitted small and conditional large', () => {
    const ov = { category: 'overlay', uses: [
      { name: 'Livestock Operations', prose: 'livestock operations', status: 'P', qualifier: null },
      { name: 'Livestock Operations', prose: 'livestock operations', status: 'C', qualifier: null }] };
    expect(usesSentence(ov, ['Livestock Operations'])).toBe(
      'Within the overlay, permitted uses include livestock operations. Larger livestock operations are a conditional use.');
    const lb = { category: 'overlay', uses: [{ name: 'Livestock Operations', prose: 'livestock operations', status: 'C', qualifier: null }] };
    expect(usesSentence(lb, [], ['Livestock Operations'])).toBe('Within the overlay, livestock operations are a conditional use.');
  });
  it('separates use names that contain commas with semicolons', () => {
    expect(useList(['care home, family day care home', 'school'])).toBe('care home, family day care home; and school');
    expect(useList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(useList(['offices; banks', 'x', 'y'])).toBe('offices, banks; x; and y');
  });
});
