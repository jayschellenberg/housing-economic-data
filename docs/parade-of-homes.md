# Parade of Homes tab — data refresh

The "Parade of Homes" tab under **Local Data** reads a static snapshot of
the [Parade-Of-Homes](D:\Dropbox\ClaudeCode\$Projects%20in%20Progress\Parade-Of-Homes)
pipeline output shipped with the site under
[`web/public/parade/`](../web/public/parade/).

Nothing in this repo generates the Parade data. To pick up a new issue:

1. Run the pipeline in the Parade-Of-Homes project
   (`./run_pipeline.sh`, or at minimum `Rscript analyze_parade.R`).
   That writes `analysis_output/<scope>_<basis>/` and
   `analysis_output/<scope>_<basis>/appraiser/`.
2. From this repo's root, run the snapshot copy script:

   ```powershell
   pwsh scripts/copy-parade-snapshot.ps1
   ```

   Override the source with `-ParadeDir <path>` if the Parade project
   lives elsewhere.
3. Commit the updated `web/public/parade/` files and deploy as usual.

The script copies thirteen CSVs per scope × basis
(`winnipeg_nominal`, `winnipeg_real`, `all_nominal`, `all_real`) and
rewrites `web/public/parade/MANIFEST.json` with the new build date and the
latest Parade issue label.

Re-run the copy script after **every** pipeline run, including re-extractions
of old issues. The October 2026 spike in median home size (Spring 2022 reading
2,082 sq ft) came from a snapshot copied before a fuller re-extraction:
2021–22 issues then had only 25–30 Winnipeg listings each, against 62–77 after.

## Files shipped

Per scope × basis folder:

| File | What it feeds |
| --- | --- |
| `price_trends.csv` | Median base / selling price, selling-price range (p25 / median / p75 / mean), median home size, listings per issue (one point per Spring / Fall issue). |
| `size_trends.csv` | Not charted (broad-style sizes; `size_by_style_year.csv` is used instead). |
| `style_mix.csv` | Style mix of listings (share by style, annual). |
| `psf_by_style_year.csv` | $/sq ft by style (annual median per style group). |
| `size_by_style_year.csv` | Median home size by style. |
| `upgrade_by_year.csv` | Median upgrade spend; share with no upgrades and median upgrade % when upgraded. |
| `lot_trends.csv` | Median lot size and lot frontage (assessment-matched parcels). |
| `garage_mix.csv` | Garage size mix by era (table card). |
| `keyword_trends.csv` | Finishes / features named in listings (mentions per 100 listings). |
| `neighbourhood_comparison.csv` | Neighbourhood comparison table (pipeline's recent window). |
| `builder_positioning.csv` | Builder positioning table (recent window). |
| `builder_activity.csv` | Most active builders table (top 20, all issues). |
| `index_comparison.csv` | Parade price index vs CPI, NHPI and BCPI (rebased, one line per series). |

Every chart's legend entries switch their line off and on (shift-click shows
one line alone); the choice is remembered per chart in the browser.

## Disclosure on charts

Every chart carries the Parade source line below it. The tab footer adds
the full public-chart disclosure from the Parade-Of-Homes README:

> Prices are listing-reported house-only prices (land excluded), shown
> excluding GST (net GST removed by estimate for 2012–2016 issues); they
> may vary by development charge and option inclusion. For market
> commentary only; not an appraisal or value opinion.

When the dollar basis is set to **Real**, the footer also adds the CPI
rebasing note from the Parade pipeline.
