import { describe, it, expect } from 'vitest';
import {
  oxford, usesSentence, narrativeParagraphs, formatValue, bulkRows,
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
      'Some permitted uses within the current zoning designation include hotel/motel and service station, among others. There are several conditional uses as well.');
  });
  it('omits "among others" when every nameable use is ticked; accessory-only uses do not count', () => {
    const s = usesSentence(zone, ['Hotel / Motel', 'Retail Store, General', 'Service Station']);
    expect(s).toContain('general retail store, hotel/motel, and service station.');
    expect(s).not.toContain('among others');
  });
  it('handles nothing ticked', () => {
    expect(usesSentence({ uses: [] }, [])).toBe('The zone lists no permitted uses other than accessory and utility uses.');
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
