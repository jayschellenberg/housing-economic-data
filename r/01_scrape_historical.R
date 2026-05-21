# =============================================================================
# r/01_scrape_historical.R
# Pull historical RMS time series for every Province / CMA / CSD that passed
# the geography audit, across every valid (series x dimension) combo and each
# of the three dwelling-type filters (All / Apartment / Row).
#
# Output: data/historical_rental.csv (long-form)
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

audit_path <- file.path(DATA_DIR, "geography_audit.csv")
if (!file.exists(audit_path)) {
  stop("[01] geography_audit.csv not found. Run r/00_audit_geographies.R first.")
}

audit <- read_csv(audit_path, show_col_types = FALSE) %>% filter(success)
message(sprintf("[01] %d geographies passed the audit; pulling historical data.",
                nrow(audit)))

# Build the parameter grid: (geo, series, dimension, dwelling_type) where
# the dimension is valid for that series per the curated catalog.
grid <- map_dfr(seq_len(nrow(audit)), function(i) {
  g <- audit[i, ]
  rows <- map_dfr(RMS_SERIES, function(s) {
    dims <- RMS_DIMENSIONS_BY_SERIES[[s]]
    expand.grid(series = s, dimension = dims,
                dwelling_type = DWELLING_TYPES,
                stringsAsFactors = FALSE)
  })
  rows$uid   <- g$uid
  rows$name  <- g$name
  rows$level <- g$level
  rows
})

message(sprintf("[01] Total queries to run: %d", nrow(grid)))

pull_one <- function(uid, name, level, series, dimension, dwelling_type) {
  message(sprintf("[01] %s | %s | %s | %s | dw=%s",
                  name, series, dimension, level, dwelling_type))
  safe_get_cmhc(
    series       = series,
    dimension    = dimension,
    breakdown    = "Historical Time Periods",
    geo_uid      = uid,
    geo_name     = name,
    geo_level    = level,
    dwelling_type = dwelling_type,
    quiet        = TRUE
  )
}

# pmap to enforce argument order; on errors safe_get_cmhc already swallows.
pulled <- pmap(
  list(grid$uid, grid$name, grid$level,
       grid$series, grid$dimension, grid$dwelling_type),
  pull_one
)

ok <- compact(pulled)
message(sprintf("[01] %d / %d queries returned rows.", length(ok), length(pulled)))

if (length(ok) == 0) {
  stop("[01] No historical data returned from any query. Check network / cmhc package.")
}

combined <- bind_rows(lapply(ok, function(df) {
  df <- df %>% mutate(across(where(is.factor), as.character))
  df %>%
    mutate(
      Year     = extract_year(.),
      Category = extract_category(., first(.$Dimension)),
      Season   = if ("DateString" %in% names(.)) DateString else NA_character_
    )
}))

# Try to derive Season from Date if DateString is absent — CMHC RMS reports
# in April (early) and October (late). Use month >= 7 as October cutoff.
if (all(is.na(combined$Season)) && "Date" %in% names(combined)) {
  combined <- combined %>%
    mutate(Season = if_else(
      as.integer(format(as.Date(Date), "%m")) >= 7, "October", "April"
    ))
}

slim <- combined %>%
  transmute(
    GeoUID       = as.character(GeoUID),
    GeoName      = as.character(GeoName),
    GeoLevel     = as.character(GeoLevel),
    Year         = as.integer(Year),
    Season       = as.character(Season),
    Series       = as.character(Series),
    Dimension    = as.character(Dimension),
    Category     = as.character(Category),
    DwellingType = as.character(DwellingType),
    Value        = as.numeric(Value),
    Quality      = if ("Quality" %in% names(.)) as.character(Quality) else NA_character_
  ) %>%
  filter(!is.na(Year), !is.na(Value), !is.na(Category))

out_path <- file.path(DATA_DIR, "historical_rental.csv")
write_csv(slim, out_path)
message(sprintf("[01] Wrote %s (%d rows; %d distinct GeoUIDs)",
                out_path, nrow(slim), dplyr::n_distinct(slim$GeoUID)))
