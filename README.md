# Housing & Economic Data

A multi-tab static website of Canadian housing & economic data, built for a commercial real-estate appraiser — CMHC rental market, housing starts, secondary rental, census housing & demographics, affordability, Manitoba rent control, and market indicators — with copy-to-Word, Excel (.xlsx), and PNG exports for appraisal reports. The **Rental Charts** tab shows interactive line charts of CMHC rental and vacancy data, filterable by geography (Province / CMA / CSD / Survey Zone / Neighbourhood), dwelling type (Apartment / Row / All), and a breakdown dimension (Bedroom Type / Year of Construction / Structure Size / Rent Ranges).

**Map views.** Several tabs render self-hosted choropleth maps (Observable Plot; no external tiles, so the strict CSP and PNG/Word export stay intact): municipality choropleths on **Affordability**, **Census Profile**, and **Housing Stock** (shaded by a chosen metric; click a municipality to select it), and a survey-zone / neighbourhood picker map on **Rental Charts**. Boundary GeoJSON is built by `r/20_build_boundaries.R` (StatsCan cartographic boundaries) and `r/21_build_cmhc_zone_boundaries.R` (CMHC survey geographies) and committed under `web/public/data/geo/`, so the running site fetches static files and a fresh clone needs no boundary rebuild.

**Geographic coverage.** Manitoba, Saskatchewan, Alberta and British Columbia carry **full** detail — every level (province, CMA/CA, survey zone, neighbourhood, and municipality/CSD). Manitoba has the deepest history (rental data back to 1990); the other three cover the most recent 15 years. Every other province/territory includes its **major centres** (province + CMA/CA level) for a rolling recent window. The rental/starts geography list is config-driven in `r/lib/cmhc_helpers.R` (the `PROVINCES` table, `detail = full | basic`); CMA/CA UIDs are derived from the `cmhc` package's translation table. Each `geographies.json` item carries a `prov` code, which drives the Rental Charts **province-first filter** (Province → Level → Area, scoped to one province at a time).

## Tabs

| Tab | What it shows | Pipeline |
|---|---|---|
| Rental Charts | CMHC Rms line charts (5 metrics) + survey-zone picker map | `r/01`–`r/04`, `r/21` |
| Rental Tables | Appraisal-ready vacancy / median-rent pivot tables + bar charts | `r/03` |
| Compare Areas | Multi-area time series within one province | `r/03` |
| Secondary Rental | CMHC Srms (condo / secondary) for surveyed centres | `r/06` |
| Housing Starts | CMHC Scss starts / completions | `r/05` |
| Housing Stock | Census dwelling type / age / condition + choropleth map | `r/07`–`r/10`, `r/12b`, `r/20` |
| Census Profile | Population & dwelling trends + demographics + choropleth map | `r/12`, `r/12b`, `r/20` (run-once) |
| Affordability | Royal-LePage-style affordability factor + choropleth map | `r/16`, `r/18`, census, `r/20` |
| RTB (MB) | Manitoba rent-increase guideline history + CPI overlay | `r/19` |
| Current Snapshot / Market Indicators | BoC / StatsCan / OSB economic indicators | `r/10`,`r/11`,`r/13`,`r/14`,`r/17` |
| MB Economic Update | Auto narrative report (economy + HPI + outlook) | `r/15`, `r/16` |

The Tables tab generates appraisal-ready comparison tables (vacancy / median rent by bedroom type, rent range, year built) with copy-to-clipboard (rich HTML for pasting into Word), Word (.docx), and Excel (.xlsx) export — this replaces the retired CMHC-VacancyMedianRents Shiny tool. It is **province-scoped** (pick a province — always the first row, default Manitoba — then the second–fourth areas are centres within it; no cross-province comparison), and each table has a grouped-bar chart card beside it (same chrome as the Rental Charts cards — title, subtitle, right-side legend, Download PNG). The **Compare Areas** tab is the multi-area counterpart to Rental Charts: it overlays several areas *within one province* as time-series lines for a fixed breakdown category (e.g. pre-1960 stock across MB centres), with a matching areas × years table beside each chart — one chart+table pair per metric (median rent, average rent, vacancy, avg rent change). The pipeline also pulls the Secondary Rental Market Survey (Srms — condo rental data) into `web/public/data/secondary.json`, replacing the retired "CMHC Rental Data Scrape" project. Both retired projects are archived under `$Projects in Progress\old projects maybe`.

