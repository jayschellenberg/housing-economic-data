# =============================================================================
# r/16_scrape_mls.R  (LOCAL ONLY: never run in GitHub Actions)
# CREA MLS(R) Home Price Index for the MB Economic Update and Affordability tabs:
#   CREA MLS HPI ZIP -> Winnipeg single-family benchmark history (Figure 3)
#   + peak/trough commentary numbers, plus other cities' single-family
#   benchmarks for the Affordability tab.
#
# Why local: CREA's terms (crea.ca/legal) allow private, non-commercial use and
# need CREA's prior written consent to publish HPI values or charts, so the
# public site ships none of it. This writes to AppMarketData-Internal and the
# tabs read it in the browser through the Local Data strip (web/src/crea-store.js).
# The WRREB market-release figures come from r/16b_scrape_wrreb.R the same way.
#
# Graceful degradation: the previous output IS the last-good cache. A failed
# scrape keeps it with stale = TRUE and exits 2, so the scheduled-task wrapper
# (scripts/wrreb_monthly.ps1) raises an alert. Exit 1 = setup problem.
# Output (--out overrides):
#   <Dropbox>/SharedInfo/AppMarketData/AppMarketData-Internal/CREAHPI/mls_benchmark.json
# =============================================================================

if (identical(Sys.getenv("GITHUB_ACTIONS"), "true") || nzchar(Sys.getenv("CI"))) {
  message("[16] refusing to run in CI: CREA HPI figures are internal-only (see file header)")
  quit(status = 1)
}

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else normalizePath("r", winslash = "/")
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))
suppressPackageStartupMessages({
  if (!requireNamespace("httr",   quietly = TRUE)) install.packages("httr",   repos = "https://cloud.r-project.org")
  if (!requireNamespace("readxl", quietly = TRUE)) install.packages("readxl", repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

# r/ -> housing-economic-data/ -> ClaudeCode/ -> Dropbox root
DROPBOX <- dirname(dirname(dirname(.this_dir)))
AMD     <- file.path(DROPBOX, "SharedInfo", "AppMarketData")
DEFAULT_OUT <- file.path(AMD, "AppMarketData-Internal", "CREAHPI", "mls_benchmark.json")
cli <- commandArgs(trailingOnly = TRUE)
oi  <- match("--out", cli)
BENCH_PATH <- if (!is.na(oi) && oi < length(cli)) cli[oi + 1] else DEFAULT_OUT
if (identical(BENCH_PATH, DEFAULT_OUT) && !dir.exists(AMD)) {
  # Never invent the tier tree somewhere else (a different Dropbox layout).
  message(sprintf("[16] %s not found: is this the Dropbox ClaudeCode tree? Use --out to write elsewhere.", AMD))
  quit(status = 1)
}
dir.create(dirname(BENCH_PATH), recursive = TRUE, showWarnings = FALSE)
today <- Sys.Date()

read_json_safe <- function(p) if (file.exists(p)) tryCatch(jsonlite::read_json(p, simplifyVector = TRUE), error = function(e) NULL) else NULL
write_json <- function(obj, p) writeLines(jsonlite::toJSON(obj, auto_unbox = TRUE, na = "null", pretty = TRUE, digits = 6), p, useBytes = TRUE)

# =============================================================================
# 1. CREA MLS HPI — Winnipeg single-family benchmark history
# =============================================================================
scrape_benchmark <- function() {
  # CREA posts one zip per release month (~the 10th-14th, carrying the prior
  # month's data) but the FILE NAME drifts: MLS_HPI_May_2026.zip,
  # MLS_HPI-July-2026_EN.zip and MLS_HPI_Aug_2026.zip have all been seen. The
  # old single-pattern guess silently fell back to the last month that still
  # matched (May 2026 -> April data, fetched in September). So:
  #   (a) read the link off the HPI tool page, matching any of those shapes;
  #   (b) fall back to guessing the last 6 release months in every shape.
  HPI_PAGE <- "https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/"
  HPI_BASE <- "https://www.crea.ca/files/mls-hpi-data/"
  ua <- add_headers(`User-Agent` = "Mozilla/5.0")
  # Resolve a month token by unambiguous PREFIX so "Sep", "Sept" and "September"
  # all land on 9. CREA named the 2026-09 release MLS_HPI_Sept_2026.zip; the old
  # fixed full-name/3-letter vocabulary rejected "Sept", then crashed on the
  # empty result, then the URL guesses (which never tried "Sept") fell back to
  # the August zip -- so the site sat on July data with no alert. Ambiguous or
  # unknown tokens resolve to NA.
  month_of <- function(tok) pmatch(tolower(tok), tolower(month.name), duplicates.ok = TRUE)
  link_rx <- 'href="([^"]*MLS_HPI[-_]([A-Za-z]+)[-_]([0-9]{4})(?:_EN)?\\.zip)"'

  page_links <- tryCatch({
    r <- GET(HPI_PAGE, ua, timeout(60))
    if (status_code(r) != 200) stop("HTTP ", status_code(r))
    html  <- content(r, as = "text", encoding = "UTF-8")
    hits  <- regmatches(html, gregexpr(link_rx, html, perl = TRUE))[[1]]
    parts <- regmatches(hits, regexec(link_rx, hits, perl = TRUE))
    url <- vapply(parts, `[`, "", 2)
    mon <- tolower(vapply(parts, `[`, "", 3))
    yr  <- suppressWarnings(as.integer(vapply(parts, `[`, "", 4)))
    mi  <- month_of(mon)
    ok  <- !is.na(mi) & !is.na(yr)
    if (!any(ok)) {
      # basename()/ifelse() on an empty vector used to throw here, which read
      # as "page scrape failed" and hid the real story (link found, month
      # token not understood). Say so, then let the guesses run.
      message(sprintf("[16] HPI page: %d zip link(s) but none with a readable month/year (%s) -- guessing URLs",
                      length(url), if (length(url)) paste(basename(url), collapse = ", ") else "none"))
      character(0)
    } else {
      url <- url[ok]; ym <- yr[ok] * 12 + mi[ok]
      url <- ifelse(grepl("^https?://", url), url, paste0("https://www.crea.ca", url))
      message(sprintf("[16] HPI page lists %d zip link(s): %s", length(url), paste(basename(url), collapse = ", ")))
      unique(url[order(-ym)])                   # newest release first
    }
  }, error = function(e) { message("[16] HPI page scrape failed: ", conditionMessage(e), " -- guessing URLs"); character(0) })

  guesses <- unlist(lapply(0:5, function(k) {
    d <- seq(today, by = "-1 month", length.out = k + 1)[k + 1]
    mi <- as.integer(format(d, "%m")); y <- format(d, "%Y")
    toks <- unique(c(month.name[mi], month.abb[mi], if (mi == 9L) "Sept"))
    paste0(HPI_BASE, c(sprintf("MLS_HPI_%s_%s.zip",    toks, y),
                       sprintf("MLS_HPI-%s-%s_EN.zip", toks, y)))
  }))
  cands <- unique(c(page_links, guesses))

  dest <- file.path(tempdir(), "crea_hpi.zip")
  src <- NULL
  for (u in cands) {
    ok <- tryCatch({
      r <- GET(u, write_disk(dest, overwrite = TRUE), ua, timeout(90))
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

  # Additional city single-family benchmarks from the same national workbook (one
  # sheet per board) — for the Affordability purchase factor (SK/AB/BC). Winnipeg
  # keeps its full hpi summary above (used by the MB Economic Update tab).
  EXTRA_CITIES <- list(
    list(rx = "calgary",   id = "mls.hpi.calgary.sf",   geo = "Calgary"),
    list(rx = "edmonton",  id = "mls.hpi.edmonton.sf",  geo = "Edmonton"),
    list(rx = "saskatoon", id = "mls.hpi.saskatoon.sf", geo = "Saskatoon"),
    list(rx = "regina",    id = "mls.hpi.regina.sf",    geo = "Regina"),
    list(rx = "greater[ _]vancouver", id = "mls.hpi.vancouver.sf", geo = "Vancouver"),
    list(rx = "victoria",  id = "mls.hpi.victoria.sf",  geo = "Victoria")
  )
  extra_series <- list(); extra_records <- list()
  for (ct in EXTRA_CITIES) {
    nm <- sheets[grepl(ct$rx, sheets, ignore.case = TRUE)]
    if (!length(nm)) { message(sprintf("[16] no MLS sheet for %s — skipping", ct$geo)); next }
    dd <- as.data.frame(readxl::read_excel(xlsx[1], sheet = nm[1]))
    if (!all(c("Date", "Single_Family_Benchmark") %in% names(dd))) next
    dt <- as.Date(dd$Date); v <- suppressWarnings(as.numeric(dd$Single_Family_Benchmark))
    k <- !is.na(dt) & !is.na(v); dt <- dt[k]; v <- v[k]
    if (length(v) < 12) next
    o <- order(dt); dt <- dt[o]; v <- v[o]; li <- length(v)
    extra_series[[length(extra_series) + 1]] <- list(id = ct$id, chartLabel = "Single-family benchmark",
      units = "dollar", geo = ct$geo, frequency = "monthly",
      latestDate = as.character(dt[li]), latestValue = v[li])
    extra_records[[length(extra_records) + 1]] <- data.frame(id = ct$id,
      date = as.character(dt), value = v, stringsAsFactors = FALSE)
    message(sprintf("[16] %s benchmark: %d obs, latest %s = $%s", ct$geo, li, as.character(dt[li]), format(v[li], big.mark = ",")))
  }

  win_series <- list(id = "mls.hpi.winnipeg.sf", chartLabel = "Single-family benchmark",
                     units = "dollar", geo = "Winnipeg", frequency = "monthly",
                     latestDate = as.character(dates[latest_i]), latestValue = sf[latest_i])
  list(
    kind = "crea-hpi", version = 1,
    series = c(list(win_series), extra_series),
    records = do.call(rbind, c(list(records), extra_records)),
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
  message("[16] no benchmark data and no last-good cache")
}

message("[16] done.")
if (is.null(bench) || isTRUE(bench$stale)) quit(status = 2)
