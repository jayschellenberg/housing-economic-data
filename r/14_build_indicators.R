# =============================================================================
# r/14_build_indicators.R
# Read every *_indicators.csv (currently boc + statscan; cba once unblocked),
# join with the catalog metadata, and write web/public/data/indicators/
# shards plus indicators-manifest.json.
#
# Shard layout: one JSON per displayGroup (mortgage_market.json,
# credit_conditions.json, prices.json, supply.json, demand.json,
# construction_cost.json, derived.json). Each is a long-form record array.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
INDICATORS_DIR <- file.path(WEB_DATA, "indicators")
dir.create(INDICATORS_DIR, recursive = TRUE, showWarnings = FALSE)

# Catalog as a lookup keyed by id. We attach the catalog metadata to every
# record so the frontend doesn't have to load the catalog separately.
cat_by_id <- setNames(catalog$series, vapply(catalog$series, function(s) s$id, character(1)))

# --- Read CSVs ---------------------------------------------------------------
read_safe <- function(path) {
  if (!file.exists(path)) {
    message(sprintf("[14] %s not found, skipping", path))
    return(tibble::tibble())
  }
  read_csv(path, show_col_types = FALSE)
}

boc <- read_safe(file.path(DATA_DIR, "boc_indicators.csv"))
stc <- read_safe(file.path(DATA_DIR, "statscan_indicators.csv"))
cba <- read_safe(file.path(DATA_DIR, "cba_arrears.csv"))   # not yet produced; harmless empty
osb <- read_safe(file.path(DATA_DIR, "osb_indicators.csv"))

all_obs <- bind_rows(boc, stc, cba, osb)
# Normalise date column to character — read_csv may auto-detect Date type
# on some columns; downstream binds + JSON serialisation expect ISO strings.
if (nrow(all_obs) > 0) all_obs$date <- as.character(all_obs$date)

# --- CMHC rent ingest -------------------------------------------------------
# The Rental Charts tab's data (data/historical_rental.csv) gets sliced here
# into a couple of indicator series — Manitoba and Winnipeg-CMA average rent
# for the Total bedroom type, October snapshot, all dwelling types. Provides
# the upstream for the rent-vs-wage growth comparison.
rent_csv <- file.path(DATA_DIR, "historical_rental.csv")
if (file.exists(rent_csv)) {
  # Season comes through as "YYYY October" — match on substring.
  cmhc_rent <- read_csv(rent_csv, show_col_types = FALSE) %>%
    filter(Series       == "Average Rent",
           Dimension    == "Bedroom Type",
           Category     == "Total",
           DwellingType == "All",
           grepl("October", Season, fixed = TRUE),
           as.character(GeoUID) %in% c("46", "602")) %>%
    mutate(GeoUID = as.character(GeoUID))
  if (nrow(cmhc_rent) > 0) {
    rent_id  <- c("46" = "cmhc.rent.manitoba", "602" = "cmhc.rent.winnipeg")
    rent_geo <- c("46" = "MB",                  "602" = "Winnipeg-CMA")
    rent_recs <- cmhc_rent %>%
      transmute(
        id        = rent_id[GeoUID],
        seriesId  = rent_id[GeoUID],
        date      = sprintf("%04d-10-01", as.integer(Year)),
        value     = as.numeric(Value),
        units     = "dollar",
        geo       = rent_geo[GeoUID],
        frequency = "annual",
        transform = "none"
      ) %>%
      filter(!is.na(value)) %>%
      arrange(id, date)
    all_obs <- bind_rows(all_obs, rent_recs)
    message(sprintf("[14] appended %d CMHC rent records", nrow(rent_recs)))
  }
}

if (nrow(all_obs) == 0) stop("[14] no indicator data found — run the scrape scripts first.")

# --- Derived series ---------------------------------------------------------
# Catalog rows with provider="derived" carry a derivedOp + derivedFrom that
# tell the builder how to compute the new values from existing records.
#
# Supported ops:
#   yoy     — year-over-year % change of a single source series (lag matched
#              to its native frequency)
#   shift   — single-source value + offset (e.g. 5-yr GoC + 300 bps for a
#              representative cap rate)
#   ratio   — ratio of two source series aligned by date (inner join), times
#              the catalog row's `multiplier` so the result is a usable index
# ---------------------------------------------------------------------------
derived_series <- Filter(function(s) identical(s$provider, "derived"),
                         catalog$series)

