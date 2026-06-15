# =============================================================================
# r/12_census_profile.R
# Population & Dwelling Trends (2006/2011/2016/2021) + 2021 Demographics for
# every Manitoba geography (PR / CMA-CA / CD / CSD) plus the City-of-Winnipeg
# virtual geographies (Community Area / Cluster / Neighbourhood, DA-aggregated).
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

# =============================================================================
# Batched fetch: one get_census() per (dataset, level).
# Returns a data.frame: GeoUID, name, Population, Dwellings, Households, + one
# column per field (named by the field key), for every region at that level.
# =============================================================================
fetch_level <- function(dataset, level, fields) {
  vids <- resolve_fields(dataset, fields)
  df <- get_census(dataset = dataset, regions = list(PR = MB_PR), level = level,
                   vectors = unname(vids), use_cache = TRUE, quiet = TRUE, geo_format = NA)
  out <- data.frame(
    uid        = as.character(df$GeoUID),
    name       = as.character(df$`Region Name` %||% df$name),
    Population = suppressWarnings(as.numeric(df$Population)),
    Dwellings  = suppressWarnings(as.numeric(df$Dwellings)),
    Households = suppressWarnings(as.numeric(df$Households)),
    stringsAsFactors = FALSE
  )
  for (nm in names(fields)) {
    col <- grep(sprintf("^%s(:|$)", vids[[nm]]), names(df), value = TRUE)[1]
    out[[nm]] <- if (is.na(col)) NA_real_ else suppressWarnings(as.numeric(df[[col]]))
  }
  out
}

# DA-level fetch for the City of Winnipeg (one row per dissemination area),
# chunked because CensusMapper caps DA-level (fine-geography) requests at
# ~750 "cells" (regions x vectors) — much stricter than CSD level. With the 39
# combined trend+demo vectors that means <=18 DAs/request (18*39=702 < 750).
# The DA id list comes from the lookup CSV so chunk boundaries are stable across
# runs; use_cache=TRUE then makes re-runs (and resumes after a quota hit) free.
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

message("[12] Fetching 2021 Demographics for all levels…")
demo_raw <- setNames(map(STD_LEVELS, \(lv) {
  message(sprintf("    2021 / %s", lv)); fetch_level("CA21", lv, DEMO_FIELDS)
}), names(STD_LEVELS))

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
demo_obj_for <- function(level, uid) {
  r <- demo_raw[[level]][demo_raw[[level]]$uid == uid, ]
  if (nrow(r) == 0) return(NULL)
  o <- list(population = round_or_na(r$Population), households = round_or_na(r$Households))
  for (k in DEMO_KEYS) {
    agg <- DEMO_FIELDS[[k]]$agg %||% "sum"
    o[[k]] <- if (grepl("wmean", agg)) round_dec(r[[k]]) else round_or_na(r[[k]])
  }
  o
}
round_or_na <- function(x) if (length(x) == 0 || !is.finite(x)) NA else round(x)
round_dec   <- function(x) if (length(x) == 0 || !is.finite(x)) NA else round(x, 1)

regions_out <- list()
for (level in names(STD_LEVELS)) {
  # Use the union of uids appearing in 2021 trends + demo for this level.
  uids <- unique(c(trends_raw[["2021"]][[level]]$uid, demo_raw[[level]]$uid))
  for (uid in uids) {
    nm <- {
      n <- trends_raw[["2021"]][[level]]$name[trends_raw[["2021"]][[level]]$uid == uid]
      if (!length(n)) n <- demo_raw[[level]]$name[demo_raw[[level]]$uid == uid]
      n[1]
    }
    pop <- round_or_na(demo_raw[[level]]$Population[demo_raw[[level]]$uid == uid][1] %||% NA)
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
        trends = list(`2021` = yr),   # virtual geos: 2021 only (2021 DA boundaries)
        demo = demo
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
  trendKeys   = as.list(TREND_KEYS),
  demoKeys    = as.list(DEMO_KEYS),
  regions     = regions_out
)
out_dir <- file.path(WEB_DATA, "housing")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "census_profile.json")
writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 10), out_path, useBytes = TRUE)
message(sprintf("[12] Wrote %s (%d regions)", out_path, length(regions_out)))
