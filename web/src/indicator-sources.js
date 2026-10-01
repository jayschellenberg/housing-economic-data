/**
 * Specific source references for a Market Indicators chart, worked out from
 * the catalog (public/data/indicators/_catalog.json) the tab already loads:
 * Statistics Canada table numbers + vectors, Bank of Canada Valet series
 * codes, and the CMHC / OSB datasets.
 *
 * Two forms come back:
 *   short — fits the card's subtitle, so it rides along in the exported PNG
 *           ("Statistics Canada, Table 18-10-0205-01"). When the full list
 *           would crowd the subtitle it falls back to publisher names only.
 *   items — the complete list, with links, for the "What does this mean?"
 *           section under the card.
 *
 * Derived series (YoY, per-capita, ratios, cap-rate spreads) are resolved
 * through `derivedFrom` to the series they're calculated from, so the
 * reference is always the published table, not the app's own calculation.
 */

// Official cube titles, from WDS getCubeMetadata (cubeTitleEn). A table
// missing here still gets its number, link and DOI — just no title — so a new
// catalog table can't break the card; add its title when you add the table.
const STATCAN_TITLES = {
  '12-10-0175': 'International merchandise trade by province, commodity, and Principal Trading Partners',
  '14-10-0203': 'Average weekly earnings by industry, monthly, unadjusted for seasonality',
  '14-10-0287': 'Labour force characteristics, monthly, seasonally adjusted and trend-cycle',
  '14-10-0294': 'Labour force characteristics by census metropolitan area, three-month moving average, seasonally adjusted and unadjusted',
  '14-10-0355': 'Employment by industry, monthly, seasonally adjusted and unadjusted, and trend-cycle',
  '16-10-0048': 'Manufacturing sales by industry and province, monthly (dollars unless otherwise noted)',
  '17-10-0009': 'Population estimates, quarterly',
  '17-10-0040': 'Estimates of the components of international migration, quarterly',
  '18-10-0004': 'Consumer Price Index, monthly, not seasonally adjusted',
  '18-10-0205': 'New housing price index, monthly',
  '18-10-0258': 'Farm input price index, quarterly',
  '18-10-0260': 'Commercial rents services price index, quarterly',
  '18-10-0289': 'Building construction price indexes, by type of building and division',
  '20-10-0056': 'Monthly retail trade sales by province and territory',
  '20-10-0074': 'Wholesale trade, sales',
  '32-10-0045': 'Farm cash receipts, annual',
  '32-10-0047': 'Value per acre of farm land and buildings at July 1',
  '32-10-0077': 'Farm product prices, crops and livestock',
  '34-10-0143': 'Canada Mortgage and Housing Corporation, housing starts, under construction and completions in centres 10,000 and over, Canada, provinces, selected census metropolitan areas',
  '34-10-0292': 'Building permits, by type of structure and type of work',
  '46-10-0092': 'Asking rent and paid rent prices, by rental unit type and number of bedrooms, experimental estimates',
};

const OTHER_SOURCES = {
  osb: {
    short: 'OSB insolvency statistics',
    citation: 'Office of the Superintendent of Bankruptcy Canada — Insolvency statistics by industry (Open Government Portal)',
  },
  cmhc_arrears: {
    short: 'CMHC Mortgage Delinquency Data Tables',
    citation: 'CMHC — Mortgage delinquency rate, Canada, provinces and CMAs (CMHC data tables; Equifax Canada)',
  },
  cmhc: {
    short: 'CMHC Rental Market Survey',
    citation: 'CMHC Rental Market Survey — average rent, October survey (Housing Market Information Portal)',
  },
};

// Longest source text the subtitle carries before dropping to publisher names.
// The subtitle already holds the geographies, frequency and year range.
const SHORT_MAX = 85;

/** "18-10-0205" → "18-10-0205-01", the table number StatsCan asks you to cite. */
const tableNo = (pid) => `${pid}-01`;
/** StatsCan's DOI for a table: https://doi.org/10.25318/1810020501-eng */
const tableDoi = (pid) => `https://doi.org/10.25318/${pid.replace(/-/g, '')}01-eng`;

const joinAnd = (xs) => xs.length <= 1 ? (xs[0] || '')
  : `${xs.slice(0, -1).join(', ')} & ${xs[xs.length - 1]}`;

/**
 * @param {object} catalog — the loaded _catalog.json
 * @param {string} chartId
 * @param {Set<string>} [ids] — only these charted series (the ones on screen);
 *   omitted = every series on the chart
 * @returns {{ short: string, items: Array<{ citation: string, url?: string, detail?: string }> }}
 */
