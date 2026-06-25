# =============================================================================
# r/12_census_profile.R
# Population & Dwelling Trends (2006/2011/2016/2021) + Demographics (2021 plus
# best-effort 2016 & 2011) for every Manitoba geography (PR / CMA-CA / CD / CSD)
# plus the City-of-Winnipeg virtual geographies (Community Area / Cluster /
# Neighbourhood, DA-aggregated). `demo` is keyed by census year so the web tab's
# Census-period selector can switch the Demographics table between censuses.
# Earlier censuses are fetched leniently: period-of-construction buckets and the
# income reference year shift each census (and 2011 long-form is the NHS), so any
# field whose label doesn't resolve for a given year yields NA cells rather than
# aborting the build. 2021 stays strict so its numbers still match the report.
#
# Writes web/public/data/housing/census_profile.json for the "Census Profile"
# tab. This is the same content the MBCensusData Shiny app / Excel report
# produces — the field catalogs and vector-resolution logic are ported verbatim
# from MBCensusData/census_report.R so the numbers match those reports exactly —
# but fetched in batches by geography level (one get_census() call per
# level x census year) instead of one call per region.
#
# RUN-ONCE / MANUAL. Census data is 5-yearly, so this is NOT part of `data:all`
# and is deliberately kept out of the GitHub Actions refresh (which has no
# CensusMapper key). Re-run only when a new census is released.
#
#   # key from MBCensusData/"Cancensus API Key.R" — pass via env, never commit it
#   CM_API_KEY=CensusMapper_xxx Rscript r/12_census_profile.R
#   # or, if already stored via cancensus::set_cancensus_api_key(install=TRUE),
#   Rscript r/12_census_profile.R
#
# Depends on: cancensus, dplyr, purrr, jsonlite
# =============================================================================

suppressPackageStartupMessages({
  for (p in c("cancensus", "dplyr", "purrr", "jsonlite")) {
    if (!requireNamespace(p, quietly = TRUE))
      install.packages(p, repos = "https://cloud.r-project.org")
  }
  library(cancensus); library(dplyr); library(purrr); library(jsonlite)
})

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# ---- Paths -----------------------------------------------------------------
.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
WEB_DATA <- normalizePath(file.path(.this_dir, "..", "web", "public", "data"),
                          winslash = "/", mustWork = FALSE)
WPG_LOOKUP <- file.path(.this_dir, "lib", "wpg_geography_lookup.csv")

# ---- API key + cache -------------------------------------------------------
# cancensus reads getOption("cancensus.api_key") then env CM_API_KEY. Honour an
# already-configured key; otherwise pull from CM_API_KEY / CANCENSUS_API_KEY.
.key <- getOption("cancensus.api_key", "")
if (!nzchar(.key)) .key <- Sys.getenv("CM_API_KEY", Sys.getenv("CANCENSUS_API_KEY", ""))
if (!nzchar(.key)) {
  stop("No CensusMapper API key. Set CM_API_KEY (the key is in ",
       "MBCensusData/'Cancensus API Key.R'), e.g.\n",
       "  CM_API_KEY=CensusMapper_xxx Rscript r/12_census_profile.R", call. = FALSE)
}
options(cancensus.api_key = .key)
# Persist the cache so re-runs (and overlap with the MBCensusData reports) cost
# no extra API quota. Prefer an already-configured path; else the shared
# ~/cancensus_cache that the MBCensusData setup uses.
.cache <- getOption("cancensus.cache_path", Sys.getenv("CM_CACHE_PATH", ""))
if (!nzchar(.cache) || !dir.exists(.cache)) {
  .cache <- path.expand("~/cancensus_cache")
  dir.create(.cache, recursive = TRUE, showWarnings = FALSE)
}
options(cancensus.cache_path = .cache)

DATASETS <- c(`2006` = "CA06", `2011` = "CA11", `2016` = "CA16", `2021` = "CA21")
MB_PR    <- "46"
WPG_CSD  <- "4611040"   # City of Winnipeg (for DA-level fetch)

