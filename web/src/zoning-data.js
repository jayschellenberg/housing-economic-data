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

/**
 * Picker label "Alonsa (RM)" from "RM of Alonsa": name first, type in brackets, so the
 * list reads alphabetically. A trailing "(former RM of Clanwilliam)" joins the type.
 */
export function muniPickerLabel(label) {
  const m = String(label ?? '').match(/^(RM|Rural Municipality|Town|City|Village|Municipality|LGD) of (.+?)(?: \((.+)\))?$/i);
  if (!m) return String(label ?? '');
  const type = /^Rural Municipality$/i.test(m[1]) ? 'RM' : m[1];
  return `${m[2]} (${m[3] ? `${type}, ${m[3]}` : type})`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-05-13" -> "May 13, 2026"; "2025-06" -> "June 2025"; "2025" -> "2025"; anything else as given. */
export function formatPartialDate(s) {
  const m = String(s ?? '').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!m) return String(s ?? '');
  const month = m[2] ? MONTHS[Number(m[2]) - 1] : '';
  if (m[2] && !month) return String(s);
  if (m[3]) return `${month} ${Number(m[3])}, ${m[1]}`;
  return month ? `${month} ${m[1]}` : m[1];
}

/**
 * The "New by-law pending" chip for a municipality whose replacement by-law is in
 * progress (zoning.json municipality.pending: bylaw_no, stage, stage_date, detail):
 * { label: "New by-law pending: 34-2026", stage: "first reading, May 13, 2026" }, or null.
 * The table itself stays on the by-law in force.
 */
