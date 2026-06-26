# =============================================================================
# r/05_scrape_starts.R
# Pull Scss (Starts & Completions Survey) housing construction data:
#   - Series: Starts, Completions, Under Construction
#   - Dimensions: Dwelling Type, Intended Market
#   - Frequencies: Annual (canonical) + Quarterly (for finer-grained view)
#   - Geographies: Province, CMAs/CAs, CSDs that passed audit, plus
#                  Winnipeg Survey Zones + Neighbourhoods via yearly snapshot
#                  stitching (similar to r/02_scrape_zone_snapshots.R).
# Output: data/housing_starts.csv (long form)
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

audit_path <- file.path(DATA_DIR, "geography_audit.csv")
if (!file.exists(audit_path)) {
  stop("[05] geography_audit.csv not found. Run r/00_audit_geographies.R first.")
}
audit <- read_csv(audit_path, show_col_types = FALSE,
                  col_types = cols(uid = col_character())) %>%
  filter(success) %>%
  mutate(uid = as.character(uid))

SCSS_SERIES <- c("Starts", "Completions", "Under Construction",
                 "Absorbed Units", "Unabsorbed Inventory")
SCSS_DIMENSIONS <- c("Dwelling Type", "Intended Market")
# Some (series x dimension) combos aren't valid — e.g. Unabsorbed Inventory
# is only published by Dwelling Type, not Intended Market. safe_scss returns
# NULL on the resulting CMHC error so the rest of the grid is unaffected.
SCSS_FREQUENCIES <- c("Annual", "Quarterly")

# Scope reducers — match the v1 zone scrape pattern.
SCSS_ZONE_START_YEAR <- as.integer(Sys.getenv("CMHC_STARTS_START", unset = "2010"))
SCSS_ZONE_CMAS <- {
  raw <- Sys.getenv("CMHC_STARTS_ZONES", unset = "Winnipeg")
  if (raw == "ALL") ZONE_CMAS else ZONE_CMAS[names(ZONE_CMAS) %in% strsplit(raw, ",")[[1]]]
}
message(sprintf("[05] Zone scope: CMAs=%s | years=%d..%d",
                paste(names(SCSS_ZONE_CMAS), collapse=","),
                SCSS_ZONE_START_YEAR,
                as.integer(format(Sys.Date(), "%Y"))))

# --- Safe Scss wrapper -------------------------------------------------------
# Mirrors safe_get_cmhc in cmhc_helpers.R but for the Scss survey and with a
# `frequency` parameter so we can pull both Annual and Quarterly.
safe_scss <- function(series, dimension, breakdown, geo_uid, frequency,
                      geo_name = NA_character_, geo_level = NA_character_,
                      year = NULL, quiet = TRUE) {
  call_args <- list(
    survey    = "Scss",
    series    = series,
    dimension = dimension,
    breakdown = breakdown,
    geo_uid   = geo_uid,
    frequency = frequency
  )
  if (!is.null(year)) call_args$year <- year
  tryCatch({
    df <- do.call(cmhc::get_cmhc, call_args)
    if (is.null(df) || nrow(df) == 0) return(NULL)
    df <- df %>%
      mutate(across(where(is.factor), as.character)) %>%
      mutate(
        Survey     = "Scss",
        Series     = series,
        Dimension  = dimension,
        Breakdown  = breakdown,
        Frequency  = frequency,
        GeoUID     = as.character(geo_uid),
        GeoName    = as.character(geo_name),
        GeoLevel   = as.character(geo_level)
      )
    if (!quiet) message(sprintf("    -> %d rows (%s | %s | %s | %s | %s)",
                                nrow(df), series, dimension, breakdown, geo_name, frequency))
    df
  }, error = function(e) {
    if (!quiet) message(sprintf("    -> ERROR: %s", conditionMessage(e)))
    NULL
  })
}

# =============================================================================
# Part 1 — Historical Time Periods at province/CMA/CSD level
# =============================================================================
message("\n[05] === Historical Time Periods (province / CMA / CSD) ===")

htp_geos <- audit  # use the same successful audit list
htp_grid <- map_dfr(seq_len(nrow(htp_geos)), function(i) {
  g <- htp_geos[i, ]
  expand.grid(
    uid       = g$uid,
    name      = g$name,
    level     = g$level,
    series    = SCSS_SERIES,
    dimension = SCSS_DIMENSIONS,
    frequency = SCSS_FREQUENCIES,
    stringsAsFactors = FALSE
  )
})
message(sprintf("[05] HTP queries: %d", nrow(htp_grid)))

htp_pull <- pmap(htp_grid, function(uid, name, level, series, dimension, frequency) {
  message(sprintf("[05] %s | %s | %s | %s | %s", name, series, dimension, level, frequency))
  safe_scss(series, dimension, "Historical Time Periods", uid, frequency,
            geo_name = name, geo_level = level)
})
htp_ok <- compact(htp_pull)
message(sprintf("[05] HTP rows returned: %d / %d", length(htp_ok), length(htp_pull)))

# =============================================================================
# Part 2 — Survey Zones + Neighbourhoods + Census Subdivisions via yearly
# snapshot stitching (CMHC exposes CSDs as a per-CMA breakdown, same as zones).
# =============================================================================
message("\n[05] === Survey Zones + Neighbourhoods + Census Subdivisions ===")

current_year <- as.integer(format(Sys.Date(), "%Y"))
years <- seq(SCSS_ZONE_START_YEAR, current_year)