compute_yoy <- function(s) {
  src <- all_obs %>% filter(id == s$derivedFrom) %>% arrange(date)
  if (nrow(src) == 0) return(NULL)
  src_freq <- cat_by_id[[s$derivedFrom]]$frequency
  lag_n <- switch(src_freq, monthly = 12L, quarterly = 4L, annual = 1L, 12L)
  v <- (src$value / dplyr::lag(src$value, n = lag_n) - 1) * 100
  keep <- !is.na(v)
  tibble::tibble(
    id = s$id, seriesId = s$id,
    date = src$date[keep], value = v[keep],
    units = "percent", geo = s$geo,
    frequency = src_freq, transform = "yoy"
  )
}

compute_shift <- function(s) {
  src <- all_obs %>% filter(id == s$derivedFrom) %>% arrange(date)
  if (nrow(src) == 0) return(NULL)
  off <- as.numeric(s$shiftBy %||% 0)
  tibble::tibble(
    id = s$id, seriesId = s$id,
    date = src$date, value = src$value + off,
    units = cat_by_id[[s$derivedFrom]]$units,
    geo = s$geo,
    frequency = cat_by_id[[s$derivedFrom]]$frequency,
    transform = "shift"
  )
}

compute_ratio <- function(s) {
  # derivedFrom must be a length-2 array of source IDs.
  ids <- unlist(s$derivedFrom)
  if (length(ids) != 2) return(NULL)
  a <- all_obs %>% filter(id == ids[1]) %>% select(date, va = value)
  b <- all_obs %>% filter(id == ids[2]) %>% select(date, vb = value)
  if (nrow(a) == 0 || nrow(b) == 0) return(NULL)
  joined <- inner_join(a, b, by = "date") %>% arrange(date)
  if (nrow(joined) == 0) return(NULL)
  mult <- as.numeric(s$multiplier %||% 100)
  v <- joined$va / joined$vb * mult
  tibble::tibble(
    id = s$id, seriesId = s$id,
    date = joined$date, value = v,
    units = s$units %||% "index", geo = s$geo,
    frequency = cat_by_id[[ids[1]]]$frequency,
    transform = "ratio"
  )
}

# mortgage_payment: standard P&I = P × [r(1+r)^n] / [(1+r)^n - 1] where the
# source series carries the annual rate as a percent. principal and
# amortMonths come from the catalog row.
compute_mortgage_payment <- function(s) {
  src <- all_obs %>% filter(id == s$derivedFrom) %>% arrange(date)
  if (nrow(src) == 0) return(NULL)
  P <- as.numeric(s$principal %||% 400000)
  n <- as.integer(s$amortMonths %||% 300)
  ann_rate <- src$value / 100
  r <- ann_rate / 12
  pmt <- P * r * (1 + r)^n / ((1 + r)^n - 1)
  pmt[!is.finite(pmt) | pmt <= 0] <- NA_real_
  keep <- !is.na(pmt)
  tibble::tibble(
    id = s$id, seriesId = s$id,
    date = src$date[keep], value = pmt[keep],
    units = "dollar", geo = s$geo,
    frequency = cat_by_id[[s$derivedFrom]]$frequency,
    transform = "mortgage_payment"
  )
}

# per_capita: numerator series ÷ population series × multiplier (e.g.
# ×1000 for "per thousand people"). Date join is inner; for a monthly
# numerator and a quarterly population, only the months that align with
# population quarters survive. Acceptable resolution for a directional
# indicator.
compute_per_capita <- function(s) {
  ids <- unlist(s$derivedFrom)
  if (length(ids) != 2) return(NULL)
  num <- all_obs %>% filter(id == ids[1]) %>% select(date, vn = value) %>% arrange(date)
  pop <- all_obs %>% filter(id == ids[2]) %>% select(date, vp = value) %>% arrange(date)
  if (nrow(num) == 0 || nrow(pop) == 0) return(NULL)
  joined <- inner_join(num, pop, by = "date") %>% arrange(date)
  if (nrow(joined) == 0) return(NULL)
  mult <- as.numeric(s$multiplier %||% 1)
  v <- joined$vn / joined$vp * mult
  tibble::tibble(
    id = s$id, seriesId = s$id,
    date = joined$date, value = v,
    units = s$units %||% "ratio", geo = s$geo,
    frequency = cat_by_id[[ids[1]]]$frequency,
    transform = "per_capita"
  )
}

