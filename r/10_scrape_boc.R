# =============================================================================
# r/10_scrape_boc.R
# Pull every catalog entry with provider="boc" from the Bank of Canada Valet
# API and write data/boc_indicators.csv in long form, ISO date.
#
# Series include: posted mortgage rates (1/3/5-yr), broker variable rate,
# GoC bond yields (2/5/10-yr), policy target, CORRA, and the 9 SLOS series.
#
# The validation step (r/13_validate_indicators.R) should run BEFORE this.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, DATA_DIR, jsonlite, dplyr, readr

suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
boc_series <- Filter(function(s) identical(s$provider, "boc") && !isTRUE(s$disabled),
                     catalog$series)
message(sprintf("[boc] %d series to pull", length(boc_series)))

# --- Fetch observations for a single series ----------------------------------
fetch_boc <- function(seriesId, start_date = "2005-01-01") {
  url <- sprintf("https://www.bankofcanada.ca/valet/observations/%s/json?start_date=%s",
                 seriesId, start_date)
  resp <- tryCatch(GET(url, timeout(60)), error = function(e) NULL)
  if (is.null(resp) || status_code(resp) != 200) {
    message(sprintf("  [boc] %s -> HTTP %s", seriesId,
                    if (is.null(resp)) "no response" else status_code(resp)))
    return(NULL)
  }
  body <- content(resp, as = "parsed", encoding = "UTF-8")
  obs  <- body$observations
  if (is.null(obs) || length(obs) == 0) {
    message(sprintf("  [boc] %s -> 0 observations", seriesId))
    return(NULL)
  }
  # Each observation is a list like {d: "2026-05-14", "<seriesId>": {v: "4.79"}}
  rows <- lapply(obs, function(o) {
    raw <- o[[seriesId]]
    v <- if (is.list(raw)) raw$v else raw
    list(date = o$d, value = suppressWarnings(as.numeric(v)))
  })
  df <- bind_rows(rows) %>%
    filter(!is.na(value)) %>%
    mutate(seriesId = seriesId)
  message(sprintf("  [boc] %s -> %d obs (%s..%s)",
                  seriesId, nrow(df), df$date[1], df$date[nrow(df)]))
  df
}

results <- lapply(boc_series, function(s) {
  df <- fetch_boc(s$seriesId)
  if (is.null(df) || nrow(df) == 0) return(NULL)
  df %>%
    mutate(id        = s$id,
           units     = s$units,
           geo       = s$geo,
           frequency = s$frequency,
           transform = s$transform)
})
ok <- compact(results)

if (length(ok) == 0) stop("[boc] no BoC series returned data — check network / Valet status.")

combined <- bind_rows(ok) %>%
  transmute(
    id, seriesId, date, value, units, geo, frequency, transform
  )

# Write the long-form CSV. Each row keyed by (id, date).
out <- file.path(DATA_DIR, "boc_indicators.csv")
write_csv(combined, out)
message(sprintf("\n[boc] Wrote %s (%d rows; %d series; max date %s)",
                out, nrow(combined),
                dplyr::n_distinct(combined$id),
                max(as.Date(combined$date), na.rm = TRUE)))
