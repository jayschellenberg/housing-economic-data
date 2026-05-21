# CMHC Charts

Interactive line charts of CMHC rental and vacancy data for Manitoba, filterable by geography (Province / CMA / CSD / Survey Zone / Neighbourhood), dwelling type (Apartment / Row / All), and a choice of breakdown dimension (Bedroom Type / Year of Construction / Structure Size / Rent Ranges).

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

1. Wait for the scheduled GitHub Action (runs monthly).
2. `gh workflow run refresh-data.yml` to trigger manually.
3. Local: `npm --prefix web run data:all && git add web/public/data && git commit -m "data: refresh" && git push`.

CMHC publishes the Rental Market Survey twice a year (April + October).

## Verifying the pipeline

After `data:all`, run `Rscript r/99_verify_samples.R` — it makes 5 fresh `get_cmhc()` calls and compares them to the generated JSON shards. Non-zero exit on mismatch.

## Source

- CMHC Rental Market Survey (RMS), via the `cmhc` R package
- API docs: https://github.com/mountainMath/cmhc
