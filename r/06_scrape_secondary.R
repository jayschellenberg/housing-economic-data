# =============================================================================
# r/06_scrape_secondary.R
# Pull Srms (Secondary Rental Market Survey) data — condo apartments used as
# rentals plus other secondary rental units. Ported from the retired
# "CMHC Rental Data Scrape" project so the data refreshes with the monthly
# workflow instead of living in a separate one-off pipeline.
#   - Series: condo vacancy / rent / universe, rental-condo share, other
#             secondary rental universe & rent
#   - Dimensions: Bedroom Type, Structure Size (not every series supports
#             both — invalid combos error out and are skipped)
#   - Breakdown: Historical Time Periods
#   - Geographies: Manitoba + CMAs/CAs + centre CSDs (CMHC only publishes
#             Srms for the larger centres; the rest return nothing)
# Output: data/secondary_rental.csv (long form)
#         web/public/data/secondary.json (all records, single shard)
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

SRMS_SERIES <- c(
  "Condo Vacancy Rate",
  "Condo Average Rent",
  "Condo Universe",
  "Rental Condo Universe",
  "Percentage Condo used as Rental",
  "Other Secondary Rental Universe",
  "Other Secondary Rental Average Rent"
)
SRMS_DIMENSIONS <- c("Bedroom Type", "Structure Size")

geos <- bind_rows(
  tibble::tibble(uid = MB_PROVINCE_UID, name = "Manitoba", level = "province"),
  MB_CMAS,
  MB_CENTRE_CSDS
)

# --- Safe Srms wrapper ---------------------------------------------------
safe_srms <- function(series, dimension, geo_uid, geo_name, geo_level) {
  tryCatch({
    df <- cmhc::get_cmhc(
      survey    = "Srms",
      series    = series,
      dimension = dimension,
      breakdown = "Historical Time Periods",
      geo_uid   = geo_uid
    )
    if (is.null(df) || nrow(df) == 0) return(NULL)
    df %>%
      mutate(across(where(is.factor), as.character)) %>%
      mutate(
        Series    = series,
        Dimension = dimension,
        GeoUID    = as.character(geo_uid),
        GeoName   = geo_name,
        GeoLevel  = geo_level
      )
  }, error = function(e) NULL)
}

grid <- expand.grid(
  geo_idx   = seq_len(nrow(geos)),
  series    = SRMS_SERIES,
  dimension = SRMS_DIMENSIONS,
  stringsAsFactors = FALSE
)
message(sprintf("[06] Srms queries: %d", nrow(grid)))

results <- pmap(grid, function(geo_idx, series, dimension) {
  g <- geos[geo_idx, ]
  message(sprintf("[06] %s | %s | %s", g$name, series, dimension))
  safe_srms(series, dimension, g$uid, g$name, g$level)
})
ok <- compact(results)
message(sprintf("[06] queries with data: %d / %d", length(ok), length(results)))

if (length(ok) == 0) {
  stop("[06] No Srms data returned from any query.")
}

combined <- bind_rows(ok)

# The dimension name appears as a column for Historical Time Periods pulls;
# rows from a "Bedroom Type" query carry their category in a "Bedroom Type"
# column, etc. Collapse those into one Category vector.
category_vec <- rep(NA_character_, nrow(combined))
for (d in unique(combined$Dimension)) {
  if (d %in% names(combined)) {
    idx <- combined$Dimension == d
    category_vec[idx] <- as.character(combined[[d]][idx])
  }
}

slim <- combined %>%
  mutate(
    Year     = extract_year(combined),
    Category = category_vec
  ) %>%
  transmute(
    GeoUID   = as.character(GeoUID),
    GeoName  = as.character(GeoName),
    GeoLevel = as.character(GeoLevel),
    Year     = as.integer(Year),
    Series   = as.character(Series),
    Dimension = as.character(Dimension),
    Category = as.character(Category),
    Value    = as.numeric(Value),
    Quality  = if ("Quality" %in% names(.)) as.character(Quality) else NA_character_
  ) %>%
  filter(!is.na(Value), !is.na(Year), !is.na(Category))

if (nrow(slim) == 0) {
  stop("[06] Srms data returned but nothing survived normalisation.")
}

csv_path <- file.path(DATA_DIR, "secondary_rental.csv")
write_csv(slim, csv_path)
message(sprintf("[06] Wrote %s (%d rows; %d geos; %d-%d)",
                csv_path, nrow(slim),
                dplyr::n_distinct(slim$GeoUID),
                min(slim$Year, na.rm = TRUE), max(slim$Year, na.rm = TRUE)))

# --- Single JSON shard for the web app ---------------------------------------
# Srms volume is small (~10k records), so one file is fine — no per-geo
# sharding until a UI view actually needs it.
records <- slim %>%
  transmute(
    geoUid   = GeoUID,
    geoName  = GeoName,
    geoLevel = GeoLevel,
    year     = Year,
    series   = Series,
    dimension = Dimension,
    category = Category,
    value    = Value,
    quality  = Quality
  )

payload <- list(
  version   = 1,
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  recordCount = nrow(records),
  records   = records
)
json_path <- file.path(WEB_DATA, "secondary.json")
writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 4),
           json_path, useBytes = TRUE)
message(sprintf("[06] Wrote %s (%d records)", json_path, nrow(records)))
