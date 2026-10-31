/*
 * Service-tier rubric — turns "what does this community have" into a
 * repeatable full-service / limited-service call for the community-profile
 * narrative. Pure module, no DOM; census.js renders the checklist and stores
 * the ticks per municipality in the browser.
 *
 * Jason's rule (2026-10-31): four things decide it — a grocery store, a
 * financial institution, a medical clinic and a school to Grade 12.
 *   regional centre   all four + a hospital + population of at least 5,000
 *                     (small places can have a hospital, so population gates it)
 *   full-service      all four
 *   limited-service   some, but not all four
 *   minimal-service   none ("None of these" ticked)
 * Nothing ticked = not filled in yet; the narrative keeps its appraiser stub.
 */

// `key` is stored in localStorage — keep keys stable, rename labels freely.
// `label` is the checkbox text, `prose` how the sentence names it, `gap` how
// "Residents look to … for … services" names it when it's missing.
export const CORE = [
  { key: 'grocery',   label: 'Grocery store',                prose: 'a grocery store',          gap: 'grocery' },
  { key: 'bank',      label: 'Bank or credit union',         prose: 'a bank or credit union',   gap: 'banking' },
  { key: 'clinic',    label: 'Medical clinic / physician',   prose: 'a medical clinic',         gap: 'medical' },
  { key: 'school_hs', label: 'School to Grade 12',           prose: 'a school to Grade 12',     gap: 'high-school' },
];
export const HOSPITAL = { key: 'hospital', label: 'Hospital', prose: 'a hospital', gap: 'hospital' };
export const NONE = { key: 'none', label: 'None of these (hamlet / bedroom community)' };
export const REGIONAL_MIN_POP = 5000;

export const AMENITY_GROUPS = [
  { group: 'Full-service needs all four', items: CORE },
  { group: 'Regional centre', items: [HOSPITAL] },
  { group: 'Or', items: [NONE] },
];
export const AMENITIES = [...CORE, HOSPITAL];
const KNOWN = new Set([...CORE, HOSPITAL, NONE].map(a => a.key));

export const TIERS = {
  regional: { key: 'regional', label: 'full-service regional centre' },
  full:     { key: 'full',     label: 'full-service community' },
  limited:  { key: 'limited',  label: 'limited-service community' },
  minimal:  { key: 'minimal',  label: 'minimal-service community' },
};

// `checkedKeys` = iterable of keys ticked; `pop` = latest census population
// (null when unknown — then a community can't be called regional).
// Returns the tier plus what the next tier up still needs.
export function classifyServices(checkedKeys, { pop = null } = {}) {
  // Only current keys count — ticks saved under the old 23-item draft
  // checklist (pharmacy, fire hall, …) are ignored.
  const checked = new Set([...checkedKeys].filter(k => KNOWN.has(k)));
  const coreMissing = CORE.filter(a => !checked.has(a.key));
  const bigEnough = pop != null && pop >= REGIONAL_MIN_POP;
  let tier, missing = [];
  if (!coreMissing.length) {
    if (checked.has(HOSPITAL.key) && bigEnough) tier = TIERS.regional;
    else {
      tier = TIERS.full;
      if (!checked.has(HOSPITAL.key)) missing.push(HOSPITAL.label);
      if (!bigEnough) missing.push(`population of at least ${REGIONAL_MIN_POP.toLocaleString('en-CA')}`);
    }
  } else {
    tier = coreMissing.length < CORE.length || checked.has(HOSPITAL.key) ? TIERS.limited : TIERS.minimal;
    missing = coreMissing.map(a => a.label);
  }
  return { tier, missing, checked };
}

const joinAnd = (arr) => arr.length <= 1 ? arr.join('')
  : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

// `nearest` = { name, km? } for the centre residents rely on. Returns null
// until something is ticked.
export function servicesPara(name, checkedKeys, nearest = null, { pop = null } = {}) {
  const { tier, checked } = classifyServices(checkedKeys, { pop });
  if (!checked.size) return null;
  // "Full-service" already implies the four (and "regional centre" the
  // hospital), so only a limited-service place spells out what it has.
  const present = AMENITIES.filter(a => checked.has(a.key)).map(a => a.prose);
  let text = `${name} is a ${tier.label}`;
  if (tier.key === 'limited' && present.length) text += `, with ${joinAnd(present)}`;
  text += '.';
  if (tier.key === 'regional') return text;
  const where = nearest?.name ? `${nearest.name}${nearest.km ? ` (about ${nearest.km} km away)` : ''}` : 'the nearest larger centre';
  const gaps = AMENITIES.filter(a => !checked.has(a.key)).map(a => a.gap);
  if (tier.key === 'minimal' || gaps.length === AMENITIES.length) {
    text += ` Residents look to ${where} for day-to-day services.`;
  } else if (gaps.length) {
    text += ` Residents look to ${where} for ${joinAnd(gaps)} services.`;
  }
  return text;
}
