# Parade of Homes tab — data refresh

The "Parade of Homes" tab under **Local Data** reads one file,
`parade_of_homes.json`, from the firm's shared Dropbox folder

    D:\Dropbox\SharedInfo\AppMarketData\AppMarketData-External\ParadeOfHomes\

like the other Local Data tabs (`web/src/parade-store.js`): the viewer picks
that folder, or the AppMarketData strip under the Local Data bar finds it,
and the browser keeps the data in IndexedDB (`hed-parade`), re-reading the
file when it changes. Nothing ships with the site (until November 2026 a
snapshot lived in `web/public/parade/`).

Nothing in this repo generates the Parade data. To pick up a new issue, run
the pipeline in the
[Parade-Of-Homes](D:\Dropbox\ClaudeCode\$Projects%20in%20Progress\Parade-Of-Homes)
project (`./run_pipeline.sh`). Its step 3b runs `publish_shared.py`, which
bundles fourteen CSVs per scope × basis (`winnipeg_nominal`, `winnipeg_real`,
`all_nominal`, `all_real`) from `analysis_output/<view>/` and
`analysis_output/<view>/appraiser/` into `parade_of_homes.json` (CSV text keyed
by file name, plus the latest issue label and disclosures) and writes
`README.txt` and `last_updated.json` beside it. After running
`Rscript analyze_parade.R` on its own, run `python publish_shared.py` by hand.
No commit or deploy is needed here.

Publish after **every** pipeline run, including re-extractions of old issues.
The October 2026 spike in median home size (Spring 2022 reading 2,082 sq ft)
came from a snapshot copied before a fuller re-extraction: 2021–22 issues then
had only 25–30 Winnipeg listings each, against 62–77 after.

## Files bundled

Per scope × basis view:

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
| `feature_trends.csv` | Garage and finished-basement shares (built assessment records only; vacant / unmatched parcels are NA, not "no", since the 2026-10 pipeline fix). |
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
