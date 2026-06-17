# CMHC Charts

Interactive line charts of CMHC rental and vacancy data for Canada, filterable by geography (Province / CMA / CSD / Survey Zone / Neighbourhood), dwelling type (Apartment / Row / All), and a choice of breakdown dimension (Bedroom Type / Year of Construction / Structure Size / Rent Ranges).

**Geographic coverage.** Manitoba and Saskatchewan carry **full** detail — every level (province, CMA/CA, survey zone, neighbourhood) with complete history. Every other province/territory includes its **major centres** (province + CMA/CA level) for the **most recent 10 years** only (a rolling window that advances each refresh). The rental/starts geography list is config-driven in `r/lib/cmhc_helpers.R` (the `PROVINCES` table, `detail = full | basic`); CMA/CA UIDs are derived from the `cmhc` package's translation table. Saskatchewan has no CSD-level data — CMHC's Census-Subdivision breakdown returns a 500 for SK.

The Tables tab generates appraisal-ready comparison tables (vacancy / median rent by bedroom type, rent range, year built) with copy-to-clipboard (rich HTML for pasting into Word), Word (.docx), and Excel (.xlsx) export — this replaces the retired CMHC-VacancyMedianRents Shiny tool. The pipeline also pulls the Secondary Rental Market Survey (Srms — condo rental data) into `web/public/data/secondary.json`, replacing the retired "CMHC Rental Data Scrape" project. Both retired projects are archived under `$Projects in Progress\old projects maybe`.

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

Coverage: all Manitoba PR / CMA-CA / CD / CSD geographies, plus the City of
Winnipeg virtual geographies (Community Area / Cluster / Neighbourhood,
dissemination-area aggregated via `r/lib/wpg_geography_lookup.csv`). Free
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
  Use of Data](https://www.cmhc-schl.gc.ca/about-us/terms-of-use),
  including its attribution requirements. This product is not affiliated
  with or endorsed by CMHC.
- **Statistics Canada Web Data Service** via the [`cansim`](https://github.com/mountainMath/cansim) R package.
  Contains information licensed under the [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
- **Bank of Canada Valet API** — [terms](https://www.bankofcanada.ca/terms/). Free reuse with attribution.

## Licence

Code is MIT-licensed — see [LICENSE](LICENSE). Bundled data is subject to
the source publishers' terms listed above.