# Saskatchewan + Alberta + British Columbia (SK/AB 2026-06, BC 2026-06): added at
# province / CMA-CA / CD level for the 2016 + 2021 censuses only. Manitoba keeps
# full history + CSDs; SK/AB/BC skip CSDs (and pre-2016 years) to stay within the
# CensusMapper free-tier 500-region/day cap and keep the flat area picker
# manageable. The Winnipeg virtual geographies (DA-aggregated clusters/community
# areas, r/12b) stay Manitoba-only.
ADD_PR     <- c("47", "48", "59")    # SK, AB, BC
ADD_YEARS  <- c("2016", "2021")
ADD_LEVELS <- c("PR", "CMA", "CD")   # not CSD

# =============================================================================
# Vector resolution (ported from MBCensusData/census_report.R)
# =============================================================================
resolve_vector <- function(dataset, label_regex, parent_regex = NA_character_) {
  vecs <- list_census_vectors(dataset, use_cache = TRUE, quiet = TRUE)
  hits <- vecs[grepl(label_regex, vecs$label, perl = TRUE), ]
  if (nrow(hits) > 1 && "type" %in% names(hits)) {
    totals <- hits[hits$type == "Total", ]
    if (nrow(totals) >= 1) hits <- totals
  }
  if (!is.na(parent_regex) && nrow(hits) > 1) {
    parent_labels <- vecs$label[match(hits$parent_vector, vecs$vector)]
    hits <- hits[grepl(parent_regex, parent_labels, perl = TRUE), ]
  }
  if (nrow(hits) == 0)
    stop(sprintf("No vector in %s for /%s/ (parent /%s/)", dataset, label_regex, parent_regex),
         call. = FALSE)
  if (nrow(hits) > 1)
    stop(sprintf("Ambiguous in %s for /%s/ (parent /%s/):\n%s", dataset, label_regex, parent_regex,
                 paste(sprintf("  %s | %s", hits$vector, hits$label), collapse = "\n")), call. = FALSE)
  hits$vector
}
resolve_fields <- function(dataset, fields)
  map_chr(fields, \(f) resolve_vector(dataset, f$label, f$parent %||% NA))

# Lenient variants: a field that can't be resolved for a given census (a bucket
# that didn't exist yet, a renamed NHS vector, …) resolves to NA instead of
# stopping. Used for the earlier-census Demographics pulls only.
resolve_vector_safe <- function(dataset, label_regex, parent_regex = NA_character_)
  tryCatch(resolve_vector(dataset, label_regex, parent_regex),
           error = function(e) NA_character_)
resolve_fields_lenient <- function(dataset, fields)
  map_chr(fields, \(f) resolve_vector_safe(dataset, f$label, f$parent %||% NA))

