# Geography Expansion — Status & Process

How geographic coverage (provinces and cities/CMAs) is wired into each tab/data
source, what's covered today, and the step‑by‑step to add more. Written as a
resume point — pick any data source below and follow its "to add" steps.

_Last updated: 2026‑06 (after British Columbia — full CMHC + indicators + census; municipal CSDs for every full province; AB/BC Affordability)._

---

## 1. Current coverage at a glance

Province SGC codes: **CA**=Canada, **46**=MB, **47**=SK, **48**=AB, 59=BC, 35=ON,
24=QC, 13=NB, 12=NS, 11=PE, 10=NL, 60=YT, 61=NT, 62=NU.

| Tab / source | Script(s) | National | Manitoba | Saskatchewan | Alberta | Other provinces | Cities / CMAs |
|---|---|---|---|---|---|---|---|
| **Rental Charts/Tables/Compare** (CMHC RMS) | r/00–03 | – | **full** (prov+CMA/CA + survey zones + neighbourhoods, full history) | **full** (Regina/Saskatoon zones+nbhds, 15‑yr) | **full** (Calgary/Edmonton zones+nbhds, 15‑yr) | **basic** (prov + CMA/CA, last 15 yr) | via CMHC survey zones/neighbourhoods |
| **Housing Starts** (CMHC SCSS) | r/05 | – | full | full | full | basic | same CMHC geos |
| **Secondary Rental** (CMHC Srms) | r/06 | – | Winnipeg | Regina, Saskatoon | Calgary, Edmonton | – | hardcoded centre list |
| **Housing Stock / Dwelling Type** (Census) | r/07–10d | Canada + 13 provinces | **all ~213 CSDs, 2006–2021** | CSDs **2016+2021 only** | CSDs **2016+2021 only** | province + (national bulk) CMA back‑years | – |
| **Census Profile** (cancensus) | r/12, r/12b | – | **all levels + Winnipeg virtual geos, 2006–2021** | **PR/CMA/CD, 2016+2021** | **PR/CMA/CD, 2016+2021** | – | – |
| **Affordability** | r/18 + census/mls/mortgage | – | **full** (census income+rent; Winnipeg purchase) | province + major centres (rental, CMHC rent) | **not covered** | – | purchase = Winnipeg only (CREA MLS HPI) |
| **Market Indicators / Current Snapshot** | catalog + r/11/13/14/17 | rates, bonds, insolvencies, + national of every series | **full** (every province‑published series) | **full** | **full** | population / immigration / NPR only | **Winnipeg, Calgary, Edmonton, Regina, Saskatoon** (for NHPI, BCPI, CPI, permits, CRSPI*, CMHC rent, employment/unemployment) |
| **MB Economic Update** | r/15, r/16 | – | MB only — **tab HIDDEN/shelved** | – | – | – | – |

\* CRSPI (commercial leasing) has no Regina value.

**2026‑06 (BC expansion):** British Columbia is now a fourth **full** province (Vancouver +
Victoria zones/neighbourhoods, 10‑yr). **Municipal CSDs** are now scraped for every full
province's CMAs — ~88 total (MB 13, SK 14, AB 27, BC 34) — via the per‑CMA breakdown
(r/02 RMS + r/05 SCSS). **Affordability** now covers AB + BC (rental). The province‑column
table above predates this; read **BC as a fourth full province**.

**Two key facts that constrain everything:**
1. **CMHC publishes municipal (CSD) data as a per‑CMA breakdown, not per‑province.** The
   *province*‑level Census‑Subdivision breakdown returns a hard 500 for **every** province
   (including MB) — which is why the old province‑level `discover_csds` found nothing.
   Querying the breakdown **per‑CMA** returns each metro's CSDs for every full province
   (r/02 RMS + r/05 SCSS; synthetic `<CMA>-<slug>` UIDs). So "full" = province + CMA/CA +
   the primary CMAs' survey zones, neighbourhoods **and municipalities (CSDs)**.
2. **Census municipal (CSD) data IS available** for any province (StatsCan), but is gated
   by the CensusMapper free‑tier cap (Census Profile) and by data volume.

---

## 2. Shared concepts

- **Two id-naming conventions in the indicator catalog** (`r/lib/indicator_catalog.json`):
  most series use the full province word (`.manitoba`, `.saskatchewan`, `.alberta`,
  `.canada`) but the original demand trio (population/immigration/NPR) uses the
  abbreviation (`.mb`/`.sk`/`.ab`/`.bc`). The snapshot's `geoStripId`/`GEO_ID_TOKENS`
  handle both. New series: prefer the full word.
- **CMA geo strings** in the catalog/UI are `"<City>-CMA"` (e.g. `Calgary-CMA`).
- **CMHC 3‑digit CMA codes** (used in CMHC scrape + r/14 rent slicing): Winnipeg 602,
  Regina 705, Saskatoon 725, Calgary 825, Edmonton 835.
