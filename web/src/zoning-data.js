/*
 * zoning-data.js — pure helpers for the Zoning tab (no DOM, unit-tested).
 *
 * The narrative's intent and bulk sentences are rendered in R (zoning-narrative
 * R/narrative.R) and shipped in zoning.json; only the permitted-uses sentence
 * is recomposed here, from the uses the appraiser ticks.
 */

export function oxford(items) {
  const x = items.filter(Boolean);
  if (x.length === 0) return '';
  if (x.length === 1) return x[0];
  if (x.length === 2) return `${x[0]} and ${x[1]}`;
  return `${x.slice(0, -1).join(', ')}, and ${x[x.length - 1]}`;
}

/**
 * A list of use names (matching R/narrative.R use_list): when a name itself
 * contains commas ("care home, family day care home") items are separated by
 * semicolons so each name reads as one.
 */
export function useList(items) {
  const x = items.filter(Boolean).map(s => s.replace(/\s*;\s*/g, ', '));
  if (x.length < 2 || !x.some(s => s.includes(','))) return oxford(x);
  return `${x.slice(0, -1).join('; ')}; and ${x[x.length - 1]}`;
}

/** Permitted uses an appraiser may name: principal (no accessory/mixed-use qualifier). */
export function nameableUses(zone) {
  return (zone?.uses || []).filter(u => u.status === 'P' && !u.qualifier);
}

/** Conditional uses an appraiser may name: principal (no accessory/mixed-use qualifier). */
export function nameableConditional(zone) {
  return (zone?.uses || []).filter(u => u.status === 'C' && !u.qualifier);
}

/** A use name that takes a plural verb ("livestock operations are"), matching R/narrative.R is_plural. */
export const isPlural = (name) => /[^su]s\)?$/.test(name);

const proseList = (list) => list.map(u => u.prose || u.name.toLowerCase()).sort((a, b) => a.localeCompare(b));

/**
 * The permitted-uses sentence (matching R/narrative.R) followed by the
 * conditional-uses sentence.
 * @param {object} zone   a zone from zoning.json
 * @param {string[]} selected      permitted use names (zone.uses[].name) to name
 * @param {string[]} [selectedCond] conditional use names to name; none named ->
 *   "There are several conditional uses as well."
 */
export function usesSentence(zone, selected, selectedCond = []) {
  const pool = nameableUses(zone);
  const chosen = pool.filter(u => selected.includes(u.name));
  const condPool = nameableConditional(zone);
  const condChosen = condPool.filter(u => selectedCond.includes(u.name));
  // only principal conditional uses make "several conditional uses" true (matches R/narrative.R)
  const hasCond = (zone?.uses || []).some(u => u.status === 'C' && u.qualifier !== 'accessory_only');
  const hasPerm = (zone?.uses || []).some(u => u.status === 'P');
  const allCond = !hasPerm && hasCond;
  let s;
  // an overlay that only changes figures, or only takes uses away, has no uses sentence
  if (zone?.category === 'overlay' && !hasPerm && !hasCond) return '';
  const prose = (u) => u.prose || u.name.toLowerCase();
  if (zone?.category === 'overlay' && chosen.length) {
    s = `Within the overlay, permitted uses include ${useList(proseList(chosen))}${chosen.length < pool.length ? ', among others' : ''}.`;
  } else if (chosen.length === 1 && pool.length === 1) {
    s = `The permitted use within the current zoning designation is ${proseList(chosen)[0]}.`;
  } else if (chosen.length) {
    const more = chosen.length < pool.length;
    s = `Some permitted uses within the current zoning designation include ${useList(proseList(chosen))}${more ? ', among others' : ''}.`;
  } else if (allCond && zone?.category === 'overlay') {
    // name the overlay's conditional uses in one sentence (matches R/narrative.R)
    if (condChosen.length) {
      const more = condChosen.length < condPool.length;
      const verb = condChosen.length > 1 ? 'are conditional uses' : isPlural(prose(condChosen[0])) ? 'are a conditional use' : 'is a conditional use';
    return `Within the overlay, ${useList(proseList(condChosen))}${more ? ', among others,' : ''} ${verb}.`;
    }
    return 'The uses the overlay lists are all conditional uses.';
  } else if (allCond) {
    s = 'All uses listed for this zone are conditional uses.';
  } else if (!hasPerm) {
    s = 'The by-law lists no uses for this zone.';
  } else {
    s = 'The zone lists no permitted uses other than accessory and utility uses.';
  }
  if (condChosen.length) {
    const more = condChosen.length < condPool.length;
    s += ` ${allCond ? 'They include' : 'Conditional uses include'} ${useList(proseList(condChosen))}${more ? ', among others' : ''}.`;
  } else if (hasCond && !allCond) {
    // one principal conditional use is not "several" (matches R/narrative.R)
    const pc = [...new Set((zone?.uses || []).filter(u => u.status === 'C' && u.qualifier !== 'accessory_only').map(u => u.name))];
    const one = pc.length === 1 ? zone.uses.find(u => u.status === 'C' && u.name === pc[0]) : null;
    if (one && zone.uses.some(u => u.status === 'P' && u.name === one.name)) {
      s += ` Larger ${prose(one)} ${isPlural(prose(one)) ? 'are' : 'is'} a conditional use.`;
    } else if (one) {
      s += ` There is also one conditional use: ${prose(one)}.`;
    } else {
      s += ' There are several conditional uses as well.';
    }
  }
  return s;
}

