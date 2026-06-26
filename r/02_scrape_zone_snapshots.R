# =============================================================================
# r/02_scrape_zone_snapshots.R
# Loop year=CMHC_ZONE_START (default 2000) .. current to pull Survey Zone,
# Neighbourhood, and Census Subdivision snapshots from CMHC and stitch into
# long-form CSVs. The cmhc API does not expose historical time series at
# zone/neighbourhood/CSD level — yearly snapshots are the only path. Missing
# years are silently dropped, not interpolated. (CMHC publishes CSDs as a
# breakdown OF a CMA, not at province level — the province-level CSD breakdown
# 500s for every province, so we discover them per-CMA here, same as zones.)
#
# Outputs:
#   data/zone_snapshots.csv
#   data/neighbourhood_snapshots.csv
#   data/csd_snapshots.csv
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

current_year <- as.integer(format(Sys.Date(), "%Y"))
# Default snapshot loop: 2000..current. CMHC may not have older snapshots for
# every CMA/year; tryCatch in safe_get_cmhc silently drops 4xx/5xx responses.
# Override the start year with the CMHC_ZONE_START env var if needed.
zone_start_year <- as.integer(Sys.getenv("CMHC_ZONE_START", unset = "2000"))
years <- seq(zone_start_year, current_year)

# v1 scope reducers — override via env vars when needed (GitHub Action runs
# full scope). Keeps the initial local refresh under ~3 minutes.
ZONE_CMAS_USE <- {
  raw <- Sys.getenv("CMHC_ZONE_CMAS", unset = "Winnipeg")
  if (raw == "ALL") ZONE_CMAS else ZONE_CMAS[names(ZONE_CMAS) %in% strsplit(raw, ",")[[1]]]
}
ZONE_DWELLING_USE <- {
  raw <- Sys.getenv("CMHC_ZONE_DWELLING", unset = "All")
  if (raw == "ALL") DWELLING_TYPES else strsplit(raw, ",")[[1]]
}
message(sprintf("[02] Scope: CMAs=%s | dwelling=%s | years=%d..%d",
                paste(names(ZONE_CMAS_USE), collapse=","),
                paste(ZONE_DWELLING_USE, collapse=","),
                min(years), max(years)))

# Series + dimension combos to pull (snapshot rows are smaller, so we can
# afford to pull more combos than the historical scrape).
SNAPSHOT_SERIES <- c("Vacancy Rate", "Average Rent", "Median Rent",
                     "Average Rent Change", "Rental Universe")

SNAPSHOT_DIMS_BY_SERIES <- list(
  "Vacancy Rate"        = c("Bedroom Type", "Year of Construction",
                            "Structure Size", "Rent Ranges"),
  "Average Rent"        = c("Bedroom Type", "Year of Construction",
                            "Structure Size"),
  "Median Rent"         = c("Bedroom Type", "Year of Construction",
                            "Structure Size"),
  "Average Rent Change" = c("Bedroom Type"),
  "Rental Universe"     = c("Bedroom Type", "Year of Construction",
                            "Structure Size")
)

# Build the (geo x series x dimension x dwelling x year) grid for both
# breakdowns. Zones live under CMAs only (ZONE_CMAS).
build_grid <- function(breakdown) {
  cmas <- tibble::tibble(uid = unname(ZONE_CMAS_USE), name = names(ZONE_CMAS_USE))
  map_dfr(seq_len(nrow(cmas)), function(i) {
    g <- cmas[i, ]
    map_dfr(SNAPSHOT_SERIES, function(s) {
      dims <- SNAPSHOT_DIMS_BY_SERIES[[s]]
      expand.grid(uid           = g$uid,
                  cma_name      = g$name,
                  series        = s,
                  dimension     = dims,
                  dwelling_type = ZONE_DWELLING_USE,
                  year          = years,
                  breakdown     = breakdown,
                  stringsAsFactors = FALSE)
    })
  })
}