# ---- Field catalogs (ported verbatim) --------------------------------------
TRENDS_FIELDS <- list(
  single_detached = list(label = "^Single-detached house$",      parent = "structural type"),
  apt_ge5         = list(label = "five or more storeys",         parent = "structural type"),
  apt_lt5         = list(label = "fewer than five storeys",      parent = "structural type"),
  semi_detached   = list(label = "^Semi-detached house$",        parent = "structural type"),
  row_house       = list(label = "^Row house$",                  parent = "structural type"),
  apt_duplex      = list(label = "duplex",                       parent = "structural type"),
  movable         = list(label = "^Movable dwelling$",           parent = "structural type"),
  other_attached  = list(label = "^Other single-attached house$",parent = "structural type")
)
DEMO_FIELDS <- list(
  age_0_14            = list(label = "^0 to 14 years$",   parent = "Age"),
  age_15_64           = list(label = "^15 to 64 years$",  parent = "Age"),
  age_65_plus         = list(label = "^65 years and (over|older)$", parent = "Age"),
  median_age          = list(label = "^Median age$", parent = NA, agg = "wmean_pop"),
  hh_size_total       = list(label = "^Private households by household size$", parent = NA),
  hh_size_1           = list(label = "^1 person$",  parent = "household size"),
  hh_size_2           = list(label = "^2 persons$", parent = "household size"),
  hh_size_3           = list(label = "^3 persons$", parent = "household size"),
  hh_size_4           = list(label = "^4 persons$", parent = "household size"),
  hh_size_5plus       = list(label = "^5 or more persons$", parent = "household size"),
  avg_hh_size         = list(label = "^Average household size$", parent = NA, agg = "wmean_hh"),
  bed_total           = list(label = "^Total.*by number of bedrooms$", parent = NA),
  bed_0               = list(label = "^No bedrooms$",        parent = "number of bedrooms"),
  bed_1               = list(label = "^1 bedroom$",          parent = "number of bedrooms"),
  bed_2               = list(label = "^2 bedrooms$",         parent = "number of bedrooms"),
  bed_3               = list(label = "^3 bedrooms$",         parent = "number of bedrooms"),
  bed_4plus           = list(label = "^4 or more bedrooms$", parent = "number of bedrooms"),
  period_total        = list(label = "^Total.*period of construction", parent = NA),
  built_1960          = list(label = "^1960 or before$",  parent = "period of construction"),
  built_1961_1980     = list(label = "^1961 to 1980$",    parent = "period of construction"),
  built_1981_1990     = list(label = "^1981 to 1990$",    parent = "period of construction"),
  built_1991_2000     = list(label = "^1991 to 2000$",    parent = "period of construction"),
  built_2001_2005     = list(label = "^2001 to 2005$",    parent = "period of construction"),
  built_2006_2010     = list(label = "^2006 to 2010$",    parent = "period of construction"),
  built_2011_2015     = list(label = "^2011 to 2015$",    parent = "period of construction"),
  built_2016_2021     = list(label = "^2016 to 2021$",    parent = "period of construction"),
  tenure_total        = list(label = "^Total.*tenure", parent = NA),
  owner               = list(label = "^Owner$",  parent = "tenure"),
  renter              = list(label = "^Renter$", parent = "tenure"),
  median_dwelling_val = list(label = "^Median value of dwellings", parent = NA, agg = "wmean_hh"),
  median_rent         = list(label = "^Median monthly shelter costs for rented dwellings", parent = NA, agg = "wmean_hh"),
  median_ind_income   = list(label = "^Median total income in 2020 among recipients", parent = NA, agg = "wmean_pop"),
  median_hh_income    = list(label = "^Median total income of household in 2020", parent = NA, agg = "wmean_hh"),
  tenant_stir_30      = list(label = "^% of tenant households spending 30% or more", parent = NA, agg = "wmean_hh")
)

# Censuses to pull Demographics for. 2021 is the canonical default; 2016 & 2011
# are best-effort (fetched leniently — see header). The web tab keys its period
# selector off these years.
DEMO_DATASETS <- c(`2021` = "CA21", `2016` = "CA16", `2011` = "CA11")

# Income vectors carry the reference year in their label (Census 2021 reports
# 2020 income, 2016→2015, 2011→2010), so parameterise those two labels per
# census; every other DEMO_FIELDS label is stable across censuses.
INCOME_YEAR <- c(`2021` = "2020", `2016` = "2015", `2011` = "2010", `2006` = "2005")
demo_fields_for <- function(year) {
  f  <- DEMO_FIELDS
  iy <- INCOME_YEAR[[year]]
  if (!is.null(iy)) {
    f$median_ind_income$label <- sprintf("^Median total income in %s among recipients", iy)
    f$median_hh_income$label  <- sprintf("^Median total income of household in %s", iy)
  }
  f
}

# =============================================================================
# Batched fetch: one get_census() per (dataset, level).
# Returns a data.frame: GeoUID, name, Population, Dwellings, Households, + one
# column per field (named by the field key), for every region at that level.
# =============================================================================
fetch_level <- function(dataset, level, fields, lenient = FALSE) {
  vids <- if (lenient) resolve_fields_lenient(dataset, fields) else resolve_fields(dataset, fields)
  # Manitoba always; SK + AB only for the 2016/2021 censuses at PR/CMA/CD level.
  yr  <- unname(c(CA06 = "2006", CA11 = "2011", CA16 = "2016", CA21 = "2021")[dataset])
  prs <- if (!is.na(yr) && yr %in% ADD_YEARS && level %in% ADD_LEVELS) c(MB_PR, ADD_PR) else MB_PR
  df <- get_census(dataset = dataset, regions = list(PR = prs), level = level,
                   vectors = unname(vids[!is.na(vids)]), use_cache = TRUE, quiet = TRUE, geo_format = NA)
  out <- data.frame(
    uid        = as.character(df$GeoUID),
    name       = as.character(df$`Region Name` %||% df$name),
    Population = suppressWarnings(as.numeric(df$Population)),
    Dwellings  = suppressWarnings(as.numeric(df$Dwellings)),
    Households = suppressWarnings(as.numeric(df$Households)),
    stringsAsFactors = FALSE
  )
  for (nm in names(fields)) {
    if (is.na(vids[[nm]])) { out[[nm]] <- NA_real_; next }
    col <- grep(sprintf("^%s(:|$)", vids[[nm]]), names(df), value = TRUE)[1]
    out[[nm]] <- if (is.na(col)) NA_real_ else suppressWarnings(as.numeric(df[[col]]))
  }
  out
}