/** Full narrative as paragraphs: intent, uses, bulk, parking, overlay. */
export function narrativeParagraphs(zone, selected, selectedCond = []) {
  const n = zone?.narrative || {};
  return [n.intent, usesSentence(zone, selected, selectedCond), n.bulk, n.parking, n.overlay].filter(Boolean);
}

// --- bulk table ---------------------------------------------------------------

export const ATTRIBUTE_LABELS = {
  min_site_area: 'Minimum site area',
  min_site_area_per_unit: 'Site area per dwelling unit',
  min_site_width: 'Minimum site width',
  min_site_depth: 'Minimum site depth',
  setback_front: 'Front yard',
  setback_side_interior: 'Side yard (interior)',
  setback_side_corner: 'Side yard (corner / flanking street)',
  setback_rear: 'Rear yard',
  min_dwelling_unit_area: 'Minimum dwelling unit area',
  max_height: 'Maximum height',
  max_site_coverage: 'Maximum site coverage',
  max_accessory_floor_area: 'Maximum accessory building floor area',
  far: 'Maximum floor area ratio',
  animal_units: 'Animal units',
  development_standard: 'Additional standard',
  parking_requirement: 'Off-street parking',
  parking_note: 'Parking note',
};

const IMPERIAL = new Set(['ft', 'sq ft', 'ac']);

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return n.toLocaleString('en-CA', { maximumFractionDigits: 3 });
}

/** "15,000 sq ft (1,393.54 sq m)" — imperial first whichever the by-law prints first. */
export function formatValue(row) {
  if (row.value == null || row.value === '') return row.value_text || '';
  let a = { v: row.value, u: row.unit }, b = { v: row.value_alt, u: row.unit_alt };
  if (!IMPERIAL.has(a.u) && IMPERIAL.has(b.u)) [a, b] = [b, a];
  const unit = (u) => (u === '%' ? '%' : u === 'ratio' || !u ? '' : ` ${u}`);
  let s = `${fmtNum(a.v)}${unit(a.u)}`;
  if (b.v != null && b.v !== '') s += ` (${fmtNum(b.v)}${unit(b.u)})`;
  if (row.value_text) s += ` — ${row.value_text}`;
  return s;
}

/**
 * Bulk rows for the principal building (accessory-building rows are left out
 * unless asked for), ordered by use type, then by a fixed attribute order.
 */