export function pendingChip(m) {
  const p = m?.pending;
  if (!p?.bylaw_no) return null;
  const when = p.stage_date ? formatPartialDate(p.stage_date) : '';
  return {
    label: `New by-law pending: ${p.bylaw_no}`,
    stage: [p.stage, when].filter(Boolean).join(', '),
    detail: p.detail || '',
  };
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

const runsText = (nums) => {
  const runs = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
};

/**
 * "p. 82" / "pp. 67–68, 82" in the page numbers printed on the by-law (`labels`:
 * muni.page_labels, PDF page -> printed). A page with no printed number is cited by
 * its position in the PDF: "p. 45; PDF p. 112". Matches R/cite.R page_ref.
 */
export function pageRef(pages, labels = {}) {
  const p = [...new Set((pages || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!p.length) return '';
  const printed = [...new Set(p.filter(n => labels?.[n] != null).map(n => String(labels[n])))];
  const pdf = p.filter(n => labels?.[n] == null);
  const out = [];
  if (printed.length) {
    const nums = printed.map(Number);
    const body = nums.every(Number.isInteger) ? runsText([...nums].sort((a, b) => a - b)) : printed.join(', ');
    out.push(`${printed.length === 1 ? 'p.' : 'pp.'} ${body}`);
  }
  if (pdf.length) out.push(`${pdf.length === 1 ? 'PDF p.' : 'PDF pp.'} ${runsText(pdf)}`);
  return out.join('; ');
}

/** One page for a table cell: the printed number, else "PDF 112". */
export function pageText(page, labels = {}) {
  if (page == null || page === '') return '';
  return labels?.[page] != null ? String(labels[page]) : `PDF ${page}`;
}

// --- use categories (R/use_category.R in zoning-narrative) ----------------------

export const USE_CATEGORIES = ['Residential', 'Agricultural', 'Retail', 'Office', 'Services', 'Automotive',
  'Food & lodging', 'Industrial', 'Institutional & public', 'Recreation & open space', 'Other'];

const catOf = (u) => (USE_CATEGORIES.includes(u.cat) ? u.cat : 'Other');

/** Categories present in a use list, in USE_CATEGORIES order, with counts. */
export function categoryCounts(list) {
  const n = new Map();
  for (const u of list || []) n.set(catOf(u), (n.get(catOf(u)) || 0) + 1);
  return USE_CATEGORIES.filter(c => n.has(c)).map(c => ({ cat: c, n: n.get(c) }));
}

/** Categories that have at least one of the named uses. */
export function categoriesOf(list, names) {
  const sel = new Set(names || []);
  return new Set((list || []).filter(u => sel.has(u.name)).map(catOf));
}

/**
 * Uses to name for the ticked categories: taken in turn from each category, most
 * common across the parsed by-laws first (uses found in nearly every zone, such as
 * public utilities, last), up to `cap` in all.
 */
export function pickByCategory(list, cats, cap = 12) {
  const want = new Set(cats);
  const rank = (a, b) => (a.generic === b.generic ? 0 : a.generic ? 1 : -1) || (b.freq || 0) - (a.freq || 0) || a.name.localeCompare(b.name);
  const pools = USE_CATEGORIES.filter(c => want.has(c))
    .map(c => (list || []).filter(u => catOf(u) === c).sort(rank));
  const out = [];
  for (let i = 0; out.length < cap && pools.some(p => i < p.length); i++) {
    for (const p of pools) if (i < p.length && out.length < cap) out.push(p[i].name);
  }
  return out;
}

/**
 * PDF pages behind the uses sentence: the pages of the uses it names; a bare
 * "several conditional uses" mention cites where the conditional uses start.
 */
// the uses the uses paragraph names (ticked permitted + ticked conditional)
function namedUses(zone, selected, selectedCond = []) {
  return (zone?.uses || []).filter(u => (u.status === 'P' && !u.qualifier && selected.includes(u.name)) ||
    (u.status === 'C' && !u.qualifier && selectedCond.includes(u.name)));
}

export function usesPages(zone, selected, selectedCond = []) {
  const uses = zone?.uses || [];
  const named = namedUses(zone, selected, selectedCond);
  const pages = named.map(u => u.page);
  if (!named.some(u => u.status === 'C')) {
    const cond = uses.filter(u => u.status === 'C' && u.qualifier !== 'accessory_only').map(u => u.page).filter(Number.isFinite);
    if (cond.length) pages.push(Math.min(...cond));
  }
  // nothing named and no conditional uses: the use table itself
  if (!pages.length) pages.push(...uses.map(u => u.page).filter(Number.isFinite).slice(0, 1));
  return pages;
}

/**
 * Full narrative as paragraphs: intent, uses, bulk, parking, overlay.
 * With `cite`, each paragraph ends with its by-law PDF page(s) from zone.cites
 * (R/cite.R, via export) — the uses sentence's pages are worked out here since
 * that sentence is recomposed from the ticked uses.
 */
export function narrativeParagraphs(zone, selected, selectedCond = [], { cite = false, labels = {} } = {}) {
  const n = zone?.narrative || {};
  const parts = [['intent', n.intent], ['uses', usesSentence(zone, selected, selectedCond)],
    ['bulk', n.bulk], ['parking', n.parking], ['overlay', n.overlay]].filter(([, t]) => t);
  if (!cite) return parts.map(([, t]) => t);
  return parts.map(([k, t]) => {
    const ref = pageRef(k === 'uses' ? usesPages(zone, selected, selectedCond) : zone?.cites?.[k]?.pages, labels);
    return ref ? `${t} (${ref})` : t;
  });
}

/** Closing source line for a cited narrative. */
export function sourceLine(muni) {
  if (!muni?.bylaw_no) return '';
  return `Source: ${muni.label} Zoning By-law ${muni.bylaw_no}${muni.consolidated_to ? ` (consolidated to ${muni.consolidated_to})` : ''}.`;
}

/** Narrative parts with a number the faithfulness check could not find in the zone's table. */
// --- Confidence (zoning-narrative R/confidence.R) ------------------------------
// Rows carry conf 'M' / 'L' (+ conf_why "reason; reason"); no conf = High. A zone whose
// rows all share one label carries it once as zone.conf = { conf, why: [] }. Each
// paragraph's label is in zone.cites[part].conf / .why (the lowest of its rows).
export const CONF_LABELS = { H: 'High', M: 'Medium', L: 'Low' };
export const CONF_LEGEND = 'High: found on its cited page in the by-law’s text. '
  + 'Medium: read by eye from a scanned page, or the by-law has a misprint here; check the page before quoting it. '
  + 'Low: flagged for verification, unclear or contradictory in the by-law, not found on its page, or a newer by-law is in force; verify before relying on it.';
const CONF_RANK = { H: 0, M: 1, L: 2 };

export function rowConfidence(row, zone) {
  const level = row?.conf || zone?.conf?.conf || 'H';
  const why = level === 'H' ? [] : row?.conf
    ? String(row.conf_why || '').split('; ').filter(Boolean)
    : (zone?.conf?.why || []);
  return { level, label: CONF_LABELS[level] || 'High', why };
}

// the lowest of several { level, why } with the reasons at that level
export function worstConfidence(items) {
  const lv = items.reduce((w, c) => (CONF_RANK[c.level] > CONF_RANK[w] ? c.level : w), 'H');
  const why = [...new Set(items.filter(c => c.level === lv).flatMap(c => c.why || []))];
  return { level: lv, label: CONF_LABELS[lv], why };
}

// one { part, level, label, why } per paragraph of the narrative, in order. The uses
// paragraph follows the uses actually ticked; the others come from the export.
export function paragraphConfidence(zone, selected, selectedCond = []) {
  const n = zone?.narrative || {};
  const parts = [['intent', n.intent], ['uses', usesSentence(zone, selected, selectedCond)],
    ['bulk', n.bulk], ['parking', n.parking], ['overlay', n.overlay]].filter(([, t]) => t);
  return parts.map(([part]) => {
    const c = zone?.cites?.[part];
    const fromExport = c?.conf ? { level: c.conf, why: c.why || [] } : rowConfidence(null, zone);
    if (part !== 'uses') return { part, ...worstConfidence([fromExport]) };
    const named = namedUses(zone, selected, selectedCond);
    const fromRows = named.map(u => rowConfidence(u, zone));
    // figures in the uses paragraph that are not in the table still lower it
    const untraced = c?.untraced?.length ? [{ level: 'L', why: ['a figure not found in the table'] }] : [];
    return { part, ...worstConfidence(named.length ? [...fromRows, ...untraced] : [fromExport]) };
  });
}

export function untracedParts(zone) {
  return Object.entries(zone?.cites || {}).filter(([, c]) => c?.untraced?.length).map(([k, c]) => ({ part: k, numbers: c.untraced }));
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