if (length(derived_series) > 0) {
  message(sprintf("[14] computing %d derived series", length(derived_series)))
  derived_rows <- bind_rows(lapply(derived_series, function(s) {
    res <- switch(s$derivedOp %||% "",
                  yoy              = compute_yoy(s),
                  shift            = compute_shift(s),
                  ratio            = compute_ratio(s),
                  mortgage_payment = compute_mortgage_payment(s),
                  per_capita       = compute_per_capita(s),
                  NULL)
    if (is.null(res) || nrow(res) == 0) {
      message(sprintf("  [14] %s — could not compute (op=%s)", s$id, s$derivedOp))
      return(NULL)
    }
    res
  }))
  if (nrow(derived_rows) > 0) {
    all_obs <- bind_rows(all_obs, derived_rows)
    message(sprintf("[14] appended %d derived records", nrow(derived_rows)))
  }
}

# --- Attach catalog metadata + map to displayGroup --------------------------
all_obs <- all_obs %>%
  mutate(date = as.character(as.Date(date))) %>%
  rowwise() %>%
  mutate(
    displayGroup  = cat_by_id[[id]]$displayGroup %||% "other",
    expectedTitle = cat_by_id[[id]]$expectedTitle %||% id,
    sourceUrl     = cat_by_id[[id]]$sourceUrl     %||% "",
    provider      = cat_by_id[[id]]$provider      %||% NA_character_,
    seriesIdOut   = cat_by_id[[id]]$seriesId %||% cat_by_id[[id]]$vectorId %||% ""
  ) %>%
  ungroup()

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# --- Per-group shards --------------------------------------------------------
clear_dir <- function(d) {
  if (dir.exists(d)) {
    f <- list.files(d, pattern = "\\.json$", full.names = TRUE)
    if (length(f)) file.remove(f)
  }
  dir.create(d, recursive = TRUE, showWarnings = FALSE)
}
clear_dir(INDICATORS_DIR)

groups <- unique(all_obs$displayGroup)
shard_meta <- list()
for (g in groups) {
  sub <- all_obs %>% filter(displayGroup == g) %>% arrange(id, date)
  # Series-level metadata block included once per series at the top.
  series_in_group <- unique(sub$id)
  meta <- lapply(series_in_group, function(sid) {
    s <- cat_by_id[[sid]]
    last <- sub %>% filter(id == sid) %>% slice_tail(n = 1)
    item <- list(
      id            = sid,
      provider      = s$provider,
      seriesId      = s$seriesId %||% s$vectorId,
      title         = s$expectedTitle,
      frequency     = s$frequency,
      units         = s$units,
      indexBase     = s$indexBase,
      geo           = s$geo,
      transform     = s$transform,
      displayGroup  = s$displayGroup,
      chartId       = s$chartId,
      chartLabel    = s$chartLabel,
      sourceUrl     = s$sourceUrl,
      latestDate    = if (nrow(last)) last$date  else NA,
      latestValue   = if (nrow(last)) last$value else NA
    )
    # Strip NULL and zero-length entries so jsonlite doesn't render them as `{}`.
    Filter(function(x) !is.null(x) && length(x) > 0, item)
  })
  payload <- list(
    group   = g,
    series  = meta,
    records = sub %>% transmute(id, date, value)
  )
  out <- file.path(INDICATORS_DIR, sprintf("%s.json", g))
  writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null", digits = 6),
             out, useBytes = TRUE)
  shard_meta[[g]] <- list(
    group       = g,
    file        = basename(out),
    seriesCount = length(meta),
    recordCount = nrow(sub),
    latestDate  = max(sub$date, na.rm = TRUE)
  )
  message(sprintf("[14] Wrote %s (%d series, %d records, latest %s)",
                  out, length(meta), nrow(sub), max(sub$date, na.rm = TRUE)))
}

# --- Indicators manifest -----------------------------------------------------
manifest <- list(
  version     = 1,
  generated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  groups      = unname(shard_meta),
  totalSeries = length(unique(all_obs$id)),
  totalRecords = nrow(all_obs)
)
imf_path <- file.path(WEB_DATA, "indicators-manifest.json")
writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null"),
           imf_path, useBytes = TRUE)
message(sprintf("[14] Wrote %s (%d groups, %d series, %d records)",
                imf_path, length(shard_meta), manifest$totalSeries, manifest$totalRecords))

# --- Copy the catalog into the public data tree so the frontend can read --
# the charts / displayGroups / snapshotPick metadata without a separate API.
catalog_out <- file.path(INDICATORS_DIR, "_catalog.json")
file.copy(CATALOG_PATH, catalog_out, overwrite = TRUE)
message(sprintf("[14] Copied catalog to %s", catalog_out))
