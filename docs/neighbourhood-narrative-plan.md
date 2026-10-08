# Neighbourhood Narrative Tool — Plan

> Captured 2026-10-07. Still early, shape not locked. This captures the wishlist and the design principles before they are lost.

## Purpose

Generate neighbourhood narrative content for commercial appraisal reports, covering boundaries, main uses, character, and economic context. Two distinct modes with different geographies.

## Core design principle: tiered layers

Everything sorts into two tiers, and knowing which tier a feature sits in tells you where automation pays and where it does not.

- **Spatial / structured backbone:** facts generated almost automatically from spatial or census data. High payoff.
- **Enrichment layer:** the tool surfaces a prompt or a partial read, Jay supplies the judgement. Automating the judgement here burns time for little return.

Shared backbone across both modes: spatial open data plus census. The zoning tool (separate project) is a dependency: the neighbourhood tool identifies predominant zoning, the zoning tool turns a zone code into permitted uses and bulk requirements.

## Mode 1 — Winnipeg neighbourhoods

Usually worked at the individual neighbourhood level (e.g. Daniel McIntyre, William Whyte), occasionally neighbourhood clusters. Defined boundaries read off a map today; automatable from open data.

### Backbone

- **Boundaries:** City of Winnipeg neighbourhood characterization areas (open data). Perimeter streets fall out of intersecting the boundary polygon with the street network: "bounded on the north by Notre Dame, the east by Arlington…"
- **Major thoroughfares** as a fixed reference layer: Main, Portage, Pembina Highway, McPhillips, Lagimodière, Regent, and similar. Referenced for orientation even when they do not touch the subject ("just east of McPhillips, a few blocks south of Portage"). Curate the arterial list once; it is stable and serves every neighbourhood. Computed as proximity and direction, not boundary.
- **Predominant zoning:** intersect neighbourhood polygon with City of Winnipeg zoning layer (open data). Drives the land-use character read. Hands zone codes to the zoning tool for permitted uses / bulk requirements. Caution: Winnipeg zoning open data is current-state only, no past effective date — a limitation for retrospective valuations.
- **Assessment data:** year built and dwelling units per property, aggregated over the polygon. Gives era-of-construction and housing-mix read ("predominantly single-family, postwar" vs "significant apartment stock from the seventies"). Dwelling-units field also confirms whether multi-family zoning is actually built out.

### Enrichment

- **River proximity:** Red, Assiniboine, Seine. Compute distance from polygon and which side; mention when close enough. Spatial, not freehand, but a judgement on the threshold.
- **Schools:** locations are open data, but type and character (public vs independent, French immersion, feel) are patchy and poorly structured. Surface as present; Jay adds the colour. Do not try to automate the judgement.

## Mode 2 — Rural communities

Whole town is the unit (e.g. Steinbach, Niverville, Beausejour, Lac du Bonnet). No boundary problem. The narrative is about trajectory and community profile, not perimeter. Arguably the more automatable of the two modes, and more distinctive.

### Backbone

- **Growth rate:** is the community growing, stable, or contracting. The single most important read — drives demand, absorption, risk. From census data already assembled in Jay's Housing Information portal; read from the portal rather than sourced fresh.
- **Income levels and dwelling values:** presented as tables today; add a short narrative reading each against two benchmarks, Manitoba and Winnipeg ("median household income modestly below the provincial figure and well under Winnipeg's"). The narrative interprets, it does not replace the table. Objective, just ratios off census.
- **Major roadways:** provincial highway network (open data). Which highways serve or pass near the town falls out of geometry.

### Enrichment

- **Economic base:** agriculture vs tourism vs manufacturing vs a mix. Hardest thing in the whole project. Census labour-force-by-industry and possibly Manitoba Bureau of Statistics give a quantitative hint; named major employers are rarely in structured data at town level — that is local knowledge. Tool offers the industry split; Jay supplies named employers.
- **Services / amenities, full-service vs limited-service:** the valuable move is defining the tiers precisely (e.g. full-service = grocery, schools, medical, local government presence; limited = some subset). A defined rubric turns a vague impression into a repeatable call, partly derivable from points-of-interest data (grocery, school, municipal office present). Rural POI data is patchy, so the definitions are the asset more than the data.

## Data sources referenced

- City of Winnipeg open data: neighbourhood characterization areas, zoning layer, school locations, street network.
- Assessment data: year built, dwelling units.
- Census: growth rate, income, dwelling values, labour force by industry, via Jay's Housing Information portal.
- Manitoba provincial highway network (open data).
- Manitoba Bureau of Statistics: possible employment-by-industry.
- Zoning tool (separate project): zone code to permitted uses and bulk requirements.

## Status

Wishlist stage. Shape not locked. Winnipeg and rural are two modes sharing a spatial-and-census backbone.

---

# Implementation plan (added 2026-10-08)

Grounded in a survey of the repo as of main `75668b8`.

## What is already in place

