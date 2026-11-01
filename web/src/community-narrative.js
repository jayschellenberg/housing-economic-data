// Community write-ups for the Neighbourhood (Experimental) tab — the smaller
// Manitoba towns, villages and hamlets inside a municipality (Blumenort and
// Kleefeld in the RM of Hanover). The municipality itself gets the census
// community-profile narrative (census-narrative.js); this is the second layer.
//
// Input: one record from web/scripts/data/mb_communities.json (r/33): where the
// community sits (municipal main town, Winnipeg, highways), what OpenStreetMap
// shows in it, and 2021 Census counts when it is a designated place or
// population centre. Same general voice as the census narrative: no counts,
// dollars or percentages in the prose.

import { growthPhrase, joinAnd } from './census-narrative.js';
import { classifyServices, servicesPara } from './service-tier.js';

// "Hanover (RM)" → "the RM of Hanover". Unorganized divisions and reserves read
// as their own name.
const MUNI_FORM = {
  RM: 'the RM of', MU: 'the Municipality of', T: 'the Town of', VL: 'the Village of',
  CY: 'the City of', LGD: 'the Local Government District of',
};
export function muniPhrase(name) {
  const m = String(name ?? '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return String(name ?? '');
  const [, base, type] = m;
  if (MUNI_FORM[type]) return `${MUNI_FORM[type]} ${base}`;
  if (type === 'IRI') return `${base} reserve`;
  if (type === 'NO') return `unorganized territory (${base})`;
  return base;
}

// Distances: under 10 km to the kilometre, then to 5 km.
export const kmWords = (km) => km < 1 ? 'less than 1 km' : km < 10 ? `about ${Math.round(km)} km` : `about ${Math.round(km / 5) * 5} km`;

// Seasonal share of dwellings (not occupied by usual residents) worth a sentence.
export const SEASONAL_MOST = 0.5;
export const SEASONAL_SOME = 0.2;
// A larger centre this close is "nearby" for the services fallback.
export const SERVICE_MAX_KM = 60;

const plural = (n, one, many) => (n > 1 ? many : one);
const count = (f, k) => (Array.isArray(f?.[k]) ? f[k].length : Number(f?.[k] || 0));

function locationPara(c, muni) {
  const where = muniPhrase(muni);
  const wpg = c.wpg?.km != null ? `roughly ${Math.max(5, Math.round(c.wpg.km / 5) * 5)} km ${c.wpg.dir} of Winnipeg` : null;
  const parts = [];
  if (c.isCentre) {
    parts.push(`${c.name} is the main centre of ${where}${wpg ? `, ${wpg}` : ''}.`);
  } else {
    const fromCentre = c.centre ? `${kmWords(c.centre.km)} ${c.centre.dir} of ${c.centre.name}` : null;
    const rel = [fromCentre, wpg].filter(Boolean);
    parts.push(`${c.name} is a community in ${where}${rel.length ? `, ${joinAnd(rel)}` : ''}.`);
  }
  const on = [].concat(c.roads?.on || []);
  if (on.length) parts.push(`It lies on ${joinAnd(on)}.`);
  else if (c.roads?.near) parts.push(`${c.roads.near.route} passes ${kmWords(c.roads.near.km)} to the ${c.roads.near.dir}.`);
  return parts.join(' ');
}

function censusPara(c) {
  const k = c.census;
  if (!k?.pop21) return null;
  const parts = [];
  if (k.pop16 > 0) {
    const rate = (Math.pow(k.pop21 / k.pop16, 1 / 5) - 1) * 100;
    parts.push(`Between the 2016 and 2021 censuses, the community's population has ${growthPhrase(rate)}.`);
  }
  if (k.dwell > 0 && k.occ != null) {
    const seasonal = 1 - k.occ / k.dwell;
    if (seasonal >= SEASONAL_MOST) parts.push('Most of its dwellings are seasonal or recreational properties rather than year-round homes.');
    else if (seasonal >= SEASONAL_SOME) parts.push('A notable share of its dwellings are seasonal or recreational properties.');
  }
  return parts.length ? parts.join(' ') : null;
}

// Facility groups (r/33) → prose items, in reading order.
const ITEMS = {
  health: [['clinic', 'a medical clinic', 'medical clinics'], ['pharmacy', 'a pharmacy', 'pharmacies'],
    ['care_home', 'a personal care home', 'personal care homes']],
  community: [['church', 'a church', 'churches'], ['hall', 'a community hall', 'community halls'],
    ['rink', 'an arena or rink', 'arenas and rinks'], ['recreation', 'a recreation centre', 'recreation facilities'],
    ['library', 'a library', 'libraries'], ['museum', 'a museum', 'museums'], ['park', 'a park', 'parks'],
    ['golf', 'a golf course', 'golf courses'], ['campground', 'a campground', 'campgrounds'],
    ['marina', 'a marina', 'marinas'], ['childcare', 'child care', 'child care'],
    ['fire_hall', 'a fire hall', 'fire halls'], ['police', 'a police detachment', 'police detachments'],
    ['post_office', 'a post office', 'post offices']],
  commercial: [['grocery', 'a grocery store', 'grocery stores'], ['store', 'a convenience or general store', 'convenience stores'],
    ['hardware', 'a hardware or farm supply store', 'hardware and farm supply stores'], ['fuel', 'a gas station', 'gas stations'],
    ['restaurant', 'a restaurant or café', 'restaurants and cafés'], ['bank', 'a bank or credit union', 'banks and credit unions']],
};
const listItems = (f, group) => ITEMS[group].filter(([k]) => count(f, k) > 0).map(([k, one, many]) => (count(f, k) > 1 ? many : one));

// Service tier (service-tier.js, the Census Profile checklist's rule) ticked
// from the data instead of by hand: grocery, bank and clinic from
// OpenStreetMap, a school to Grade 12 from Manitoba Education's directory
// (r/33 `school_hs`). A hospital counts as the medical clinic too — rural
// health centres hold the physicians' clinic. OSM gaps can understate a tier,
// so the tab shows what was found under "Service level".
export function communityServices(c) {
  const f = c.facilities || {};
  const keys = [];
  if (count(f, 'grocery')) keys.push('grocery');
  if (count(f, 'bank')) keys.push('bank');
  if (count(f, 'clinic') || count(f, 'hospital')) keys.push('clinic');
  if (count(f, 'school_hs')) keys.push('school_hs');
  if (count(f, 'hospital')) keys.push('hospital');
  return { keys, ...classifyServices(keys, { pop: c.census?.pop21 ?? null }) };
}

export const SCHOOL_NAMED = 2;
function facilitiesPara(c) {
  const f = c.facilities || {};
  const parts = [];
  // Lead with the tier; it also says where residents go for what is missing.
  const svc = communityServices(c);
  const s = c.service;
  const nearest = s?.name && s.km <= SERVICE_MAX_KM ? { name: s.name, km: Math.round(s.km) } : null;
  parts.push(servicesPara(c.name, svc.keys.length ? svc.keys : ['none'], nearest, { pop: c.census?.pop21 ?? null }));
  // High schools from the provincial directory first (OSM often lacks them).
  const key = (n) => n.toLowerCase().replace(/school|[^a-z]/g, '');
  const schools = [...(Array.isArray(f.school_hs) ? f.school_hs : []), ...(Array.isArray(f.school) ? f.school : [])]
    .filter((n, i, all) => all.findIndex(m => key(m) === key(n)) === i);
  const nSchool = count(f, 'school');
  if (schools.length) {
    const named = schools.slice(0, SCHOOL_NAMED);
    parts.push(schools.length > SCHOOL_NAMED ? `Schools in the community include ${named.join(' and ')}.`
      : `${joinAnd(named)} ${plural(named.length, 'serves', 'serve')} the community.`);
  } else if (nSchool) {
    parts.push(`The community has ${plural(nSchool, 'a school', 'schools')}.`);
  }
  const hospitals = [].concat(Array.isArray(f.hospital) ? f.hospital : []);
  const health = listItems(f, 'health');
  if (hospitals.length) parts.push(`${joinAnd(hospitals)} ${plural(hospitals.length, 'is', 'are')} located in the community${health.length ? `, along with ${joinAnd(health)}` : ''}.`);
  else if (count(f, 'hospital')) parts.push(`The community has a hospital${health.length ? `, along with ${joinAnd(health)}` : ''}.`);
  else if (health.length) parts.push(`Health services include ${joinAnd(health)}.`);
  const community = listItems(f, 'community');
  if (community.length) parts.push(`Community facilities include ${joinAnd(community)}.`);
  const commercial = listItems(f, 'commercial');
  if (commercial.length) parts.push(`Commercial services include ${joinAnd(commercial)}.`);
  return parts.join(' ');
}

/**
 * Narrative blocks for one community (same block shapes as census-narrative:
 * title / meta / heading / para / bullet).
 * @param {object} c    mb_communities.json record
 * @param {string} muni municipality display name, e.g. "Hanover (RM)"
 */
export function buildCommunityNarrative(c, muni) {
  const blocks = [
    { type: 'title', text: `${c.name} — community profile` },
    { type: 'meta', text: 'Location: Canadian Geographical Names Database / OpenStreetMap; facilities: OpenStreetMap' +
        (c.census ? '; Statistics Canada 2021 Census' : '') },
  ];
  const push = (heading, text) => { if (text) blocks.push({ type: 'heading', text: heading }, { type: 'para', text }); };
  push('Location and access', locationPara(c, muni));
  push('Growth and housing', censusPara(c));
  push('Community facilities', facilitiesPara(c));
  blocks.push({ type: 'heading', text: 'Appraiser notes (to complete)' });
  blocks.push({ type: 'bullet', text: 'Character: [general feel, typical housing and condition of the community]' });
  if (!Object.keys(c.facilities || {}).length) blocks.push({ type: 'bullet', text: 'Facilities: [none found in OpenStreetMap — describe local services, if any]' });
  const svc = communityServices(c);
  return { blocks, flags: communityFlags(c), tier: svc.tier.key, tables: [serviceTable(c, svc)] };
}

// What the service level was read from — the tab's "Supporting figures".
export function serviceTable(c, svc = communityServices(c)) {
  const f = c.facilities || {};
  const has = (k) => svc.checked.has(k);
  const yes = (k, names) => (has(k) ? (names?.length ? names.join('; ') : 'Yes') : 'Not found');
  const named = (k) => (Array.isArray(f[k]) ? f[k] : []);
  const row = (area, value, source) => ({ area, values: [value, source] });
  return {
    title: `Service level: ${svc.tier.label}`,
    columns: ['Found', 'Source'],
    rows: [
      row('Grocery store', yes('grocery'), 'OpenStreetMap'),
      row('Bank or credit union', yes('bank'), 'OpenStreetMap'),
      row('Medical clinic (or hospital)', yes('clinic'), 'OpenStreetMap'),
      row('School to Grade 12', yes('school_hs', named('school_hs')), 'Manitoba Education school directory'),
      row('Hospital', yes('hospital', named('hospital')), 'OpenStreetMap'),
      row('Population, 2021', c.census?.pop21 != null ? c.census.pop21.toLocaleString('en-CA') : '**', 'Statistics Canada'),
    ],
  };
}

// Things the appraiser must check before relying on the write-up.
export function communityFlags(c) {
  const flags = [];
  if (c.ambiguous) flags.push(`More than one Manitoba place is named ${c.name}; the write-up uses the first ${c.source === 'OSM' ? 'OpenStreetMap' : 'Geographical Names'} record — confirm it is the community on the map sheet.`);
  if (c.source === 'OSM') flags.push('Located from OpenStreetMap only (no Geographical Names record) — confirm the location.');
  return flags;
}

// Overview add-on: "Communities within the RM of Hanover include …".
export function communitiesSentence(muni, names) {
  if (!names.length) return null;
  return names.length === 1 ? `${names[0]} is the main community within ${muniPhrase(muni)}.`
    : `Communities within ${muniPhrase(muni)} include ${joinAnd(names)}.`;
}