# DA-level fetch for the City of Winnipeg (one row per dissemination area),
# chunked because free CensusMapper keys are capped at 500 region identifiers
# per day (5,000 per month) — so a single request for all ~1,130 Winnipeg DAs is
# rejected ("request exceeds API limit"). Small chunks (18 DAs each) maximise the
# number of chunks that get cached before the daily 500-region cap is hit; with
# use_cache=TRUE and a persistent cache, re-running on later days replays the
# cached chunks for free and pushes ~500 more, so the full Winnipeg build
# completes over ~3 days (1,130 / 500). (Or ask CensusMapper's maintainer for a
# higher quota to do it in one run.) The DA id list comes from the lookup CSV so
# chunk boundaries are stable across runs.
fetch_wpg_das <- function(dataset, fields, chunk_size = 18) {
  vids <- resolve_fields(dataset, fields)
  da_ids <- unique(as.character(read.csv(WPG_LOOKUP, stringsAsFactors = FALSE)$DA_UID))
  chunks <- split(da_ids, ceiling(seq_along(da_ids) / chunk_size))
  parts <- vector("list", length(chunks))
  for (i in seq_along(chunks)) {
    message(sprintf("    Winnipeg DA chunk %d/%d (%d DAs)", i, length(chunks), length(chunks[[i]])))
    df <- get_census(dataset = dataset, regions = list(DA = chunks[[i]]), level = "DA",
                     vectors = unname(vids), use_cache = TRUE, quiet = TRUE, geo_format = NA)
    out <- data.frame(
      DA_UID     = as.character(df$GeoUID),
      Population = suppressWarnings(as.numeric(df$Population)),
      Households = suppressWarnings(as.numeric(df$Households)),
      stringsAsFactors = FALSE
    )
    for (nm in names(fields)) {
      col <- grep(sprintf("^%s(:|$)", vids[[nm]]), names(df), value = TRUE)[1]
      out[[nm]] <- if (is.na(col)) NA_real_ else suppressWarnings(as.numeric(df[[col]]))
    }
    parts[[i]] <- out
    Sys.sleep(0.3)
  }
  do.call(rbind, parts)
}

# Aggregate a set of DA rows into one virtual region. Counts are summed; medians
# / averages / percentages are weighted-mean'd on Population or Households,
# exactly as MBCensusData/census_report.R::fetch_region does.
agg_das <- function(da_rows, fields) {
  w_pop <- da_rows$Population; w_hh <- da_rows$Households
  out <- list(
    Population = sum(da_rows$Population, na.rm = TRUE),
    Households = sum(da_rows$Households, na.rm = TRUE)
  )
  for (nm in names(fields)) {
    agg  <- fields[[nm]]$agg %||% "sum"
    vals <- da_rows[[nm]]
    out[[nm]] <- if (all(is.na(vals))) NA_real_ else switch(agg,
      wmean_pop = stats::weighted.mean(vals, w_pop, na.rm = TRUE),
      wmean_hh  = stats::weighted.mean(vals, w_hh,  na.rm = TRUE),
      sum(vals, na.rm = TRUE))
  }
  out
}

# =============================================================================
# Build
# =============================================================================
STD_LEVELS <- c(PR = "PR", CMA = "CMA", CD = "CD", CSD = "CSD")

message("[12] Resolving + fetching Trends (structural type) for all levels x 4 censuses…")
# trends[[year]][[level]] = data.frame of regions
trends_raw <- map(names(DATASETS), function(y) {
  ds <- DATASETS[[y]]
  setNames(map(STD_LEVELS, \(lv) {
    message(sprintf("    %s / %s", y, lv))
    fetch_level(ds, lv, TRENDS_FIELDS)
  }), names(STD_LEVELS))
})
names(trends_raw) <- names(DATASETS)

