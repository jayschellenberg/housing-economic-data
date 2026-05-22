# Market Indicators Tab — Build Plan (v2, revised)

A planning document for a new "Market Indicators" tab on
[cmhc-charts](https://cmhc-charts.vercel.app/). One tab, grouped sections,
appraiser-focused. Manitoba + national coverage with Winnipeg breakouts
where the source supports it.

> **v2 changes** (after reviewer pass): SLOS moved from Phase 3 → Phase 1
> (it's in BoC Valet, not just PDFs); all StatsCan vectorIds removed (the
> originals were placeholders that didn't validate) and replaced with a
> mandatory validation step; archived Table IDs corrected; indicator catalog
> + validation script added to the architecture; "Current Snapshot" and
> derived-indicator sections added.

## 1. Why this tab and who it serves

| Indicator group | Residential | Multi-family | Commercial |
|---|---|---|---|
| Mortgage rates | Buyer affordability, market direction | DCF discount rate | Financing assumptions |
| GoC bond yields | — | **Cap-rate anchor** | **Cap-rate anchor** |
| Delinquencies / arrears | Distressed-sale leading indicator | Tenant default risk | LTV stress signal |
| NHPI | Price benchmark | Land-value tracking | Land tracking |
| CPI Shelter | Rent inflation context | Rent-assumption sanity check | Operating-cost inflation |
| Building permits (res + non-res) | Future supply | Apartment pipeline | Office / industrial / retail pipeline |
| Population / migration | Demand fundamental | Tenant pool | Demand fundamental |
| Labour Force Survey | Income, employment health | Tenant ability-to-pay | Office demand driver |
| BCPI (construction cost) | Replacement cost approach | Replacement cost | Replacement cost |
| **SLOS** lending conditions | Mortgage credit access trend | Apartment credit conditions | **Commercial lending tightening / easing** |

## 2. Data sources (verified via live probes)

### 2.1 Bank of Canada Valet API ✅
- **Endpoint:** `https://www.bankofcanada.ca/valet/observations/{ids}/json?start_date=YYYY-MM-DD`
- **Auth:** none. JSON. Docs: https://www.bankofcanada.ca/valet/docs
- **Per-series metadata:** `GET /valet/series/{id}/json` returns `label`,
  `description`, `dimension` — drives the validation step.

**Series to pull** (all confirmed present in `/valet/lists/series`):

| Series ID | Description | Frequency | Group |
|---|---|---|---|
| `V121764` | Conventional mortgage — 5-year posted | Weekly | Mortgage Market |
| `V121763` | Conventional mortgage — 1-year posted | Weekly | Mortgage Market |
| `V121769` | Conventional mortgage — 3-year posted | Weekly | Mortgage Market |
| `BROKER_AVERAGE_5YR_VRM` | Broker estimated 5-yr variable rate | Daily | Mortgage Market |
| `BD.CDN.2YR.DQ.YLD` | GoC 2-yr benchmark bond yield | Daily | Mortgage Market |
| `BD.CDN.5YR.DQ.YLD` | GoC 5-yr benchmark bond yield | Daily | Mortgage Market |
| `BD.CDN.10YR.DQ.YLD` | GoC 10-yr benchmark bond yield | Daily | Mortgage Market |
| `CBC20210` | Target for the overnight rate (policy) | Per BoC decision | Mortgage Market |
| `AVG.INTWO` | CORRA — Canadian Overnight Repo Rate Average | Daily | Mortgage Market |
| `SLOS_ML_LEND` | Mortgage lending — overall conditions | Quarterly | Credit Conditions |
| `SLOS_ML_LEND_NP` | Mortgage non-price lending conditions | Quarterly | Credit Conditions |
| `SLOS_ML_LEND_PC` | Mortgage price lending conditions | Quarterly | Credit Conditions |
| `SLOS_BUS_LEND` | Business lending — overall conditions | Quarterly | Credit Conditions |
| `SLOS_BUS_LEND_NP` | Business non-price lending conditions | Quarterly | Credit Conditions |
| `SLOS_BUS_LEND_PC` | Business price lending conditions | Quarterly | Credit Conditions |
| `SLOS_NML_LEND` | Non-mortgage lending — overall | Quarterly | Credit Conditions |
| `SLOS_NML_LEND_NP` | Non-mortgage non-price conditions | Quarterly | Credit Conditions |
| `SLOS_NML_LEND_PC` | Non-mortgage price lending conditions | Quarterly | Credit Conditions |

**Example call:**
```
curl "https://www.bankofcanada.ca/valet/observations/V121764,BD.CDN.5YR.DQ.YLD/json?start_date=2015-01-01"
```

---

### 2.2 Statistics Canada Web Data Service ✅
- **Endpoint base:** `https://www150.statcan.gc.ca/t1/wds/rest/`
- **Bulk:** `getDataFromVectorsAndLatestNPeriods` (POST JSON)
- **Validation:** `getSeriesInfoFromVector` (POST JSON) — returns
  `seriesTitleEn`, `memberUomCode`, archived/terminated flags
- **R tooling:** `cansim` package (mountainMath) — caches, handles paging,
  returns tidy frames; same author as the `cmhc` package we already use
- **Docs:** https://www.statcan.gc.ca/en/developers/wds/user-guide

**Tables to pull** (each productId verified live via `getCubeMetadata`):

| ProductId | Title (as returned by WDS) | Frequency | Group |
|---|---|---|---|
| `18-10-0205` | New Housing Price Index, monthly | Monthly | Prices |
| `18-10-0004` | Consumer Price Index, monthly, not seasonally adjusted | Monthly | Prices |
| `34-10-0292` | Building permits, by type of structure and type of work | Monthly | Supply |
| `34-10-0143` | Building permits, by census metropolitan area | Monthly | Supply |
| `17-10-0148` | Population estimates, July 1, by CMA/CA, 2021 boundaries | Annual (Jul) | Demand |
| `17-10-0009` | Population estimates, quarterly | Quarterly | Demand |
| `14-10-0287` | Labour force characteristics, monthly | Monthly | Demand |
| `14-10-0064` | Employment + average weekly earnings (SEPH), by industry | Monthly | Demand |
| `18-10-0289` | Building construction price indexes, by type of building | Quarterly | Construction Cost |

**Vector IDs — TBD via validation step, not hard-coded here.** The v2
catalog (§4) declares the *expected* series title + units per vector; the
validation script (§4.2) resolves vectors at build time and aborts on any
mismatch. This avoids the "v41691265 is Newfoundland fruit" failure mode
from v1 of this plan.

---

### 2.3 Mortgage delinquencies — CBA Mortgage in Arrears ⚠
- **Source:** https://cba.ca/mortgages-in-arrears
- The CBA hosts a monthly Mortgage in Arrears statistics file. The
  document URL pattern changes monthly (the URL is built into the page
  with a hash component), so the scraper must:
  1. Fetch the index page
  2. Extract the link to the latest spreadsheet
  3. Download + parse with `readxl::read_excel` (or `pdftools::pdf_text`
     if it's a PDF that month)
  4. Append to `data/cba_arrears.csv` (long form: month, province,
     loans_in_arrears, total_loans, arrears_rate)
- **Failure policy** (reviewer-recommended): keep last-known-good file,
  surface a visible "as of" banner in the UI, and the GitHub Action
  fails *loudly* (non-zero exit + uncommitted-CSV check) so a missed
  month gets attention rather than silently going stale.
- **Cross-checks:** CMHC quarterly Residential Mortgage Industry Report
  PDF + Equifax Market Pulse press releases. Added as Phase 2 enhancements
  for defensibility, not Phase 1.

---

### 2.4 Optional Phase 2/3 sources
- **CMHC Residential Mortgage Industry Report** (quarterly PDF) — second
  delinquency cross-check.
- **Equifax Canada Market Pulse** (quarterly press release) — third
  cross-check.
- **Manual-import bucket** (`data/manual/`) — appraisers can drop CSV
  files for proprietary cap rates, vacancy, absorption, or asking rents
  from CBRE / JLL / Colliers / local broker reports. Pipeline reads any
  CSV in that folder following a documented schema (`source`, `metric`,
  `geo`, `as_of_date`, `value`, `unit`) and renders them in their own
  section with explicit attribution to the report and date.

## 3. Tab UI structure

One tab, sidebar filters + grouped chart sections + a top-of-page
"Current Snapshot" KPI bar.

```
┌─ Sidebar ─────────────┐ ┌─ Main ────────────────────────────────────┐
│ GEOGRAPHY             │ │ ┌─ CURRENT SNAPSHOT ───────────────────┐  │
│ ☑ Canada              │ │ │ 5-yr GoC | 10-yr GoC | Overnight tgt│  │
│ ☑ Manitoba            │ │ │ Posted 5-yr | Variable | Spread (5-yr)│  │
│ ☑ Winnipeg (CMA)      │ │ │ MB arrears (Δ vs 12mo) | CA arrears  │  │
│                       │ │ │ Wpg CPI shelter | NHPI | Permits     │  │
│ YEAR RANGE            │ │ │ Population growth | Unemp | Wage growth│  │
│ [2015]─[2026]         │ │ │ "Data as of" per source (small text)  │  │
│                       │ │ └───────────────────────────────────────┘  │
│ SECTIONS              │ │                                             │
│ ☑ Mortgage Market     │ │ Mortgage Market                            │
│ ☑ Credit Conditions   │ │  [Rates chart] [Bond yields chart]         │
│ ☑ Prices              │ │  [Arrears chart, MB + CA]                  │
│ ☑ Supply              │ │                                             │
│ ☑ Demand              │ │ Credit Conditions  (SLOS, quarterly)        │
│ ☑ Construction Cost   │ │  [Mortgage lending — non-price | price]    │
│ ☑ Derived             │ │  [Business lending — non-price | price]    │
│                       │ │                                             │
│ [Download .xlsx]      │ │ Prices                                     │
│                       │ │  [NHPI: Wpg + CA] [CPI Shelter: MB + CA]   │
│                       │ │                                             │
│                       │ │ Supply                                     │
│                       │ │  [Permits by type: residential / non-res]  │
│                       │ │  [Sub-split: industrial/commercial/instit] │
│                       │ │                                             │
│                       │ │ Demand                                     │
│                       │ │  [Population growth] [Unemp / wage growth] │
│                       │ │  [Employment by industry (office-using…)] │
│                       │ │                                             │
│                       │ │ Construction Cost                          │
│                       │ │  [BCPI Wpg, by building type]              │
│                       │ │                                             │
│                       │ │ Derived Appraisal Indicators               │
│                       │ │  [Cap-rate pressure (5-yr GoC + spread)]   │
│                       │ │  [Mortgage payment pressure (year-over-year)]│
│                       │ │  [Rent growth vs wage growth]              │
│                       │ │  [Supply pressure (units / 1k people)]     │
│                       │ │  [Feasibility (NHPI vs BCPI)]              │
│                       │ │  [Time-adjustment helper (with caveats)]   │
│                       │ │                                             │
│                       │ │ Manual imports (if any)                    │
│                       │ │  [Cap rates / vacancy / etc, attributed]   │
└───────────────────────┘ └─────────────────────────────────────────────┘
```

### 3.1 Current Snapshot KPI bar (reviewer-requested)
Compact card grid at the top of the tab. Each KPI shows:
- Current value
- Change vs 12 months prior (with up/down arrow)
- Tiny "as of" date inline

Source-specific "as of" dates, *not* one global timestamp.

### 3.2 Derived appraisal indicators (reviewer-requested)
Computed in R at build time, exported with the underlying data:

| Indicator | Computation | Used by |
|---|---|---|
| Cap-rate pressure | 5-yr GoC yield + user-configurable risk spread (default 250 bps for multi-family, 350 bps for commercial) — surfaced as a line with the assumed spread shown | Multi-family, Commercial |
| Mortgage payment pressure | Monthly payment on a $400k 25-yr amortising loan at the current 5-yr posted rate, vs the same loan 12 months ago | Residential |
| Rent growth vs wage growth | YoY % change in MB Average Rent (Rms data, already in app) vs MB SEPH average weekly earnings | Multi-family |
| Supply pressure | (12-month rolling permits issued + Scss starts) ÷ (population) × 1,000 → "units per 1,000 people" | All |
| Construction feasibility | NHPI Winnipeg ÷ BCPI Winnipeg (indexed to a common base year) — a rising ratio means new build is increasingly viable | Commercial, Multi-family |
| Time-adjustment helper | Index level on `effective_date` ÷ index level on `sale_date` → multiplier appraisers apply with caveats | All — *with prominent disclaimer about market-condition adjustment limits* |

### 3.3 Commercial-specific additions (reviewer-requested)
- Building permits split: **residential** vs **industrial** vs
  **commercial** vs **institutional/government** ($ value)
- Employment by industry: office-using (finance/insurance, professional
  services, public administration) vs retail trade vs transportation +
  warehousing vs manufacturing — Manitoba and Winnipeg CMA
- **Credit Conditions** section as its own group (SLOS series 2.1, all 9)

## 4. Architecture

```
r/
├── lib/
│   ├── indicator_catalog.json       (the source-of-truth manifest)
│   └── indicator_helpers.R          (cansim/BoC fetchers, validators)
├── 10_scrape_boc.R                  (Valet rates + bonds + SLOS + CORRA)
├── 11_scrape_statscan.R             (NHPI, CPI, Permits, Population, LFS, SEPH, BCPI)
├── 12_scrape_cba_arrears.R          (CBA monthly xlsx)
├── 13_validate_indicators.R         (runs FIRST, aborts on mismatches)
├── 14_build_indicators.R            (CSVs → JSON shards per group + derived metrics)
└── 04_build_manifest.R              (extended to count indicator shards)
```

### 4.1 Indicator catalog
The catalog is `r/lib/indicator_catalog.json`. One entry per series, e.g.:

```json
{
  "id": "boc.mortgage5yr",
  "provider": "boc",
  "seriesId": "V121764",
  "expectedTitle": "Conventional mortgage - 5-year",
  "frequency": "weekly",
  "units": "percent",
  "geo": "CA",
  "transform": "monthly_mean",
  "displayGroup": "mortgage_market",
  "sourceUrl": "https://www.bankofcanada.ca/valet/series/V121764"
},
{
  "id": "statscan.nhpi.winnipeg",
  "provider": "statscan",
  "productId": "18-10-0205",
  "vectorId": "TBD",
  "expectedTitle": "Total (house and land), Winnipeg, Manitoba",
  "frequency": "monthly",
  "units": "index",
  "geo": "Winnipeg-CMA",
  "transform": "none",
  "displayGroup": "prices",
  "sourceUrl": "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810020501"
}
```

Vectors marked `"vectorId": "TBD"` are resolved during build setup using
`cansim::get_cansim_vector_info()` or interactive lookup — and *only* after
the validation step (4.2) confirms the resulting vector's title matches
`expectedTitle`.

### 4.2 Validation script (`13_validate_indicators.R`)
Runs **before** any scrape:
1. For each `provider: "boc"` row → `GET /valet/series/{id}/json`,
   confirm `label` matches `expectedTitle` (or that `description`
   contains it); fail if series is missing.
2. For each `provider: "statscan"` row → call
   `getSeriesInfoFromVector` with the vector ID; confirm
   `seriesTitleEn` matches `expectedTitle`, `productId` matches, and the
   series is not in a terminated/archived state.
3. For each `provider: "cba"` → confirm `https://cba.ca/mortgages-in-arrears`
   is reachable and the page contains a recognised "Statistics" link.
4. Print a unified table: `[id | provider | resolved title | units | LATEST OBS DATE | OK/FAIL]`.
5. Exit non-zero if any row fails.

This script is part of every CI run, so a silent series-rename in
Newfoundland Fruit Country can never make it into production.

### 4.3 Storage schema — ISO dates, not just years
Each long-form record in the indicator shards uses:
```json
{
  "id":     "boc.mortgage5yr",
  "date":   "2026-05-14",      // ISO YYYY-MM-DD
  "value":  4.79,
  "asOf":   "2026-05-20T18:00:00Z",
  "vintage":"2026-W21"          // BoC weekly vintage tag
}
```
Daily series retain daily resolution in storage. The chart layer
aggregates to monthly average for line plots, but the
"Current Snapshot" reads the most recent daily value for rates / yields.

### 4.4 Frontend module
New file `web/src/indicator-chart.js` — a separate chart wrapper
from `chart.js`. Differences:
- X axis: ISO date (not year) with adaptive tick formatting
- Per-series unit formatter from the catalog (`percent`, `dollar`,
  `index`, `units`, `persons`, `ratio`)
- Per-series source label (not the hardcoded "Source: CMHC")
- "Last value: X (as of Y)" label inside each card
- Stale-data warning band when latest obs is >90 days old for monthly,
  >14 days for daily

New file `web/src/indicators.js` — section orchestrator (renders KPI
bar + section groups + Excel export). Reuses the chart wrapper.

### 4.5 Excel export with Metadata sheet (reviewer-requested)
One workbook, **one sheet per indicator group**, plus a **Metadata**
sheet listing every series, its source URL, its vintage / as-of date,
units, transformations applied, and any data caveats. Defensibility
matters for appraisal — the metadata sheet is the evidence trail.

## 5. Build effort estimate (revised)

| Phase | Scope | Effort | Risks |
|---|---|---|---|
| **Phase 1** | Catalog + validation + BoC (rates, bonds, **SLOS**, CORRA) + StatsCan (NHPI, Permits, CPI Shelter) + CBA arrears + Current Snapshot KPI bar | ~8-10 hours | CBA scrape fragility |
| **Phase 2** | + Population, LFS, SEPH, BCPI + Demographics & Construction Cost sections + Derived indicators | ~4-5 hours | Vector lookup time |
| **Phase 3** | + CMHC/Equifax delinquency cross-check + Manual-import bucket + Industry-detail employment | ~5-6 hours | PDF parsing fragility |

Phase 1 is the minimum viable. Architecture pieces (catalog, validator,
indicator-chart module, Metadata Excel sheet) get built once and re-used
across all three phases.

## 6. Locked decisions

Per reviewer's recommendations:

1. **Default geography:** Manitoba + Canada on every chart; add Winnipeg
   where the source supports it (NHPI, CMA permits, BCPI Winnipeg,
   Winnipeg CPI).
2. **Delinquency scrape policy:** last-known-good with a visible
   "as of" caveat in the UI; CI fails loudly on a missed scrape.
3. **Excel scope:** one workbook, one sheet per indicator group, **+
   Metadata sheet** with source URLs, vintages, units, transformations,
   caveats.
4. **SLOS placement:** own "Credit Conditions" section in Phase 1
   (not Phase 3 as v1 of this plan had it).
5. **Coverage breadth:** default Manitoba / Winnipeg / Canada; optional
   province / CMA compare as a Phase 3 toggle.

## 7. Resolved decisions (from the open-question pass)

1. **Manual-import schema** — required columns expanded to:
   `source, metric, geo, as_of_date, value, unit, confidence,
   methodology, property_type, sample_size, notes`. The CSV reader will
   warn (not abort) when optional columns are blank, but every chart
   built from manual data renders the non-blank values alongside the
   metric (e.g. "8 transactions, broker-survey methodology, Q3 2025").

2. **Time-adjustment helper** — **prominent inline disclaimer** is
   rendered above the indicator on every page view (not modal-once,
   not opt-in). The disclaimer reads roughly:

   > Market-condition adjustments require appraiser judgment beyond a
   > single index. This helper shows the ratio of one index value to
   > another and is intended as input to the appraiser's analysis, not
   > a substitute for it.

   Plus the configured index (NHPI vs Rent vs BCPI) is selectable so
   appraisers can pick the index most appropriate to their property
   type, with the choice persisted in the URL state for shareable
   reasoning.

3. **CBA arrears scrape fallback — hybrid:**
   - **Current Snapshot KPI**: reuses the last known month so the
     headline arrears number never disappears, with the snapshot's
     own "as of [last good date]" timestamp.
   - **Arrears line chart**: gaps the line at the missing month(s) so
     the trend visualisation is visibly incomplete rather than
     extrapolated.
   - CI **still fails loudly** when the monthly scrape returns
     nothing — the fallback is for UX continuity, not to silence the
     alert that a refresh is needed.

## 8. Sources cited

- Bank of Canada Valet API docs: https://www.bankofcanada.ca/valet/docs
- BoC SLOS publication: https://www.bankofcanada.ca/publications/slos/
- StatsCan Web Data Service user guide: https://www.statcan.gc.ca/en/developers/wds/user-guide
- `cansim` R package: https://github.com/mountainMath/cansim
- StatsCan 34-10-0292 (Building permits): https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3410029201
- StatsCan 17-10-0148 (Population by CMA): https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1710014801
- StatsCan 18-10-0289 (BCPI): https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810028901
- CBA Mortgage in Arrears: https://cba.ca/mortgages-in-arrears
- CMHC Residential Mortgage Industry Report: https://www.cmhc-schl.gc.ca/professionals/housing-markets-data-and-research/housing-research/research-reports/housing-finance/residential-mortgage-industry-report
- Equifax Canada Market Pulse: https://www.consumer.equifax.ca/business/insights/market-pulse/

---

*Document last revised: 2026-05-22 — v2 incorporates reviewer pass.*
