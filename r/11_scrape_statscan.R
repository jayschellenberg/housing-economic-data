# =============================================================================
# r/11_scrape_statscan.R
# Pull every catalog entry with provider="statscan" from the StatsCan Web
# Data Service via the cansim R package. Writes data/statscan_indicators.csv
# in long form, ISO date.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

suppressPackageStartupMessages({
  if (!requireNamespace("cansim", quietly = TRUE)) install.packages("cansim", repos = "https://cloud.r-project.org")
  library(cansim)
})

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
stc_series <- Filter(function(s) identical(s$provider, "statscan") && !isTRUE(s$disabled),
                     catalog$series)
message(sprintf("[statscan] %d series to pull", length(stc_series)))

# cansim::get_cansim_vector_for_latest_periods needs an integer vector id.
# We pull ~25 years of monthly data which is plenty for the year-range slider.
fetch_vec <- function(vectorId, periods = 350) {
  vec_int <- as.integer(sub("^v", "", vectorId))
  df <- tryCatch(
    get_cansim_vector(vec_int, refresh = FALSE) %||%
    get_cansim_vector_for_latest_periods(vec_int, periods = periods),
    error = function(e) { message(sprintf("  [statscan] %s ERROR: %s", vectorId, conditionMessage(e))); NULL })
  if (is.null(df)) {
    # Fallback to the latest-periods variant
    df <- tryCatch(get_cansim_vector_for_latest_periods(vec_int, periods = periods),
                   error = function(e) NULL)
  }
  if (is.null(df) || nrow(df) == 0) {
    message(sprintf("  [statscan] %s -> 0 rows", vectorId))
    return(NULL)
  }
  df
}

`%||%` <- function(a, b) if (is.null(a)) b else a

results <- lapply(stc_series, function(s) {
  df <- fetch_vec(s$vectorId, periods = 350)
  if (is.null(df) || nrow(df) == 0) return(NULL)
  # cansim returns columns: REF_DATE, VALUE, VECTOR, etc. Normalise to our
  # long-form schema: id / date / value / units / geo / frequency.
  date_col  <- intersect(c("REF_DATE", "Date"), names(df))[1]
  # Prefer val_norm — that's cansim's already-scaled (by SCALAR_FACTOR) value.
  # VALUE is the raw column where dollar amounts are typically in thousands.
  value_col <- intersect(c("val_norm", "VALUE", "value"), names(df))[1]
  slim <- df %>%
    transmute(
      id        = s$id,
      seriesId  = s$vectorId,
      date      = as.character(as.Date(.data[[date_col]])),
      value     = suppressWarnings(as.numeric(.data[[value_col]])),
      units     = s$units,
      geo       = s$geo,
      frequency = s$frequency,
      transform = s$transform
    ) %>%
    filter(!is.na(value))
  message(sprintf("  [statscan] %-44s -> %d rows (%s..%s)",
                  s$id, nrow(slim),
                  if (nrow(slim)) slim$date[1] else "",
                  if (nrow(slim)) slim$date[nrow(slim)] else ""))
  slim
})

ok <- compact(results)
if (length(ok) == 0) stop("[statscan] no series returned data — check WDS availability.")

combined <- bind_rows(ok)
out <- file.path(DATA_DIR, "statscan_indicators.csv")
write_csv(combined, out)
message(sprintf("\n[statscan] Wrote %s (%d rows; %d series)",
                out, nrow(combined), dplyr::n_distinct(combined$id)))