export function chartSources(catalog, chartId, ids) {
  const all = catalog.series || [];
  const byId = new Map(all.map(s => [s.id, s]));

  // Resolve each charted series to the published series behind it, keeping
  // the chart label it feeds ("Winnipeg") for the detail line.
  let derived = false;
  const bases = [];           // { s: base series, label }
  const seen = new Set();
  const resolve = (s, label, depth = 0) => {
    if (!s || depth > 4) return;
    if (s.provider === 'derived') {
      derived = true;
      const from = Array.isArray(s.derivedFrom) ? s.derivedFrom : [s.derivedFrom];
      from.forEach(id => resolve(byId.get(id), label, depth + 1));
      return;
    }
    const key = `${s.id}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    bases.push({ s, label });
  };
  all.filter(s => s.chartId === chartId && (!ids || ids.has(s.id))).forEach(s => resolve(s, s.chartLabel || s.geo || s.id));

  // Group by publisher, in first-seen order.
  const statcan = new Map();  // pid → Map(vector → labels[])
  const boc = new Map();      // seriesId → { url, labels[] }
  const other = new Map();    // provider → url
  for (const { s, label } of bases) {
    if (s.provider === 'statscan' && s.productId) {
      if (!statcan.has(s.productId)) statcan.set(s.productId, new Map());
      const vecs = statcan.get(s.productId);
      if (!vecs.has(s.vectorId)) vecs.set(s.vectorId, []);
      if (!vecs.get(s.vectorId).includes(label)) vecs.get(s.vectorId).push(label);
    } else if (s.provider === 'boc') {
      const code = s.seriesId || s.id;
      if (!boc.has(code)) boc.set(code, { url: s.sourceUrl, labels: [] });
      if (!boc.get(code).labels.includes(label)) boc.get(code).labels.push(label);
    } else if (!other.has(s.provider)) {
      other.set(s.provider, s.sourceUrl);
    }
  }

  const items = [];
  const parts = [];           // { long, short } per publisher

  if (statcan.size) {
    const pids = [...statcan.keys()];
    parts.push({
      long: pids.length === 1
        ? `Statistics Canada, Table ${tableNo(pids[0])}`
        : `Statistics Canada, Tables ${joinAnd(pids.map(tableNo))}`,
      short: 'Statistics Canada',
    });
    for (const [pid, vecs] of statcan) {
      const title = STATCAN_TITLES[pid];
      items.push({
        citation: `Statistics Canada. Table ${tableNo(pid)}${title ? `  ${title}` : ''}. DOI: ${tableDoi(pid)}`,
        url: `https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${pid.replace(/-/g, '')}01`,
        detail: 'Vectors: ' + [...vecs].map(([v, labels]) => `${v} (${labels.join(', ')})`).join('; '),
      });
    }
  }

  if (boc.size) {
    const codes = [...boc.keys()];
    const isSlos = codes.every(c => c.startsWith('SLOS_'));
    parts.push({
      long: isSlos ? 'Bank of Canada, Senior Loan Officer Survey'
        : `Bank of Canada, series ${joinAnd(codes)}`,
      short: 'Bank of Canada',
    });
    for (const [code, { url, labels }] of boc) {
      items.push({
        citation: `Bank of Canada, Valet series ${code}${isSlos ? ' (Senior Loan Officer Survey)' : ''}`,
        url,
        detail: `Used for: ${labels.join(', ')}`,
      });
    }
  }

  for (const [prov, url] of other) {
    const o = OTHER_SOURCES[prov] || { short: prov, citation: prov };
    parts.push({ long: o.short, short: o.short });
    items.push({ citation: o.citation, url });
  }

  // A calculated series (YoY, per capita, spread) says so, the way a report
  // cites "…; calculations by the author".
  // Too long for the subtitle: drop the longest part to its publisher name,
  // one at a time, so a short table number survives beside a long code list.
  const tail = derived ? ' (calculated)' : '';
  const text = parts.map(p => p.long);
  const joined = () => text.join('; ') + tail;
  while (joined().length > SHORT_MAX) {
    let i = -1;
    text.forEach((s, j) => {
      if (s !== parts[j].short && (i < 0 || s.length > text[i].length)) i = j;
    });
    if (i < 0) break;
    text[i] = parts[i].short;
  }
  return { short: joined(), items, derived };
}