zone_grid <- function(breakdown) {
  cmas <- tibble::tibble(uid = unname(SCSS_ZONE_CMAS), name = names(SCSS_ZONE_CMAS))
  map_dfr(seq_len(nrow(cmas)), function(i) {
    g <- cmas[i, ]
    expand.grid(
      uid        = g$uid,
      parent     = g$name,
      series     = SCSS_SERIES,
      dimension  = SCSS_DIMENSIONS,
      frequency  = SCSS_FREQUENCIES,
      year       = years,
      breakdown  = breakdown,
      stringsAsFactors = FALSE
    )
  })
}

pull_zone_snapshot <- function(uid, parent, series, dimension, frequency, year, breakdown) {
  df <- safe_scss(series, dimension, breakdown, uid, frequency,
                  geo_name = parent, geo_level = "cma", year = year)
  if (is.null(df) || nrow(df) == 0) return(NULL)
  df %>%
    mutate(
      ZoneName   = extract_zone_name(.),
      Year       = as.integer(year),
      ParentUID  = uid,
      ParentName = parent
    ) %>%
    filter(!is.na(ZoneName) & ZoneName != "")
}

zone_results <- list()
for (bk in c("Survey Zones", "Neighbourhoods", "Census Subdivision")) {
  grid <- zone_grid(bk)
  message(sprintf("[05] %s queries: %d", bk, nrow(grid)))
  res <- pmap(grid, pull_zone_snapshot)
  ok  <- compact(res)
  message(sprintf("[05] %s returned: %d / %d", bk, length(ok), length(res)))
  zone_results[[bk]] <- ok
}

# =============================================================================
# Part 3 — Unify and write
# =============================================================================
# Zone / neighbourhood GeoUID slug is the capped, Windows-path-safe zone_slug()
# from cmhc_helpers.R (shared with r/02).

# Helper: extract Year + Quarter for an Scss result frame. Defensive against
# missing DateString (zone-snapshot responses) and missing Date (rare).
parse_period <- function(df) {
  n <- nrow(df)
  if (n == 0) return(tibble::tibble(Year = integer(0), Quarter = character(0)))
  has_ds   <- "DateString" %in% names(df)
  has_date <- "Date"       %in% names(df)
  has_yr   <- "Year"       %in% names(df)
  ds  <- if (has_ds)   as.character(df$DateString) else rep(NA_character_, n)
  yr  <- suppressWarnings(as.integer(sub("^([0-9]{4}).*", "\\1", ds)))
  if (any(is.na(yr)) && has_date) {
    fallback <- suppressWarnings(as.integer(format(as.Date(df$Date), "%Y")))
    yr <- ifelse(is.na(yr), fallback, yr)
  }
  if (any(is.na(yr)) && has_yr) {
    yr <- ifelse(is.na(yr), as.integer(df$Year), yr)
  }
  qtr <- ifelse(grepl("/Q[1-4]$", ds), sub(".*/Q([1-4])$", "\\1", ds), NA_character_)
  tibble::tibble(Year = yr, Quarter = qtr)
}

# Historical (Province/CMA/CSD) — already long-form with the right metadata.
hist_combined <- if (length(htp_ok)) bind_rows(lapply(htp_ok, function(df) {
  pp <- parse_period(df)
  df %>%
    mutate(across(where(is.factor), as.character)) %>%
    mutate(
      Year      = pp$Year,
      Quarter   = pp$Quarter,
      Category  = if (first(.$Dimension) %in% names(df)) df[[first(.$Dimension)]] else NA_character_,
      ParentUID  = NA_character_,
      ParentName = NA_character_
    )
})) else tibble::tibble()

# Zones / Neighbourhoods — flatten with synthetic geoUid keyed by parent.
flatten_zone <- function(df_list, level_label) {
  if (!length(df_list)) return(tibble::tibble())
  bind_rows(lapply(df_list, function(df) {
    pp <- parse_period(df)
    df %>%
      mutate(across(where(is.factor), as.character)) %>%
      mutate(
        Year     = pp$Year,
        Quarter  = pp$Quarter,
        Category = if (first(.$Dimension) %in% names(df)) df[[first(.$Dimension)]] else NA_character_,
        GeoLevel = level_label,
        GeoName  = ZoneName,
        GeoUID   = paste0(ParentUID, "-", zone_slug(ZoneName))
      )
  }))
}
zone_combined <- flatten_zone(zone_results[["Survey Zones"]],    "zone")
nbhd_combined <- flatten_zone(zone_results[["Neighbourhoods"]], "neighbourhood")
csd_combined  <- flatten_zone(zone_results[["Census Subdivision"]], "csd")

all_combined <- bind_rows(hist_combined, zone_combined, nbhd_combined, csd_combined)
if (nrow(all_combined) == 0) {
  stop("[05] No Scss data returned from any query.")
}

slim <- all_combined %>%
  transmute(
    GeoUID     = as.character(GeoUID),
    GeoName    = as.character(GeoName),
    GeoLevel   = as.character(GeoLevel),
    ParentUID  = as.character(ParentUID),
    ParentName = as.character(ParentName),
    Year       = as.integer(Year),
    Quarter    = as.character(Quarter),
    Frequency  = as.character(Frequency),
    Series     = as.character(Series),
    Dimension  = as.character(Dimension),
    Category   = as.character(Category),
    Value      = as.numeric(Value),
    Quality    = if ("Quality" %in% names(.)) as.character(Quality) else NA_character_
  ) %>%
  filter(!is.na(Value), !is.na(Year), !is.na(Category))

out_path <- file.path(DATA_DIR, "housing_starts.csv")
write_csv(slim, out_path)
message(sprintf("\n[05] Wrote %s (%d rows; %d distinct GeoUIDs; %d-%d)",
                out_path, nrow(slim),
                dplyr::n_distinct(slim$GeoUID),
                min(slim$Year, na.rm=TRUE), max(slim$Year, na.rm=TRUE)))
