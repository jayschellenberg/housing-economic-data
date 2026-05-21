# =============================================================================
# r/00_audit_geographies.R
# Discover Manitoba CSDs with CMHC coverage and record per-geography success.
# Output: data/geography_audit.csv
#
# Run BEFORE 01_scrape_historical.R so the historical scrape can iterate only
# the CSDs that actually return rows.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

audit_path <- file.path(DATA_DIR, "geography_audit.csv")

audit_one <- function(uid, name, level) {
  message(sprintf("[audit] %s (%s, %s)...", name, uid, level))
  df <- safe_get_cmhc(
    series    = "Vacancy Rate",
    dimension = "Bedroom Type",
    breakdown = "Historical Time Periods",
    geo_uid   = uid,
    geo_name  = name,
    geo_level = level,
    quiet     = TRUE
  )
  if (is.null(df) || nrow(df) == 0) {
    return(tibble::tibble(
      uid = uid, name = name, level = level,
      success = FALSE, rows = 0L,
      year_min = NA_integer_, year_max = NA_integer_
    ))
  }
  yrs <- extract_year(df)
  tibble::tibble(
    uid = uid, name = name, level = level,
    success = TRUE, rows = nrow(df),
    year_min = suppressWarnings(min(yrs, na.rm = TRUE)),
    year_max = suppressWarnings(max(yrs, na.rm = TRUE))
  )
}

# 1. Province + named CMAs + named centre-CSDs (always attempt these).
core_geos <- bind_rows(
  tibble::tibble(uid = MB_PROVINCE_UID, name = "Manitoba", level = "province"),
  MB_CMAS,
  MB_CENTRE_CSDS
)

# 2. Manitoba CSD list — pulled from CMHC's Census Subdivision breakdown of
#    the province. This is the canonical list of CSDs CMHC publishes data for.
message("[audit] Pulling Manitoba CSD list via Census Subdivision breakdown...")
csd_listing <- safe_get_cmhc(
  series    = "Vacancy Rate",
  dimension = "Bedroom Type",
  breakdown = "Census Subdivision",
  geo_uid   = MB_PROVINCE_UID,
  geo_name  = "Manitoba",
  geo_level = "province",
  quiet     = TRUE
)

discovered_csds <- tibble::tibble(uid = character(), name = character(), level = character())
if (!is.null(csd_listing) && nrow(csd_listing) > 0) {
  zone_col_name <- extract_zone_name(csd_listing)
  # The CSD GeoUID column in cmhc varies by version — check several names.
  uid_col <- intersect(names(csd_listing),
                       c("GeoUID2", "Sub-GeoUID", "SubGeoUID", "geo_uid", "GeoCode"))
  if (length(uid_col)) {
    discovered_csds <- csd_listing %>%
      transmute(uid = as.character(.data[[uid_col[1]]]),
                name = zone_col_name,
                level = "csd") %>%
      distinct(uid, .keep_all = TRUE) %>%
      filter(!is.na(uid) & uid != "")
  } else {
    message("[audit] CSD GeoUID column not found in Census Subdivision breakdown; ",
            "skipping dynamic CSD discovery. Columns: ",
            paste(names(csd_listing), collapse = ", "))
  }
}

# Drop the core-list CSDs from the discovered set to avoid double-auditing.
discovered_csds <- discovered_csds %>%
  filter(!(uid %in% c(MB_CENTRE_CSDS$uid)))

all_geos <- bind_rows(core_geos, discovered_csds) %>%
  distinct(uid, .keep_all = TRUE)

message(sprintf("[audit] Auditing %d geographies...", nrow(all_geos)))

audit_rows <- pmap_dfr(all_geos, function(uid, name, level) {
  audit_one(uid, name, level)
})

write_csv(audit_rows, audit_path)

message(sprintf("[audit] Wrote %s (%d rows; %d successful, %d failed)",
                audit_path, nrow(audit_rows),
                sum(audit_rows$success), sum(!audit_rows$success)))