- **Where things run:** the CMHC scrape and the indicator refresh run in **GitHub
  Actions** (`refresh-data.yml` monthly, `refresh-indicators.yml` weekly). The Census
  scripts (r/07–r/12) are **run‑on‑demand locally** (need a CensusMapper key, not in CI).

---

## 3. Process — add a new PROVINCE

### 3a. CMHC Rental + Housing Starts (`r/lib/cmhc_helpers.R`, r/03)
1. In `PROVINCES`, set the province's `detail` from `"basic"` to `"full"`.
2. Add its primary CMA(s) to `ZONE_CMAS` (the CMAs that publish zone/neighbourhood data).
   Find the 3‑digit code from the existing `cma_*.json` shards or `cmhc_cma_translation_data`.
3. (Optional) Add the SGC code to `FULL_HISTORY_PROV` in `r/03` for full history instead of 10‑yr.
4. **Regenerate the data via CI, not locally.** A local full scrape was silently killed
   after ~2–3 h. Commit + push the config, then `gh workflow run "Refresh CMHC data"`
   (refresh‑data.yml; ~3 h, auto‑commits `web/public/data`). The intermediate
   `data/*.csv` are gitignored, so you can't rebuild shards locally without re‑scraping.
5. **Windows/Dropbox gotcha:** big Calgary "neighbourhood" names blew past the 260‑char
   path limit; `r/02` now caps the shard‑id slug (64 chars + hash). If a fresh `git pull`
   fails with "Filename too long", run `git config core.longpaths true`.

### 3b. Secondary Rental (`r/06_scrape_secondary.R`)
Not config‑driven — hardcoded. Add a `<prov>_cmas <- CMAS %>% filter(prov_uid == "<code>")`
block, add the province row to the `geos` tibble, add it to the `bind_rows`, and extend the
`provName` recode. `safe_srms` drops centres with no Srms data automatically.

### 3c. Housing Stock — Dwelling Type + Condition (Census, run locally)
Decision so far: **MB = all 4 censuses; SK/AB = 2016+2021 only** (CSD back‑years are MB‑only).
To add a province at the same 2016+2021 tier:
- `r/10` (2021 dwelling type): add the SGC code to the CSD filter `... %in% c("46","47","48")`.
- `r/07` (2021+2016 condition): add the code to its CSD filter `substr(code,1,2) %in% c(...)`.
- Leave `r/10c`/`r/10d` (2011/2006 dwelling) and `r/08`/`r/09` (2011/2006 condition) **MB‑only**.
- **Gotcha:** `r/07` rebuilds `census_housing.json` from scratch (2021+2016), so after re‑running
  it you MUST re‑run `r/08` + `r/09` to put MB's 2011/2006 back. Run order: r/07 → r/08 → r/09.
- Run order for dwelling type: r/10 → r/10b → r/10c → r/10d (10d last sets the source string).
- Frontend (`housing.js`) is data‑driven — the province appears automatically.

### 3d. Census Profile (`r/12_census_profile.R`, run locally with a CensusMapper key)
MB = full; SK/AB = PR/CMA/CD at 2016+2021. To add a province at that tier, edit the
`ADD_PR` / `ADD_YEARS` / `ADD_LEVELS` config near the top (the only change needed —
`fetch_level` swaps the province set per dataset‑year + level). Run with the key:
`R_ENVIRON_USER="C:/Users/Jason/Documents/.Renviron" Rscript r/12_census_profile.R`
(MB/Winnipeg replay from the cancensus cache; only the new ~65 PR/CMA/CD region IDs are fresh).
Frontend (`census.js`) is data‑driven; the name cleanup already strips any `(Abbr.)`/`(B)`/`(D)`/`(CDR)` code.
**To go to municipalities (CSDs):** that needs (a) multi‑day or paid CensusMapper runs
(free cap = 500 regions/day; a province has hundreds of CSDs) AND (b) a Province→Area
cascade on the (currently flat) Census Profile picker.

### 3e. Affordability (`r/18_affordability_sk.R`, `web/src/affordability.js`)
MB + SK today; AB not yet. To add a province (Saskatchewan is the template):
- In `r/18`, add a province tibble (PR + its CMAs/CAs with cube‑98‑10‑0055 geo member IDs)
  → fetch median income (98‑10‑0055) + CMHC average rent → write into `affordability_extra.json`.
- In `affordability.js`, add the prov to `PROV_LABEL` + `GROUP_ORDER` and a loop that reads
  `extra.<prov>` (mirror the `extra.sk` loop).
- Purchase factor stays Winnipeg‑only until a home‑price benchmark (CREA MLS HPI) is wired for
  the new geo.
- **Gotcha:** the census loop in affordability.js is scoped to MB (`uid /^(46|WPG)/`) because
  `census_profile.json` now also carries SK/AB — don't widen it or other provinces leak in
  tagged as Manitoba.

### 3f. Market Indicators (catalog + r/11/13/14, run locally or via CI)
This is the most reusable recipe (see §5). For a new province at full coverage, add a series
for each province‑published family by **swapping the geography member** in the family's table:
1. Discover the vector (see §5 vector‑discovery recipe) for each family.
2. Add the series to `indicator_catalog.json` (mirror the Manitoba series; set `geo`, `vectorId`,
   `chartLabel`, loose `expectedTitle` with the province name).