export function bulkRows(zone, { includeAccessory = false } = {}) {
  const order = Object.keys(ATTRIBUTE_LABELS);
  const rank = (a) => { const i = order.indexOf(a); return i < 0 ? 99 : i; };
  return (zone?.bulk || []).filter(r => includeAccessory || r.building !== 'accessory').sort((x, y) =>
    (x.building === 'accessory') - (y.building === 'accessory') ||
    String(x.qualifier || '').localeCompare(String(y.qualifier || '')) ||
    rank(x.attribute) - rank(y.attribute));
}

// --- currency (live check against Manitoba Zoning By-Laws open data) -----------

export const normBylaw = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/**
 * Verdict from the feature-service rows ({ZBL, ZBL_A}) for one municipality.
 * Mirrors R/currency.R: current | amended | stale | unverified.
 */
export function currencyVerdict(muni, features) {
  const rows = (features || []).map(f => f.attributes || f);
  if (!rows.length) return { status: 'unverified', inForce: [], newAmendments: [] };
  const clean = (v) => (v == null || String(v).trim() === '' || String(v).trim() === '<Null>' ? null : String(v).trim());
  const inForce = [...new Set(rows.map(r => clean(r.ZBL)).filter(Boolean))];
  const amend = [...new Set(rows.map(r => clean(r.ZBL_A)).filter(Boolean))].sort();
  const included = new Set((muni.amendments_included || []).map(normBylaw));
  const newAmendments = amend.filter(a => !included.has(normBylaw(a)));
  const baseOk = inForce.some(z => normBylaw(z) === normBylaw(muni.bylaw_no));
  const status = !baseOk ? 'stale' : newAmendments.length ? 'amended' : 'current';
  return { status, inForce, newAmendments };
}

// --- reliability -------------------------------------------------------------

// A municipality's `note` flags by-law content that needs checking; `verify_zones`
// lists the zones it covers ('all' = the whole by-law, the default for a bare note).
export function verifyApplies(muni, code) {
  if (!muni?.note) return false;
  const zones = muni.verify_zones?.length ? muni.verify_zones : ['all'];
  return zones.includes('all') || zones.includes(code);
}

export function currencyMessage(muni, v, checked) {
  const when = checked ? ` (checked ${checked})` : '';
  switch (v.status) {
    case 'current':
      return `By-law ${muni.bylaw_no} is the zoning by-law in force for ${muni.label} per Manitoba Zoning By-Laws open data${when}; no amendments beyond the parsed consolidation.`;
    case 'amended':
      return `By-law ${muni.bylaw_no} is in force for ${muni.label}${when}. Amending by-law(s) ${v.newAmendments.join(', ')} are recorded and are not reflected in the parsed consolidation; confirm none affect the subject zone.`;
    case 'stale':
      return `STALE: open data${when} shows by-law ${v.inForce.join(' / ')} in force for ${muni.label}, not ${muni.bylaw_no}. Do not rely on this table.`;
    default:
      return `Currency could not be verified against Manitoba Zoning By-Laws open data${when}.`;
  }
}

/** ArcGIS REST query URL for one municipality's by-law numbers. */
export function currencyQueryUrl(service, muniNo) {
  const p = new URLSearchParams({
    where: `MUNI_NO = ${Number(muniNo)}`,
    outFields: 'MUNI_NO,MUNI_NAME,ZBL,ZBL_A',
    returnDistinctValues: 'true', returnGeometry: 'false', f: 'json',
  });
  return `${service}?${p}`;
}

// --- zoning designation (short name + description) ----------------------------

/** "Central Commercial Zone": the zone's name, with "Zone" added when the by-law's name lacks it. */
export function zoneShortName(zone) {
  const name = String(zone?.name || '').trim();
  return /\b(zone|district|overlay|area|areas|pod)$/i.test(name) ? name : `${name} Zone`;
}

/** "The Central Commercial Zone provides for ..." from the by-law's intent clause. */
export function zoneDescription(zone) {
  let intent = String(zone?.intent || '').trim();
  if (!intent) return '';
  intent = intent.replace(/^(this zone|the zone)\s+/i, '');
  if (!/[.!?]$/.test(intent)) intent += '.';
  return `The ${zoneShortName(zone)} ${intent}`;
}