pull_snapshot <- function(uid, cma_name, series, dimension, dwelling_type,
                          year, breakdown) {
  df <- safe_get_cmhc(
    series        = series,
    dimension     = dimension,
    breakdown     = breakdown,
    geo_uid       = uid,
    geo_name      = cma_name,
    geo_level     = "cma",
    dwelling_type = dwelling_type,
    year          = year,
    quiet         = TRUE
  )
  if (is.null(df) || nrow(df) == 0) return(NULL)
  df %>%
    mutate(
      ZoneName   = extract_zone_name(.),
      Year       = as.integer(year),
      Category   = extract_category(., dimension),
      ParentUID  = uid,
      ParentName = cma_name
    ) %>%
    filter(!is.na(ZoneName) & ZoneName != "")
}

run_breakdown <- function(breakdown, out_filename, geo_level) {
  message(sprintf("\n[02] === %s ===", breakdown))
  grid <- build_grid(breakdown)
  message(sprintf("[02] %d queries to run for breakdown=%s", nrow(grid), breakdown))

  results <- pmap(
    list(grid$uid, grid$cma_name, grid$series, grid$dimension,
         grid$dwelling_type, grid$year, grid$breakdown),
    pull_snapshot
  )

  ok <- compact(results)
  message(sprintf("[02] %d / %d queries returned rows for breakdown=%s",
                  length(ok), length(results), breakdown))

  if (length(ok) == 0) {
    message(sprintf("[02] No data for breakdown=%s; writing empty CSV.", breakdown))
    write_csv(tibble::tibble(
      GeoUID = character(), GeoName = character(), GeoLevel = character(),
      ParentUID = character(), ParentName = character(),
      Year = integer(), Season = character(),
      Series = character(), Dimension = character(), Category = character(),
      DwellingType = character(), Value = numeric(), Quality = character()
    ), file.path(DATA_DIR, out_filename))
    return(invisible(NULL))
  }

  combined <- bind_rows(lapply(ok, function(df) df %>%
                                 mutate(across(where(is.factor), as.character))))

  # Synthetic per-zone GeoUID = parent CMA UID + capped slug of the zone name.
  # zone_slug (cmhc_helpers.R) keeps the shard filename Windows-path-safe and is
  # shared with r/05 so both shard trees use the identical identifier.

  slim <- combined %>%
    mutate(
      Season = "October"  # snapshots use October as CMHC's canonical reporting period
    ) %>%
    transmute(
      GeoUID       = paste0(ParentUID, "-", zone_slug(ZoneName)),
      GeoName      = ZoneName,
      GeoLevel     = geo_level,
      ParentUID    = as.character(ParentUID),
      ParentName   = as.character(ParentName),
      Year         = as.integer(Year),
      Season       = as.character(Season),
      Series       = as.character(Series),
      Dimension    = as.character(Dimension),
      Category     = as.character(Category),
      DwellingType = as.character(DwellingType),
      Value        = as.numeric(Value),
      Quality      = if ("Quality" %in% names(.)) as.character(Quality) else NA_character_
    ) %>%
    filter(!is.na(Value), !is.na(Year), !is.na(Category))

  out_path <- file.path(DATA_DIR, out_filename)
  write_csv(slim, out_path)
  message(sprintf("[02] Wrote %s (%d rows; %d distinct zones; years %d..%d)",
                  out_path, nrow(slim),
                  dplyr::n_distinct(slim$GeoUID),
                  suppressWarnings(min(slim$Year, na.rm = TRUE)),
                  suppressWarnings(max(slim$Year, na.rm = TRUE))))
}

run_breakdown("Survey Zones",       "zone_snapshots.csv",          "zone")
run_breakdown("Neighbourhoods",     "neighbourhood_snapshots.csv", "neighbourhood")
run_breakdown("Census Subdivision", "csd_snapshots.csv",           "csd")