3. Add OSB insolvency (`osbGeo: "<Province>"`) + the per‑capita derived series if wanted.
4. `Rscript r/13_validate_indicators.R` (validates titles against live WDS) →
   `Rscript r/11_scrape_statscan.R` (+ `r/17_scrape_osb.R`) → `Rscript r/14_build_indicators.R`.
5. Add the province `<option>` to `#mi-geo-prov` in `index.html` if not already there.

---

## 4. Process — add a new CITY / CMA

Cities only exist where StatsCan/CMHC publish at CMA level. Today the catalog covers
Winnipeg, Calgary, Edmonton, Regina, Saskatoon.

### 4a. Market Indicators (the main place cities live)
1. **Discover the CMA vector** for each family that publishes at CMA (§5). Families that do:
   NHPI (18‑10‑0205), BCPI (18‑10‑0289), CPI (18‑10‑0004), building permits (34‑10‑0292),
   CRSPI (18‑10‑0260), and — from a *different* table — employment/unemployment
   (**14‑10‑0294**, a seasonally‑adjusted 3‑month moving average; coordinate
   `geo.char.1.1` with Statistics=Estimate=1, DataType=SA=1).
2. **CMHC average rent at CMA** is not a WDS vector — it's sliced from
   `historical_rental.csv` in `r/14` by GeoUID. Add the CMA's 3‑digit code to the GeoUID
   filter + `rent_id`/`rent_geo` maps, and add `cmhc.rent.<city>` + `derived.rent.<city>.yoy`
   to the catalog.
3. Add the series to the catalog with `geo: "<City>-CMA"`, validate (r/13), scrape (r/11),
   build (r/14).
4. **Frontend (`web/index.html` + `web/src/indicators.js`):**
   - Add `<option value="<City>-CMA">City</option>` to `#mi-geo-cma`.
   - Add the geo to `GEO_ID_TOKENS`, `GEO_ORDER`, and **`CITY_PROVINCE`** (so the city is
     gated to its province — cities only show when their parent province is selected).

### 4b. CMHC Rental/Starts "cities" (survey zones & neighbourhoods)
These aren't CMAs in the indicator sense — they come automatically when a province is made
"full" and its primary CMA(s) are in `ZONE_CMAS` (§3a). No per‑city work.

---

## 5. Market‑Indicators vector‑discovery recipe (reusable)

For a province or CMA in the SAME table as an existing series, the vector is found by swapping
the geography member. Script pattern (R + httr against WDS):
```
getSeriesInfoFromVector(<known MB/CA vector>)  -> productId + coordinate
getCubeMetadata(productId)                     -> find the Geography dimension + the target
                                                  member (province name exact, or "City, Prov")
                                                  -> its memberId
swap that position in the coordinate
getSeriesInfoFromCubePidCoord(productId, newCoord) -> the target vector + its SeriesTitleEn
```
`expectedTitle` only needs to be loose: r/13's `matches()` checks each `;`‑separated part is
present, so `"Calgary;All-items"` matches `"Calgary, Alberta;All-items"`.
(Working scripts used this session were `/tmp/find_*_vectors.R` — re‑create as needed.)

---

## 6. UI behaviour (Market Indicators / Current Snapshot)

- **Geo selector** = two multi‑select dropdowns: `#mi-geo-prov` (Canada + provinces) +
  `#mi-geo-cma` (CMAs). `state.geosEnabled` = union of both selections.
- **Default selection = Manitoba + Winnipeg** (NOT Canada). Canada‑only stats (rates, bonds,
  policy/prime, cap‑rate, mortgage payment) are single‑geo and **always render** regardless.
- **City→province coupling** (`effectiveGeos` + `CITY_PROVINCE`): a CMA only renders (snapshot
  AND charts) when its parent province is also selected.
- **Snapshot** is geo‑aware (a tile per enabled geo for the snapshotPick's metric) and split
  into 3 sections by `geoTier`: **National / Provincial / Urban Centre**. Metric order within
  a section follows catalog order. `geoStripId` keeps multi‑metric charts (farm cash, mortgage
  5/3/1yr, rent‑vs‑wage) from collapsing.

---

## 7. Open / next candidates

- **Affordability → Alberta** (and fuller SK): wire `extra.ab` via r/18 (income 98‑10‑0055 +
  CMHC rent). Purchase factor needs an AB home‑price benchmark.
- **Census Profile → CSDs for SK/AB** (and other provinces): needs the CensusMapper‑cap
  workaround + a province cascade on the picker.
- **More CMAs** (e.g. Lethbridge, Red Deer, other provinces' CMAs): same §4 recipe; note not
  every family publishes every CMA (CRSPI/NHPI coverage varies).
- **Other "basic" provinces → full CMHC** (BC/ON/etc.): §3a, but each adds ~20 min of CI scrape.

Related deep‑dive notes live in the assistant's memory (per‑tab files); this doc is the
single resume point.