- **Census data** — `web/public/data/housing/census_profile.json` (one file, ~5 MB, no shards; loader `web/src/census-profile.js`). 2,415 regions: PR/CMA/CD, all 2,015 CSDs, and Winnipeg virtual regions (`WPG_NB:<name>`, `WPG_CL:<name>`, `WPG_CA:<name>`). Per region, by census year (2006/2011/2016/2021): population, households, dwellings, 8 structural types; `demo` (2011/2016/2021): period of construction, median household income, median dwelling value, median rent, tenure, age bands. Comparators: Manitoba `46`, Winnipeg CMA `46602`, Winnipeg city `4611040`. Built by `r/12_census_profile.R` + `r/12b_wpg_city_history.R`.
- **Narrative → Word pattern** — `web/src/rtb.js` `narrativeBlocks()` builds ordered `{heading|para|bullet}` blocks from data with template strings, renders them on screen, and passes the same blocks to `exportNarrativeToWord()` in `web/src/word-export.js` (docx npm, Calibri 11, dark-red headings). Copy this pattern.
- **Address lookup** — `web/src/wpg-address.js` resolves a Winnipeg address to neighbourhood / cluster / community area (text index, no coordinates; `census.js` auto-loads the cluster).
- **Maps** — `web/src/geo.js` loads `mb_csd.geojson` (ids = census uids); `web/src/map.js` has the hand-built planar-mercator renderer (don't use d3-geo).
- **Tab registration** — `web/index.html` (nav button + panel) + `web/src/main.js` (`tabs` map, hash list, lazy `once(initX)` entry).

## What is missing

- No labour-force-by-industry at any geography (only province-level LFS in the indicators catalog). Economic base needs a new r/ step pulling census NAICS by CSD.
- Only **medians** for income and dwelling value (no averages). Narrative must say "median".
- City of Winnipeg neighbourhood polygons exist only in the untracked cache `r/lib/cache/geo/wpg_census_boundaries.json` (Socrata re9d-6c9j; `boundary_type` Neighbourhood 194 / Neighbourhood Cluster 23 / CCA 12). `nbhd_602.geojson` is CMHC survey neighbourhoods, not City ones. No street network, zoning, assessment, provincial highways, or point-in-polygon in `web/src` (point-in-ring only in the sub-apps' `shapeFilter.js`).
- Gaps: Manitoba has no median hh income for 2011/2016; small towns often lack pre-2016 trends; 26 of 237 City neighbourhoods have no profile. Text generation must degrade gracefully when a benchmark is missing.

## Phases

### Phase 1 — Rural town narrative from census only (no new data) — ✅ shipped PR #162 (2026-10-08)

Picker: province = MB → CSD (reuse Census Profile cascade). Output blocks:

1. **Growth** — population 2006→2021, 5-yr and 15-yr % change, classed growing / stable / contracting against thresholds relative to Manitoba's rate (e.g. > MB + 2 pts = growing). State the census years used; note gaps.
2. **Income** — median hh income as a ratio to Manitoba and Winnipeg CMA, mapped to a phrase ladder ("roughly in line", "modestly below", "well under"…) with the ratio bands in one config table so wording is repeatable.
3. **Dwelling values** — same treatment on median dwelling value; optionally median rent.
4. **Housing stock** — dominant structural-type share + period-of-construction read ("predominantly single-detached; about 40% built after 2001").
5. **Appraiser notes** — empty bullet stubs for economic base / major employers / service tier so the enrichment prompts are visible in the output.

On-screen render + Download Word via `exportNarrativeToWord`, with the numbers table beneath the prose (narrative interprets, does not replace). Roughly one PR.

### Phase 2 — Rural backbone additions (new data)

- ✅ 2026-10-08: `r/26_census_industry.R` → `census_industry.json` (20 NAICS sectors, 2021 + 2016, PR/CMA/CD for 4 provinces + all MB CSDs; Winnipeg virtual geos opt-in via `CENSUS_INDUSTRY_WPG=1`). Narrative "Employment by industry" paragraph: top-3 sectors + sectors with location quotient ≥ 1.5 (and share ≥ 4%) vs the province; industry table beneath. `LQ_MIN` / `LQ_SHARE_MIN` in census-narrative.js.
- ✅ 2026-10-08: `r/27_build_csd_highways.R` → `mb_csd_highways.json` (Manitoba Road Network 2023, PTH + PR dissolved by number; through / within 15 km with distance + compass direction / boundary distance + direction from Winnipeg, precomputed in R with sf — no client geometry). Narrative "Access and roadways" paragraph replaces the stub for municipalities.
- Service-tier rubric: define as a config table first (grocery, K-12, medical clinic, hospital, municipal office, bank, pharmacy) with a manual checklist UI; auto-fill from POI data later only if worth it.

### Phase 3 — Winnipeg mode

- Ship City neighbourhood polygons: new r/ step writing `web/public/data/geo/wpg_nbhd.geojson` with `{id, name}` properties (matches existing geojson convention); link from the address lookup.
- Curated arterial list (name + centreline geometry) → proximity/direction sentence.
- Boundary street naming: intersect polygon edges with City street centrelines; rule = longest-overlap street per cardinal side, with fallback labels for river / rail / lane. The fiddly part — budget for it.
- Zoning intersection (current-state caveat in output) and assessment aggregation (year built, dwelling units) — both new open-data pulls. Zone codes hand off to a Winnipeg zoning lookup that does not exist yet (the mb-zoning skill is non-Winnipeg only).
- River proximity: Red / Assiniboine / Seine lines, configurable threshold.
- The Phase 1 census blocks run unchanged on `WPG_NB:` / `WPG_CL:` regions.

## Open decisions before Phase 1

1. Tab placement: new "Narrative" tab vs a Narrative section on the Census Profile tab (recommended: section on Census Profile, since pickers and comparators already exist there).
2. Growth / ratio thresholds and the exact phrase ladder — defaults will be proposed; a sample paragraph from a past report would let the wording match Jay's report voice.
3. Whether the rural read includes median rent and tenure, or stays at growth / income / value.
