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

The script copies seven CSVs per scope × basis
(`winnipeg_nominal`, `winnipeg_real`, `all_nominal`, `all_real`) and
rewrites `web/public/parade/MANIFEST.json` with the new build date and the
latest Parade issue label.

## Files shipped

Per scope × basis folder:

| File | What it feeds |
| --- | --- |
| `price_trends.csv` | Median base price + median home-size cards (one point per Spring / Fall issue). |
| `size_trends.csv` | Reserved for a future style-level size chart; included so the snapshot matches the pipeline. |
| `psf_by_style_year.csv` | $/sq ft by style (annual median per style group). |
| `size_by_style_year.csv` | Reserved; same as above for sq ft by style. |
| `upgrade_by_year.csv` | Median upgrade spend card. |
| `garage_mix.csv` | Reserved; aggregates garage shares by era, not yet charted on the tab. |
| `index_comparison.csv` | Parade price index vs CPI card (rebased, one line per series). |

## Disclosure on charts

Every chart carries the Parade source line below it. The tab footer adds
the full public-chart disclosure from the Parade-Of-Homes README:

> Prices are listing-reported house-only prices (land excluded), shown
> excluding GST (net GST removed by estimate for 2012–2016 issues); they
> may vary by development charge and option inclusion. For market
> commentary only; not an appraisal or value opinion.

When the dollar basis is set to **Real**, the footer also adds the CPI
rebasing note from the Parade pipeline.
