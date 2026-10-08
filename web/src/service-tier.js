/*
 * Service-tier rubric — turns "what does this community have" into a
 * repeatable full-service / limited-service call for the community-profile
 * narrative. DRAFT definitions (2026-10-08) for Jason to correct; the
 * definitions are the asset, so everything lives in these two tables and the
 * code only applies them.
 *
 * Rural POI data is too patchy to automate, so the inputs are a manual
 * checklist (census.js) stored per municipality in the browser. Pure module,
 * no DOM.
 */

// Amenities the checklist offers, grouped for the UI. `key` is stable (stored
// in localStorage) — rename labels/prose freely, keep keys. `label` is the
// checkbox text; `prose` is how the sentence names it.
export const AMENITY_GROUPS = [
  { group: 'Daily needs', items: [
    { key: 'grocery',     label: 'Full-line grocery store', prose: 'a full-line grocery store' },
    { key: 'convenience', label: 'Convenience store / general store only', prose: 'a convenience store' },
    { key: 'pharmacy',    label: 'Pharmacy', prose: 'a pharmacy' },
    { key: 'bank',        label: 'Bank or credit union branch', prose: 'a bank or credit union' },
    { key: 'fuel',        label: 'Fuel station', prose: 'fuel' },
    { key: 'postoffice',  label: 'Post office', prose: 'a post office' },
  ] },
  { group: 'Education', items: [
    { key: 'school_k8',   label: 'K–8 (elementary) school', prose: 'a K–8 school' },
    { key: 'school_hs',   label: 'High school (to Grade 12)', prose: 'a high school' },
    { key: 'childcare',   label: 'Licensed child care', prose: 'licensed child care' },
  ] },
  { group: 'Health', items: [
    { key: 'clinic',      label: 'Medical clinic / physician', prose: 'a medical clinic' },
    { key: 'hospital',    label: 'Hospital or health centre with emergency', prose: 'a hospital with emergency services' },
    { key: 'carehome',    label: 'Personal care home', prose: 'a personal care home' },
    { key: 'dentist',     label: 'Dentist', prose: 'a dentist' },
  ] },
  { group: 'Government and civic', items: [
    { key: 'munioffice',  label: 'Municipal (town / RM) office', prose: 'the municipal office' },
    { key: 'rcmp',        label: 'RCMP detachment / police', prose: 'an RCMP detachment' },
    { key: 'fire',        label: 'Fire hall', prose: 'a fire hall' },
    { key: 'library',     label: 'Library', prose: 'a library' },
    { key: 'arena',       label: 'Arena / community centre', prose: 'an arena and community centre' },
  ] },
  { group: 'Commerce', items: [
    { key: 'hardware',    label: 'Hardware / farm supply', prose: 'hardware and farm supply' },
    { key: 'restaurant',  label: 'Restaurant or food service', prose: 'restaurants' },
    { key: 'hotel',       label: 'Hotel / motel', prose: 'hotel accommodation' },
    { key: 'autorepair',  label: 'Auto repair / dealership', prose: 'auto repair' },
    { key: 'bigbox',      label: 'Big-box / chain retail', prose: 'big-box retail' },
  ] },
];
export const AMENITIES = AMENITY_GROUPS.flatMap(g => g.items);
const LABEL = new Map(AMENITIES.map(a => [a.key, a.label]));

// Tiers, highest first. A community gets the first tier whose every
// requirement is met; a requirement is one key or an any-of list.
//   regional  — the centre other communities drive to (Steinbach, Dauphin…)
//   full      — day-to-day life runs without leaving town
//   limited   — basics present, but schooling, medical or shopping means a trip
//   minimal   — a hamlet / bedroom community; relies on a nearby centre
export const TIERS = [
  { key: 'regional', label: 'full-service regional centre',
    requires: ['grocery', 'pharmacy', 'bank', 'school_k8', 'school_hs', 'clinic', 'hospital',
               'munioffice', 'rcmp', ['hardware', 'bigbox'], ['hotel', 'restaurant']] },
  { key: 'full', label: 'full-service community',
    requires: ['grocery', ['pharmacy', 'bank'], 'school_k8', 'school_hs', 'clinic', 'munioffice', 'fire'] },
  { key: 'limited', label: 'limited-service community',
    requires: [['grocery', 'convenience'], 'school_k8', ['munioffice', 'clinic', 'postoffice']] },
  { key: 'minimal', label: 'minimal-service community', requires: [] },
];

const has = (checked, req) => Array.isArray(req) ? req.some(k => checked.has(k)) : checked.has(req);

// `checkedKeys` = iterable of amenity keys present. Returns the tier plus what
// is missing for the next tier up (so the appraiser sees why the call landed).
export function classifyServices(checkedKeys) {
  const checked = new Set(checkedKeys);
  let idx = TIERS.findIndex(t => t.requires.every(r => has(checked, r)));
  if (idx < 0) idx = TIERS.length - 1;
  const tier = TIERS[idx];
  const next = idx > 0 ? TIERS[idx - 1] : null;
  const missing = next ? next.requires.filter(r => !has(checked, r))
    .map(r => Array.isArray(r) ? r.map(k => LABEL.get(k)).join(' or ') : LABEL.get(r)) : [];
  return { tier, next, missing, checked };
}

// Prose. `nearest` = { name, km? } for the centre a non-full community relies on.
const joinAnd = (arr) => arr.length <= 1 ? arr.join('')
  : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

export function servicesPara(name, checkedKeys, nearest = null) {
  const { tier, checked } = classifyServices(checkedKeys);
  if (!checked.size) return null;
  const present = AMENITIES.filter(a => checked.has(a.key) && a.key !== 'convenience').map(a => a.prose);
  let text = `${name} is a ${tier.label}`;
  if (present.length) text += `, with ${joinAnd(present.slice(0, 8))}${present.length > 8 ? ' among other services' : ''}`;
  text += '.';
  const gaps = [];
  if (!checked.has('school_hs')) gaps.push('high-school');
  if (!checked.has('hospital')) gaps.push('hospital');
  if (!checked.has('grocery')) gaps.push('full grocery');
  if (tier.key !== 'regional' && gaps.length) {
    const where = nearest?.name ? `${nearest.name}${nearest.km ? ` (about ${nearest.km} km away)` : ''}` : 'the nearest larger centre';
    text += ` Residents look to ${where} for ${joinAnd(gaps)} services.`;
  }
  return text;
}