message("[12] Fetching Demographics for all levels x ", length(DEMO_DATASETS), " censuses…")
# demo_raw[[year]][[level]] = data.frame of regions. 2021 strict (canonical),
# earlier censuses lenient (NA for fields whose labels don't resolve that year).
# Fetched per census inside tryCatch: 2016/2011 are FRESH pulls (~270 region
# identifiers each) that can exhaust the free 500-region/day CensusMapper cap, so
# a failure on one census drops just that census and still writes the rest. The
# persistent cache replays completed censuses for free on re-run, so the build
# fills the missing year over a later day. 2021 is required (and cached).
demo_raw <- list()
for (y in names(DEMO_DATASETS)) {
  ds <- DEMO_DATASETS[[y]]; flds <- demo_fields_for(y)
  lv <- tryCatch(
    setNames(map(STD_LEVELS, \(level) {
      message(sprintf("    %s / %s", y, level))
      fetch_level(ds, level, flds, lenient = (y != "2021"))
    }), names(STD_LEVELS)),
    error = function(e) {
      if (y == "2021") stop(e)   # 2021 is canonical + cached — never mask it
      message(sprintf("[12] WARNING: %s demographics fetch failed (%s) — skipping this census; re-run later to fill it in.",
                      y, conditionMessage(e)))
      NULL
    })
  if (!is.null(lv)) demo_raw[[y]] <- lv
}

message("[12] Fetching Winnipeg DAs (2021, chunked)…")
COMBINED_FIELDS <- c(TRENDS_FIELDS, DEMO_FIELDS)
wpg_da <- tryCatch(fetch_wpg_das("CA21", COMBINED_FIELDS),
  error = function(e) {
    message("[12] WARNING: Winnipeg DA fetch failed: ", conditionMessage(e),
            " — writing standard Manitoba levels only.")
    NULL
  })

# ---- Assemble standard-level regions ---------------------------------------
LEVEL_TAG <- c(PR = "PR", CMA = "CMA", CD = "CD", CSD = "CSD")
TREND_KEYS <- names(TRENDS_FIELDS)
DEMO_KEYS  <- names(DEMO_FIELDS)

# Index trends by uid across years for a given level.
trend_obj_for <- function(level, uid) {
  obj <- list()
  for (y in names(DATASETS)) {
    row <- trends_raw[[y]][[level]]
    r <- row[row$uid == uid, ]
    if (nrow(r) == 0) next
    yr <- list(population = round_or_na(r$Population),
               households = round_or_na(r$Households),
               dwellings  = round_or_na(r$Dwellings))
    for (k in TREND_KEYS) yr[[k]] <- round_or_na(r[[k]])
    obj[[y]] <- yr
  }
  obj
}
# Year-keyed demographics object: { "2021": {…}, "2016": {…}, "2011": {…} }. A
# census year is omitted for an area when it has no row, or carries no real
# demographic signal (all fields NA — e.g. a label set that didn't resolve).
demo_obj_for <- function(level, uid) {
  obj <- list()
  for (y in names(DEMO_DATASETS)) {
    if (is.null(demo_raw[[y]])) next   # census skipped this run (quota/failure)
    r <- demo_raw[[y]][[level]]
    r <- r[r$uid == uid, ]
    if (nrow(r) == 0) next
    o <- list(population = round_or_na(r$Population), households = round_or_na(r$Households))
    for (k in DEMO_KEYS) {
      agg <- DEMO_FIELDS[[k]]$agg %||% "sum"
      o[[k]] <- if (grepl("wmean", agg)) round_dec(r[[k]]) else round_or_na(r[[k]])
    }
    if (all(vapply(DEMO_KEYS, \(k) is.na(o[[k]]), logical(1)))) next
    obj[[y]] <- o
  }
  if (length(obj) == 0) NULL else obj
}
round_or_na <- function(x) if (length(x) == 0 || !is.finite(x)) NA else round(x)
round_dec   <- function(x) if (length(x) == 0 || !is.finite(x)) NA else round(x, 1)

