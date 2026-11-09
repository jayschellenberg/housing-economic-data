# =============================================================================
# r/16_scrape_mls.R
# Winnipeg residential resale data for the MB Economic Update tab:
#   1. CREA MLS HPI ZIP -> Winnipeg single-family benchmark history (Figure 3)
#      + peak/trough commentary numbers.   (reliable; predictable URL)
#   2. WRREB monthly release + CREA board page -> headline figures (sales,
#      active listings, SFD/SFA/condo average prices vs prior-year + 5-yr-avg).
#      (tables in the monthly release PDF — best effort.)
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
  message("[16] no benchmark data and no last-good cache — Figure 3 will be empty")
}

# =============================================================================
# 2. Headline figures (sales / listings / average prices) — best effort
# =============================================================================
# WRREB publishes a monthly release (URL + slug change every month). Since the
# 2026-09 release the web prose carries only percentages ("up 3% from 2025") --
# the figures live in the attached "<Month> <Year> Market Release.pdf", whose
# tables give every value we need plus prior-year and 5-year-average columns:
#
#   October 2026 – All Residential Detached
#                    October 2026      vs. 2025            vs. 5-Year Average
#   Active Listings     1,926      +20% ▲  (1,603)      +5% ▲   (1,832)
#   Sales                 853       -7% ▼    (912)      +2% ▲     (840)
#   Average Price    $455,860       +3% ▲ ($441,981)    +8% ▲ ($420,224)
#
# We read the monthly (non-YTD) region-wide tables: All MLS® (sales, active
# listings), All Residential Detached / Attached / Condominium (average price).
# Anything not parsed keeps its last-good sub-object; if the month or fewer
# than 3 of the 5 headline fields parse we stop() -> last-good, stale=TRUE.
wrreb_pdf_url <- function(article_html, base) {
  hrefs <- rvest::html_attr(rvest::html_elements(article_html, "a"), "href")
  pdf <- grep("\\.pdf$", hrefs, value = TRUE, ignore.case = TRUE)
  pdf <- pdf[grepl("market", pdf, ignore.case = TRUE) & grepl("release", pdf, ignore.case = TRUE)]
  if (!length(pdf)) return(NA_character_)
  # WRREB writes Windows-style paths with spaces ("/uploads/public\photos\...
  # October%202026 Market Release.pdf"): normalise to a valid URL.
  u <- utils::URLdecode(pdf[1])
  u <- utils::URLencode(u)                 # spaces -> %20
  u <- gsub("\\\\", "%5C", u)              # backslashes -> %5C (what the server expects)
  if (!grepl("^https?://", u)) u <- paste0(base, u)
  u
}

# Parse one table block. `lines` = PDF text lines; `title` = regex for the
# block's title remainder (after "<Month> <Year> – "). Returns a named list of
# rows, each list(value, vsPriorYearPct, priorYearValue, vs5yrAvgPct, fiveYrAvg).
wrreb_table <- function(lines, month_rx, title) {
  # Title must be the WHOLE line (so "All Residential Detached – Winnipeg" and
  # "YTD October 2026 – All ..." are excluded).
  hdr <- grep(sprintf("^\\s*%s\\s+[–—-]\\s+%s\\s*$", month_rx, title), lines, perl = TRUE)
  if (!length(hdr)) return(NULL)
  blk <- lines[seq(hdr[1] + 1, min(length(lines), hdr[1] + 6))]
  n <- function(s) if (is.null(s) || is.na(s) || !nzchar(s)) NA_real_ else as.numeric(gsub("[^0-9.]", "", s))
  p <- function(s) if (is.null(s) || is.na(s) || !nzchar(s)) NA_real_ else as.numeric(sub("^\\+", "", s))
  row_rx <- paste0(
    "^\\s*(Active Listings|New Listings|Sales|Average Price|Dollar Volume)\\s+",
    "\\$?([0-9][0-9,]*)\\s+",                         # this month
    "([+-]?[0-9]+)%\\s*\\S?\\s*\\(\\$?([0-9][0-9,]*)\\)", # vs prior year (+ prior value)
    "(?:\\s+([+-]?[0-9]+)%\\s*\\S?\\s*\\(\\$?([0-9][0-9,]*)\\))?") # vs 5-yr avg (absent = N/A*)
  out <- list()
  for (ln in blk) {
    m <- regmatches(ln, regexec(row_rx, ln, perl = TRUE))[[1]]
    if (!length(m)) next
    key <- m[2]
    if (!is.null(out[[key]])) next
    out[[key]] <- list(value = n(m[3]), vsPriorYearPct = p(m[4]), priorYearValue = n(m[5]),
                       vs5yrAvgPct = p(m[6]), fiveYrAvg = n(m[7]))
  }
  if (length(out)) out else NULL
}

