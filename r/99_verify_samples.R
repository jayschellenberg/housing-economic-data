# =============================================================================
# r/99_verify_samples.R
# Spot-check the generated JSON shards against fresh get_cmhc() calls.
# Exits non-zero on any mismatch >0.01.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

samples <- list(
  list(geoUid = "602", geoLevel = "cma",
       series = "Average Rent",  dimension = "Bedroom Type",
       dwelling_type = "All", year = NULL, category = "2 Bedroom"),
  list(geoUid = "610", geoLevel = "cma",
       series = "Vacancy Rate",  dimension = "Year of Construction",
       dwelling_type = "All", year = NULL, category = "2000 or Later"),
  list(geoUid = "602", geoLevel = "cma",
       series = "Median Rent",   dimension = "Bedroom Type",
       dwelling_type = "Apartment", year = NULL, category = "1 Bedroom"),
  list(geoUid = "46",  geoLevel = "province",
       series = "Average Rent Change", dimension = "Bedroom Type",
       dwelling_type = "All", year = NULL, category = "Total"),
  list(geoUid = "605", geoLevel = "cma",
       series = "Vacancy Rate",  dimension = "Bedroom Type",
       dwelling_type = "All", year = NULL, category = "2 Bedroom")
)

read_shard <- function(level, uid) {
  p <- file.path(SERIES_DIR, sprintf("%s_%s.json", level, uid))
  if (!file.exists(p)) return(NULL)
  fromJSON(p, simplifyVector = TRUE, simplifyDataFrame = TRUE)
}

failures <- 0L
passes   <- 0L

for (i in seq_along(samples)) {
  s <- samples[[i]]
  cat(sprintf("\n[verify %d] %s | %s | %s | dw=%s\n",
              i, s$geoUid, s$series, s$dimension, s$dwelling_type))

  # Live API call (latest year).
  live <- safe_get_cmhc(
    series        = s$series,
    dimension     = s$dimension,
    breakdown     = "Historical Time Periods",
    geo_uid       = s$geoUid,
    dwelling_type = s$dwelling_type,
    quiet         = TRUE
  )
  if (is.null(live) || nrow(live) == 0) {
    cat("  -> API returned nothing; SKIP\n"); next
  }
  live <- live %>%
    mutate(Category = extract_category(., s$dimension),
           Year     = extract_year(.)) %>%
    filter(Category == s$category, !is.na(Value), !is.na(Year))
  if (nrow(live) == 0) { cat("  -> API has no rows for this category; SKIP\n"); next }
  live_latest <- live %>% filter(Year == max(Year))
  if (nrow(live_latest) > 1) live_latest <- live_latest %>% slice_tail(n = 1)

  # JSON shard lookup.
  shard <- read_shard(s$geoLevel, s$geoUid)
  if (is.null(shard)) { cat("  -> shard missing; FAIL\n"); failures <- failures + 1L; next }
  recs <- shard$records
  hit <- recs %>%
    dplyr::filter(series == s$series,
                  dimension == s$dimension,
                  category == s$category,
                  dwellingType == s$dwelling_type,
                  year == live_latest$Year)
  if (nrow(hit) == 0) { cat("  -> no matching shard record; FAIL\n"); failures <- failures + 1L; next }

  delta <- abs(as.numeric(hit$value[1]) - as.numeric(live_latest$Value))
  if (is.na(delta) || delta > 0.01) {
    cat(sprintf("  -> mismatch: shard=%.4f api=%.4f delta=%.4f; FAIL\n",
                as.numeric(hit$value[1]), as.numeric(live_latest$Value), delta))
    failures <- failures + 1L
  } else {
    cat(sprintf("  -> match: %.4f (year %d); PASS\n",
                as.numeric(hit$value[1]), as.integer(live_latest$Year)))
    passes <- passes + 1L
  }
}

cat(sprintf("\n[verify] %d pass / %d fail\n", passes, failures))
if (failures > 0) quit(status = 1L)