Built as a Vite + vanilla JS static site, with an R-based data pipeline. Deployed to Vercel from this GitHub repo.

## Architecture

- `r/` — R pipeline (uses the [`cmhc`](https://github.com/mountainMath/cmhc) package by mountainMath) that produces long-form JSON shards under `web/public/data/`.
- `web/` — Vite static site (vanilla JS + Tailwind v4 + [Observable Plot](https://observablehq.com/plot/)).
- `vercel.json` — points Vercel at the Vite build.
- `.github/workflows/refresh-data.yml` — monthly cron that re-runs the R pipeline and commits refreshed JSON.

## Local development

```pwsh
# 1. Install web dependencies
cd web
npm install

# 2. Pull CMHC data and build JSON shards (one-time / on refresh)
cd ..
npm --prefix web run data:all

# 3. Dev server
npm --prefix web run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Refresh data

Three options:

1. Wait for the scheduled GitHub Actions runs (see schedule below).
2. `gh workflow run refresh-data.yml` (full CMHC refresh) or
   `gh workflow run refresh-indicators.yml` (indicators only) to trigger
   manually.
3. Local: `npm --prefix web run data:all && git add web/public/data && git commit -m "data: refresh" && git push`.

### Census Profile tab (run-once, separate from `data:all`)

The **Census Profile** tab (Population & Dwelling Trends 2006–2021 + a
Demographics comparison across three user-chosen areas at a selectable census
period, the web port of the MBCensusData report) is built by
`r/12_census_profile.R` into `web/public/data/housing/census_profile.json`. The
tab has three free area pickers (any Manitoba geography or Winnipeg Community
Area / Cluster / Neighbourhood) feeding both tables, and a Census-period
selector. The period drives only the Demographics table + demographic charts;
the Trends table/chart always span all censuses. `demo` is keyed by census year
(2021 plus best-effort 2016 & 2011 — period-of-construction buckets and the
income reference year shift each census, and 2011 long-form is the NHS, so those
earlier years are fetched leniently and some rows blank out). It
uses StatCan census via **CensusMapper / `cancensus`** (a different source than
the rest of the pipeline), so it is **deliberately excluded from `data:all`**
and from the GitHub Actions refresh — census data is 5-yearly, and CI has no
CensusMapper key. Re-run it manually only when a new census is released:

```pwsh
# CensusMapper key (see MBCensusData/"Cancensus API Key.R") — pass via env:
$env:CM_API_KEY="CensusMapper_xxx"; npm --prefix web run data:census
```

A companion script, `r/12b_wpg_city_history.R`, then **appends earlier-census
history (2006/2011/2016) to the Winnipeg clusters + community areas** from the
City of Winnipeg's published census profiles (Community Social Data Strategy
custom tabulation) — CensusMapper DA-aggregation only yields 2021 for those
virtual geos. It needs **no API key** (downloads from `legacy.winnipeg.ca`,
cached under `r/lib/cache/`, gitignored) and uses the crawled neighbourhood→
cluster→CA manifest `r/lib/wpg_city_neighbourhoods.csv`. 2016 comes from the
clean per-cluster/per-CA `.xlsx`; 2011/2006 are summed from per-neighbourhood
`.xls` (counts only — medians aren't aggregatable, so they're dropped for 2011,
and 2006 is trends-only). It also pulls **dwelling condition** (% needing major
repairs, incl. a City 2021 pass since CensusMapper has no condition vector) so
the **Housing Stock** tab can offer the Winnipeg clusters/CAs alongside the
standard geographies. It also grafts the City's **2006/2011/2016 per-
neighbourhood** profiles onto the WPG_Nbhd geos (matched by name — ~175–180 of
211; the rest are industrial/zero-population areas with no City profile, plus a
few that changed names/boundaries between censuses), giving neighbourhoods a
2006→2021 trend (2006 trends-only) + 2011/2016 demographics. Run it after `r/12`
(`census-refresh.bat` does both):

```pwsh
Rscript r/12b_wpg_city_history.R   # no key; appends WPG cluster/CA 2006–2016
```

Coverage: all Manitoba PR / CMA-CA / CD / CSD geographies, plus the City of
Winnipeg virtual geographies (Community Area / Cluster / Neighbourhood,
dissemination-area aggregated via `r/lib/wpg_geography_lookup.csv`; clusters and
community areas additionally carry 2006–2021 trends + 2011/2016 demographics
from the City of Winnipeg, and most neighbourhoods carry 2006–2021 trends +
2011/2016 demographics from the City's per-neighbourhood profiles). Free
CensusMapper keys are capped at **500 region identifiers/day (5,000/month)**, and
Winnipeg has ~1,130 dissemination areas — more than one day's allowance — so the
DA pull is chunked (18 DAs/request) and the cache is persistent, making the run
**resumable**: re-running on later days replays cached chunks for free and pulls
~500 more, so the full Winnipeg build completes over ~3 days (or in one run with
a higher quota from CensusMapper's maintainer). If the daily/monthly quota is
exhausted mid-run the script still writes all standard Manitoba levels and skips
the Winnipeg virtual geos with a warning; re-run later to add them. Standard
Manitoba levels are cached after the first build, so those re-runs are free.

### Refresh schedule

| Workflow | Cron (UTC) | What it pulls |
|---|---|---|
| `refresh-data.yml` | 2nd of every month + 28th of Jan + 28th of Jul | Full pipeline: CMHC Rms/Srms/Scss + BoC + StatsCan |
| `refresh-indicators.yml` | Every Monday | BoC + StatsCan only (skips the slow CMHC scrape) |

CMHC publishes the Rental Market Survey twice a year (April + October).
The Jan/Jul crons are timed to catch the typical release window so rental
data refreshes within hours of CMHC publishing.

### Email notifications (optional)

Both workflows send an email on success (only when data actually changed)
and on failure. To enable, add these to the GitHub repo:

- **Secret** `MAIL_USERNAME` — sender SMTP username (e.g. Gmail address)
- **Secret** `MAIL_PASSWORD` — sender SMTP app password
- **Variable** `MAIL_TO` — recipient address
- Optional **variables** `SMTP_HOST` / `SMTP_PORT` — defaults to
  `smtp.gmail.com:587`

If any of those is missing the notification step is silently skipped — the
workflow itself still runs and (on failure) opens a GitHub issue.

## Verifying the pipeline

After `data:all`, run `Rscript r/99_verify_samples.R` — it makes 5 fresh `get_cmhc()` calls and compares them to the generated JSON shards. Non-zero exit on mismatch.

## Data sources & attribution

All data is from public Canadian sources. Attribution is required by the
respective publishers' open-data terms and is surfaced in every Excel
export's Metadata sheet, in the per-tab and sitewide footers in the app,
plus the in-app indicator chart captions.

- **CMHC Rental Market Survey (Rms)**, **Secondary Rental Market Survey
  (Srms)**, and **Starts & Completions Survey (Scss)** via von Bergmann, J.
  (2025) [`cmhc`](https://github.com/mountainMath/cmhc): R package to
  access, retrieve, and work with CMHC data. Use or reproduction of any
  CMHC data shown here is subject to the [CMHC Licence Agreement for the
  Use of Data](https://www.cmhc-schl.gc.ca/professionals/housing-markets-data-and-research/housing-data/cmhc-licence-agreement-use-of-data),
  including its attribution requirements. This product is not affiliated
  with or endorsed by CMHC.
- **Statistics Canada Web Data Service** via the [`cansim`](https://github.com/mountainMath/cansim) R package.
  Contains information licensed under the [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
- **Bank of Canada Valet API** — [terms](https://www.bankofcanada.ca/terms/). Free reuse with attribution.

## Licence

Code is MIT-licensed — see [LICENSE](LICENSE). Bundled data is subject to
the source publishers' terms listed above.