scrape_headline <- function() {
  if (!requireNamespace("pdftools", quietly = TRUE)) stop("pdftools not installed")
  ua <- add_headers(`User-Agent` = "Mozilla/5.0 (compatible; housing-economic-data/1.0)")
  base <- "https://www.winnipegregionalrealestatenews.com"
  # Latest release article from the listing page (newest first).
  listing <- paste0(base, "/market-statistics/market-releases")
  pg <- tryCatch(rvest::read_html(GET(listing, ua, timeout(45))), error = function(e) NULL)
  if (is.null(pg)) stop("listing page unreachable")
  hrefs <- rvest::html_attr(rvest::html_elements(pg, "a"), "href")
  art <- grep("/market-releases/article/", hrefs, value = TRUE)
  if (!length(art)) stop("no release article link found")
  url <- art[1]
  if (!grepl("^https?://", url)) url <- paste0(base, url)
  doc <- tryCatch(rvest::read_html(GET(url, ua, timeout(45))), error = function(e) NULL)
  if (is.null(doc)) stop("article unreachable")

  pdf_url <- wrreb_pdf_url(doc, base)
  if (is.na(pdf_url)) stop("no market-release PDF linked from the article")
  dest <- file.path(tempdir(), "wrreb_release.pdf")
  r <- tryCatch(GET(pdf_url, ua, timeout(60), write_disk(dest, overwrite = TRUE)), error = function(e) NULL)
  if (is.null(r) || status_code(r) != 200) stop(sprintf("release PDF download failed (%s)", pdf_url))
  txt <- tryCatch(suppressMessages(paste(pdftools::pdf_text(dest), collapse = "\n")), error = function(e) "")
  if (!nzchar(txt)) stop("release PDF had no text")
  lines <- strsplit(txt, "\n", fixed = TRUE)[[1]]

  # Release month = the month of the monthly "All MLS®" table title. Must be
  # within the last 14 months (guards against an old/pinned article).
  months <- "January|February|March|April|May|June|July|August|September|October|November|December"
  t_rx <- sprintf("^\\s*(%s)\\s+(20[0-9]{2})\\s+[–—-]\\s+All MLS", months)
  t <- regmatches(lines, regexec(t_rx, lines, perl = TRUE))
  t <- Filter(length, t)
  if (!length(t)) stop("no monthly 'All MLS' table in release PDF")
  as_of_date <- as.Date(paste(1, t[[1]][2], t[[1]][3]), format = "%d %B %Y")
  if (is.na(as_of_date) || as_of_date > today || as_of_date < seq(today, by = "-14 months", length.out = 2)[2])
    stop(sprintf("release month %s %s out of range", t[[1]][2], t[[1]][3]))
  as_of <- format(as_of_date, "%B %Y")
  month_rx <- paste(t[[1]][2], t[[1]][3])

  all_mls <- wrreb_table(lines, month_rx, "All MLS\\S*")
  det     <- wrreb_table(lines, month_rx, "All Residential Detached")
  att     <- wrreb_table(lines, month_rx, "All Residential Attached")
  condo   <- wrreb_table(lines, month_rx, "All Condominium")

  fields <- list(
    sales           = all_mls[["Sales"]],
    active_listings = all_mls[["Active Listings"]],
    sfd_avg_price   = det[["Average Price"]],
    sfa_avg_price   = att[["Average Price"]],
    condo_avg_price = condo[["Average Price"]]
  )
  # Sanity: a Winnipeg-region month is a few hundred to a few thousand sales;
  # average prices sit well inside $100k-$2M. Out-of-range = misparse -> drop.
  ok <- function(f, lo, hi) !is.null(f) && is.finite(f$value) && f$value >= lo && f$value <= hi
  if (!ok(fields$sales, 100, 20000))          fields$sales <- NULL
  if (!ok(fields$active_listings, 100, 50000)) fields$active_listings <- NULL
  for (k in c("sfd_avg_price", "sfa_avg_price", "condo_avg_price"))
    if (!ok(fields[[k]], 1e5, 2e6)) fields[k] <- list(NULL)
  got <- sum(!vapply(fields, is.null, logical(1)))
  if (got < 3) stop(sprintf("insufficient confident fields (as_of=%s, got=%d of 5)", as_of, got))

  prev <- read_json_safe(HEAD_PATH) %||% list()
  out <- prev
  out$`_comment` <- NULL   # old hand-entry note; the PDF scrape replaces it
  out$asOf    <- as_of
  out$source  <- paste0("Winnipeg Regional Real Estate Board (WRREB) — ", url)
  out$pdf     <- pdf_url
  out$fetched <- as.character(today)
  out$stale   <- FALSE
  for (k in names(fields)) {
    f <- fields[[k]]
    if (is.null(f)) next
    # NA comparison (e.g. "N/A*" 5-yr avg) -> drop the key rather than write null.
    out[[k]] <- Filter(function(v) !is.na(v), f)
  }
  # Fields kept from an earlier month would mix months: flag it.
  out$comparisonsStale <- got < length(fields)
  message(sprintf("[16] headline: %s from release PDF, %d/5 fields (sales %s, detached $%s, condo $%s)",
                  as_of, got, fields$sales$value %||% "-", fields$sfd_avg_price$value %||% "-",
                  fields$condo_avg_price$value %||% "-"))
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
