#!/usr/bin/env node
// Pre-write every narrative for the Neighbourhood (Experimental) tab into
// neighbourhood.json in the AppMarketData folder. The tab reads that file; the
// site ships none of it.
//
// Two layers, as the tab's two drop-downs:
//   - Winnipeg: neighbourhood cluster (overview) → neighbourhood
//   - Manitoba municipalities: municipality (overview) → community, from the
//     town and village map sheets (r/33_build_mb_communities.R)
// Overviews and Winnipeg neighbourhoods use the Census Profile narrative
// (census-narrative.js, the same code and data the app runs); communities use
// community-narrative.js. Benchmarks are the Census tab's defaults: Winnipeg
// CMA and Manitoba.
//
//   node scripts/build-neighbourhood.mjs [output-folder]
// Output folder default: NEIGHBOURHOOD_OUT, else
// D:\Dropbox\SharedInfo\AppMarketData\AppMarketData-Internal\Neighbourhood
// Run r/27 and r/33 first when their inputs change.

/* global process, console */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const OUT_DIR = process.argv[2] || process.env.NEIGHBOURHOOD_OUT
  || 'D:/Dropbox/SharedInfo/AppMarketData/AppMarketData-Internal/Neighbourhood';

// The app's loaders fetch './data/…' — serve those from web/public.
globalThis.fetch = async (url) => {
  const f = join(PUBLIC, String(url).replace(/^\.?\//, ''));
  if (!existsSync(f)) return { ok: false, status: 404, json: async () => null, text: async () => null };
  const text = readFileSync(f, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

const { loadCensusProfile } = await import('../src/census-profile.js');
const { loadCensusIndustry } = await import('../src/census-industry.js');
const { loadCsdHighways } = await import('../src/csd-highways.js');
const { loadWpgNbhdContext } = await import('../src/wpg-nbhd-context.js');
const { cleanName } = await import('../src/geography.js');
const { buildCensusNarrative } = await import('../src/census-narrative.js');
const { buildCommunityNarrative, communitiesSentence, applyCorrections, parseCorrectionsCsv,
  communityServices, serviceChecks, serviceNearest, serviceTable } = await import('../src/community-narrative.js');

const [data, industry, highways, wpgContext] = await Promise.all([
  loadCensusProfile(), loadCensusIndustry(), loadCsdHighways(), loadWpgNbhdContext()]);
if (!data?.regions) throw new Error('census_profile.json not found under web/public/data/housing');
// OSM facilities + the hand corrections (data/mb_community_corrections.csv).
const fixes = parseCorrectionsCsv(readFileSync(join(HERE, 'data', 'mb_community_corrections.csv'), 'utf8'));
const { communities, unmatched } = applyCorrections(
  JSON.parse(readFileSync(join(HERE, 'data', 'mb_communities.json'), 'utf8')).communities, fixes);
for (const r of unmatched) console.warn(`[neighbourhood] correction matches no community: ${r.community} (${r.csd || 'any CSD'})`);

for (const r of data.regions) r.name = cleanName(r.name, r.level);
const years = (data.censusYears || []).map(String);
const period = '2021';
const byUid = new Map(data.regions.map(r => [r.uid, r]));
const benchmarks = [data.regions.find(r => r.level === 'CMA' && /^winnipeg/i.test(r.name)), byUid.get('46')];
const WPG_CSD = '4611040';
const URBAN = /\((T|VL|CY|LGD)\)$/;
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const byName = (a, b) => a.name.localeCompare(b.name);

const census = (region, services = null) => {
  const nar = buildCensusNarrative({ subject: region, benchmarks, years, period, industry, highways, wpgContext, services });
  return { blocks: nar.blocks, tables: [nar.table, nar.industryTable].filter(Boolean) };
};

const groups = [];
// Winnipeg: cluster → neighbourhoods.
const nbhds = data.regions.filter(r => r.level === 'WPG_Nbhd');
for (const cl of data.regions.filter(r => r.level === 'WPG_Cluster').sort(byName)) {
  const items = nbhds.filter(n => wpgContext?.areas?.[n.uid]?.cluster?.replace(/ - /g, '-') === cl.name.replace(/ - /g, '-'))
    .sort(byName).map(n => ({ id: n.uid, name: n.name, ...census(n) }));
  groups.push({ id: cl.uid, name: cl.name, kind: 'wpg', overview: census(cl), items });
}
// Municipalities: overview → communities.
const muniBase = (name) => name.replace(/(\s*\([^)]+\))+\s*$/, '');   // "Flin Flon (Part) (CY)" → "Flin Flon"
for (const m of data.regions.filter(r => r.level === 'CSD' && r.uid.startsWith('46') && r.uid !== WPG_CSD).sort(byName)) {
  // A town's own name is the overview, not a second-layer community — its
  // record still rates the town's service level for the overview.
  // Enclave towns (Carman, Lac du Bonnet) can land in the surrounding RM on
  // the simplified boundaries, so fall back to the same census division.
  const isSelf = (c) => fold(c.name) === fold(muniBase(m.name));
  const self = !URBAN.test(m.name) ? null : communities.find(c => c.csd === m.uid && isSelf(c))
    || communities.find(c => !c.ambiguous && c.csd?.slice(0, 4) === m.uid.slice(0, 4) && isSelf(c)) || null;
  const mine = communities.filter(c => c.csd === m.uid && c !== self);
  const commute = industry?.regions?.find(x => x.uid === m.uid)?.data?.[period]?.commute ?? null;
  const items = mine.sort(byName).map(c => ({ id: c.id, name: c.name,
    ...buildCommunityNarrative(c, m.name, { commute, commuteYear: period }) }));
  const svc = self ? communityServices(self) : null;
  const overview = census(m, svc && { checked: serviceChecks(svc), nearest: serviceNearest(self) });
  if (svc) { overview.tier = svc.tier.key; overview.tables.push(serviceTable(self, svc)); }
  const sentence = communitiesSentence(m.name, mine.map(c => c.name));
  if (sentence) {
    const i = overview.blocks.findIndex(b => b.type === 'para');
    overview.blocks.splice(i + 1, 0, { type: 'heading', text: 'Communities' }, { type: 'para', text: sentence });
  }
  groups.push({ id: m.uid, name: m.name, kind: 'muni', overview, items });
}

const payload = {
  kind: 'neighbourhood-narratives',
  generated: new Date().toISOString(),
  generatedBy: 'web/scripts/build-neighbourhood.mjs',
  period,
  benchmarks: benchmarks.map(b => b.name),
  groups,
};
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'edits'), { recursive: true });
const out = join(OUT_DIR, 'neighbourhood.json');
writeFileSync(out, JSON.stringify(payload));
const nItems = groups.reduce((n, g) => n + g.items.length, 0);
console.log(`[neighbourhood] wrote ${out}: ${groups.length} areas, ${nItems} communities/neighbourhoods`);
