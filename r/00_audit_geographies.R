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

# 1. Provinces + their CMAs/CAs + known centre-CSDs (always attempt these).
core_geos <- bind_rows(
  PROVINCES %>% transmute(uid, name, level = "province"),
  CMAS %>% transmute(uid, name, level),
  if (nrow(CENTRE_CSDS)) CENTRE_CSDS %>% transmute(uid, name, level) else NULL
)

# 2. Dynamic CSD discovery — for every full-detail province, pull the CSDs CMHC
#    publishes via that province's Census Subdivision breakdown. This is the
#    canonical list of CSDs CMHC reports data for. basic-detail provinces are
#    province + CMA only, so they are skipped here.
discover_csds <- function(prov_uid, prov_name) {
  message(sprintf("[audit] Discovering CSDs for %s via Census Subdivision breakdown...", prov_name))
  listing <- safe_get_cmhc(
    series    = "Vacancy Rate",
    dimension = "Bedroom Type",
    breakdown = "Census Subdivision",
    geo_uid   = prov_uid,
    geo_name  = prov_name,
    geo_level = "province",
    quiet     = TRUE
  )
  if (is.null(listing) || nrow(listing) == 0) return(NULL)
  zone_col_name <- extract_zone_name(listing)
  # The CSD GeoUID column in cmhc varies by version — check several names.
  uid_col <- intersect(names(listing),
                       c("GeoUID2", "Sub-GeoUID", "SubGeoUID", "geo_uid", "GeoCode"))
  if (!length(uid_col)) {
    message("[audit] CSD GeoUID column not found for ", prov_name,
            "; columns: ", paste(names(listing), collapse = ", "))
    return(NULL)
  }
  listing %>%
    transmute(uid = as.character(.data[[uid_col[1]]]),
              name = zone_col_name,
              level = "csd") %>%
    distinct(uid, .keep_all = TRUE) %>%
    filter(!is.na(uid) & uid != "")
}

full_provs <- PROVINCES %>% filter(detail == "full")
discovered_csds <- if (nrow(full_provs)) {
  bind_rows(lapply(seq_len(nrow(full_provs)),
                   function(i) discover_csds(full_provs$uid[i], full_provs$name[i])))
} else tibble::tibble(uid = character(), name = character(), level = character())

# Drop the core-list centre CSDs from the discovered set to avoid double-auditing.
if (nrow(discovered_csds)) {
  discovered_csds <- discovered_csds %>% filter(!(uid %in% CENTRE_CSDS$uid))
}

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
