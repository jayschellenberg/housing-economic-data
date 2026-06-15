# =============================================================================
# r/16_scrape_mls.R
# Winnipeg residential resale data for the MB Economic Update tab:
#   1. CREA MLS HPI ZIP -> Winnipeg single-family benchmark history (Figure 3)
#      + peak/trough commentary numbers.   (reliable; predictable URL)
#   2. WRREB monthly release + CREA board page -> headline figures (sales,
#      active listings, SFD/SFA/condo average prices vs prior-year + 5-yr-avg).
#      (fragile prose/HTML scrape — best effort.)
#
# Graceful degradation: the committed JSONs under web/public/data/economy/ ARE
# the last-good cache. Every network step is wrapped so a failure keeps the
# previous values and sets a `stale` flag instead of aborting. NEVER stop().
# Outputs:
#   web/public/data/economy/mls_benchmark.json   (benchmark series + hpi summary)
#   web/public/data/economy/mls_winnipeg.json    (headline figures; seeded)
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))
suppressPackageStartupMessages({
  if (!requireNamespace("httr",   quietly = TRUE)) install.packages("httr",   repos = "https://cloud.r-project.org")
  if (!requireNamespace("readxl", quietly = TRUE)) install.packages("readxl", repos = "https://cloud.r-project.org")
  if (!requireNamespace("rvest",  quietly = TRUE)) install.packages("rvest",  repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

ECON_DIR <- file.path(WEB_DATA, "economy")
dir.create(ECON_DIR, recursive = TRUE, showWarnings = FALSE)
BENCH_PATH <- file.path(ECON_DIR, "mls_benchmark.json")
HEAD_PATH  <- file.path(ECON_DIR, "mls_winnipeg.json")
today <- Sys.Date()

read_json_safe <- function(p) if (file.exists(p)) tryCatch(jsonlite::read_json(p, simplifyVector = TRUE), error = function(e) NULL) else NULL
write_json <- function(obj, p) writeLines(jsonlite::toJSON(obj, auto_unbox = TRUE, na = "null", pretty = TRUE, digits = 6), p, useBytes = TRUE)

# =============================================================================
# 1. CREA MLS HPI — Winnipeg single-family benchmark history
# =============================================================================
scrape_benchmark <- function() {
  # Predictable monthly drop; data lags ~6 weeks, so walk back a few months.
  cands <- vapply(0:5, function(k) {
    d <- seq(today, by = "-1 month", length.out = k + 1)[k + 1]
    sprintf("https://www.crea.ca/files/mls-hpi-data/MLS_HPI_%s_%d.zip",
            format(d, "%B"), as.integer(format(d, "%Y")))
  }, character(1))

  dest <- file.path(tempdir(), "crea_hpi.zip")
  src <- NULL
  for (u in cands) {
    ok <- tryCatch({
      r <- GET(u, write_disk(dest, overwrite = TRUE),
               add_headers(`User-Agent` = "Mozilla/5.0"), timeout(90))
      status_code(r) == 200 && file.exists(dest) && file.size(dest) > 1000
    }, error = function(e) FALSE)
    if (isTRUE(ok)) { src <- u; break }
  }
  if (is.null(src)) stop("could not download any CREA HPI zip")

  ex <- file.path(tempdir(), "crea_hpi_x")
  unlink(ex, recursive = TRUE); dir.create(ex)
  files <- utils::unzip(dest, exdir = ex)
  xlsx <- files[grepl("Not Seasonally Adjusted \\(M\\)\\.xlsx$", files)]
  if (!length(xlsx)) xlsx <- files[grepl("\\(M\\)\\.xlsx$", files)]
  if (!length(xlsx)) stop("monthly HPI workbook not found in zip")
  sheets <- readxl::excel_sheets(xlsx[1])
  win <- sheets[grepl("^winnipeg$", sheets, ignore.case = TRUE)]
  if (!length(win)) stop("WINNIPEG sheet not found")
  d <- readxl::read_excel(xlsx[1], sheet = win[1])
  d <- as.data.frame(d)
  if (!all(c("Date", "Single_Family_Benchmark") %in% names(d)))
    stop("expected Date/Single_Family_Benchmark columns missing")

  dates <- as.Date(d$Date)
  sf    <- suppressWarnings(as.numeric(d$Single_Family_Benchmark))
  keep  <- !is.na(dates) & !is.na(sf)
  dates <- dates[keep]; sf <- sf[keep]
  if (length(sf) < 12) stop("too few benchmark observations")

  ord <- order(dates); dates <- dates[ord]; sf <- sf[ord]   # ensure chronological
  records <- data.frame(id = "mls.hpi.winnipeg.sf",
                        date = as.character(dates), value = sf,
                        stringsAsFactors = FALSE)
  n <- length(sf)
  latest_i <- n
  peak_i   <- which.max(sf)
  is_record <- peak_i == latest_i
  # Recent low = minimum over the trailing 36 months (the post-2022 correction
  # trough in practice) — a more useful reference than the all-time-low start.
  win <- max(1, n - 35):n
  rl_rel <- which.min(sf[win]); rl_i <- win[rl_rel]
  # 5-year change (60 months back, if available).
  fyr_i <- if (n > 60) n - 60 else 1L
  fyr_chg <- if (sf[fyr_i] != 0) round((sf[latest_i] / sf[fyr_i] - 1) * 100, 1) else NA_real_

  list(
    series = list(list(id = "mls.hpi.winnipeg.sf", chartLabel = "Single-family benchmark",
                       units = "dollar", geo = "Winnipeg", frequency = "monthly",
                       latestDate = as.character(dates[latest_i]), latestValue = sf[latest_i])),
    records = records,
    hpi = list(
      benchmarkLatest = sf[latest_i], benchmarkLatestDate = format(dates[latest_i], "%B %Y"),
      isRecordHigh = is_record,
      peakValue = sf[peak_i], peakDate = format(dates[peak_i], "%B %Y"),
      pctFromPeak = round((sf[latest_i] - sf[peak_i]) / sf[peak_i] * 100, 1),
      recentLowValue = sf[rl_i], recentLowDate = format(dates[rl_i], "%B %Y"),
      pctFromRecentLow = round((sf[latest_i] - sf[rl_i]) / sf[rl_i] * 100, 1),
      fiveYrChangePct = fyr_chg
    ),
    asOf = format(dates[latest_i], "%B %Y"),
    source = paste0("CREA MLS® Home Price Index (Winnipeg board) — ", src),
    fetched = as.character(today),
    stale = FALSE
  )
}

bench <- tryCatch(scrape_benchmark(), error = function(e) {
  message("[16] benchmark scrape FAILED: ", conditionMessage(e), " — keeping last-good")
  prev <- read_json_safe(BENCH_PATH)
  if (!is.null(prev)) { prev$stale <- TRUE; prev }
  else NULL
})
if (!is.null(bench)) {
  write_json(bench, BENCH_PATH)
  message(sprintf("[16] benchmark -> %s (%d records, latest %s, stale=%s)",
                  BENCH_PATH, if (is.data.frame(bench$records)) nrow(bench$records) else length(bench$records),
                  bench$asOf %||% "?", bench$stale))
} else {
  message("[16] no benchmark data and no last-good cache — Figure 3 will be empty")
}

# =============================================================================
# 2. Headline figures (sales / listings / average prices) — best effort
# =============================================================================
# WRREB publishes these only as a monthly prose news release (URL + slug change
# every month) and the CREA board page is JS-rendered, so a robust unattended
# parse is not guaranteed. We attempt a light fetch; if we cannot CONFIDENTLY
# extract a full, sane figure set we keep the committed last-good values and
# leave stale=TRUE. (Seeded cache already holds the most recent known release.)
scrape_headline <- function() {
  ua <- add_headers(`User-Agent` = "Mozilla/5.0 (compatible; cmhc-charts/1.0)")
  # Find the latest WRREB market-release article from the listing page.
  listing <- "https://www.winnipegregionalrealestatenews.com/market-statistics/market-releases"
  pg <- tryCatch(rvest::read_html(GET(listing, ua, timeout(45))), error = function(e) NULL)
  if (is.null(pg)) stop("listing page unreachable")
  hrefs <- rvest::html_attr(rvest::html_elements(pg, "a"), "href")
  art <- grep("/market-releases/article/", hrefs, value = TRUE)
  if (!length(art)) stop("no release article link found")
  url <- art[1]
  if (!grepl("^https?://", url)) url <- paste0("https://www.winnipegregionalrealestatenews.com", url)
  doc <- tryCatch(rvest::read_html(GET(url, ua, timeout(45))), error = function(e) NULL)
  if (is.null(doc)) stop("article unreachable")
  txt <- rvest::html_text2(doc)

  # Month label, e.g. "May 2026", from the article text.
  mon <- regmatches(txt, regexpr("(January|February|March|April|May|June|July|August|September|October|November|December)\\s+20[0-9]{2}", txt))
  as_of <- if (length(mon)) mon[1] else NA_character_

  num <- function(pattern) {
    m <- regmatches(txt, regexpr(pattern, txt, perl = TRUE))
    if (!length(m)) return(NA_real_)
    as.numeric(gsub("[^0-9.]", "", m[1]))
  }
  # These patterns are intentionally conservative; if the release wording drifts
  # they return NA and we fall back to last-good. (\x{00ae} = the ® glyph;
  # R's PCRE2 rejects the \u escape, so use the \x{...} form.)
  sales  <- num("[0-9,]+(?=\\s+MLS\\x{00ae} sales)")
  sfd    <- num("(?<=residential[- ]detached average price of \\$)[0-9,]+")
  condo  <- num("(?<=condominium average price of \\$)[0-9,]+")

  got <- sum(!is.na(c(sales, sfd, condo)))
  if (is.na(as_of) || got < 2) stop(sprintf("insufficient confident fields (as_of=%s, got=%d)", as_of, got))

  prev <- read_json_safe(HEAD_PATH) %||% list()
  merge_field <- function(name, value) {
    if (!is.na(value)) list(value = value)
    else prev[[name]]   # keep last-good sub-object if not parsed this run
  }
  out <- prev
  out$asOf   <- as_of
  out$source <- paste0("Winnipeg Regional Real Estate Board (WRREB) — ", url)
  out$fetched <- as.character(today)
  out$stale  <- FALSE
  if (!is.na(sales)) out$sales$value <- sales
  if (!is.na(sfd))   out$sfd_avg_price$value <- sfd
  if (!is.na(condo)) out$condo_avg_price$value <- condo
  # YoY / 5-yr-avg comparisons are not reliably parseable from prose; mark the
  # newly-fetched month so r/15 knows the comparisons may lag the headline value.
  out$comparisonsStale <- TRUE
  out
}

head_out <- tryCatch(scrape_headline(), error = function(e) {
  message("[16] headline scrape FAILED: ", conditionMessage(e), " — keeping last-good (stale)")
  prev <- read_json_safe(HEAD_PATH)
  if (!is.null(prev)) { prev$stale <- TRUE; prev } else NULL
})
if (!is.null(head_out)) {
  write_json(head_out, HEAD_PATH)
  message(sprintf("[16] headline -> %s (asOf %s, stale=%s)",
                  HEAD_PATH, head_out$asOf %||% "?", head_out$stale %||% TRUE))
} else {
  message("[16] no headline data and no last-good cache")
}

message("[16] done.")