regions_out <- list()
for (level in names(STD_LEVELS)) {
  # Use the union of uids appearing in 2021 trends + demo for this level.
  uids <- unique(c(trends_raw[["2021"]][[level]]$uid, demo_raw[["2021"]][[level]]$uid))
  for (uid in uids) {
    nm <- {
      n <- trends_raw[["2021"]][[level]]$name[trends_raw[["2021"]][[level]]$uid == uid]
      if (!length(n)) n <- demo_raw[["2021"]][[level]]$name[demo_raw[["2021"]][[level]]$uid == uid]
      n[1]
    }
    pop <- round_or_na(demo_raw[["2021"]][[level]]$Population[demo_raw[["2021"]][[level]]$uid == uid][1] %||% NA)
    regions_out[[length(regions_out) + 1]] <- list(
      uid = uid, name = nm, level = LEVEL_TAG[[level]], pop = pop,
      trends = trend_obj_for(level, uid),
      demo   = demo_obj_for(level, uid)
    )
  }
}

# ---- Winnipeg virtual regions (DA-aggregated, 2021 only) -------------------
if (!is.null(wpg_da)) {
  lk <- read.csv(WPG_LOOKUP, stringsAsFactors = FALSE)
  lk <- lk[!is.na(lk$Neighbourhood) & nzchar(lk$Neighbourhood), ]
  m <- match(wpg_da$DA_UID, as.character(lk$DA_UID))
  wpg_da$CommunityArea <- lk$CommunityArea[m]
  wpg_da$Cluster       <- lk$Cluster[m]
  wpg_da$Neighbourhood <- lk$Neighbourhood[m]
  wj <- wpg_da[!is.na(wpg_da$CommunityArea), ]   # one combined frame, trends + demo

  add_virtual <- function(group_col, tag, prefix) {
    for (g in sort(unique(wj[[group_col]]))) {
      rows <- wj[wj[[group_col]] == g, ]
      ta <- agg_das(rows, TRENDS_FIELDS)
      da <- agg_das(rows, DEMO_FIELDS)
      yr <- list(population = round_or_na(ta$Population),
                 households = round_or_na(ta$Households),
                 dwellings  = NA)
      for (k in TREND_KEYS) yr[[k]] <- round_or_na(ta[[k]])
      demo <- list(population = round_or_na(da$Population), households = round_or_na(da$Households))
      for (k in DEMO_KEYS) {
        agg <- DEMO_FIELDS[[k]]$agg %||% "sum"
        demo[[k]] <- if (grepl("wmean", agg)) round_dec(da[[k]]) else round_or_na(da[[k]])
      }
      regions_out[[length(regions_out) + 1]] <<- list(
        uid = paste0(prefix, ":", g), name = g, level = tag,
        pop = round_or_na(da$Population),
        trends = list(`2021` = yr),          # virtual geos: 2021 only (2021 DA boundaries)
        demo   = list(`2021` = demo)         # year-keyed to match standard levels
      )
    }
  }
  message("[12] Aggregating Winnipeg virtual geographies…")
  add_virtual("CommunityArea", "WPG_CA",      "WPG_CA")
  add_virtual("Cluster",       "WPG_Cluster", "WPG_CL")
  add_virtual("Neighbourhood", "WPG_Nbhd",    "WPG_NB")
} else {
  message("[12] Skipped Winnipeg virtual geographies (DA fetch unavailable).")
}

# ---- Write JSON ------------------------------------------------------------
payload <- list(
  source      = "Statistics Canada, Census of Population (2006, 2011, 2016, 2021), via CensusMapper / cancensus",
  sourceUrl   = "https://censusmapper.ca/",
  generatedBy = "r/12_census_profile.R",
  censusYears = as.list(names(DATASETS)),
  demoYears   = as.list(names(DEMO_DATASETS)),
  trendKeys   = as.list(TREND_KEYS),
  demoKeys    = as.list(DEMO_KEYS),
  regions     = regions_out
)
out_dir <- file.path(WEB_DATA, "housing")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "census_profile.json")
writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 10), out_path, useBytes = TRUE)
message(sprintf("[12] Wrote %s (%d regions)", out_path, length(regions_out)))
