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
# WRREB publishes these only as a monthly prose news release (URL + slug change
# every month) and the CREA board page is JS-rendered, so a robust unattended
# parse is not guaranteed. We attempt a light fetch; if we cannot CONFIDENTLY
# extract a full, sane figure set we keep the committed last-good values and
# leave stale=TRUE. (Seeded cache already holds the most recent known release.)
scrape_headline <- function() {
  ua <- add_headers(`User-Agent` = "Mozilla/5.0 (compatible; housing-economic-data/1.0)")
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

  # Release month, e.g. "August 2026". The article page also carries WRREB's
  # release archive back to 2010, so the FIRST "Month YYYY" on the page is not
  # the release month (from 2026-08-24 it was "May 2014", written out as
  # current with stale=FALSE). Take every match, keep those within the last 14
  # months, use the latest; none -> not confident -> keep last-good.
  mons <- regmatches(txt, gregexpr("(January|February|March|April|May|June|July|August|September|October|November|December)\\s+20[0-9]{2}", txt))[[1]]
  mdates <- as.Date(paste("1", mons), format = "%d %B %Y")
  recent <- !is.na(mdates) & mdates <= today & mdates >= seq(today, by = "-14 months", length.out = 2)[2]
  as_of <- if (any(recent)) format(max(mdates[recent]), "%B %Y") else NA_character_

  # Match figures only in sentences that are NOT year-to-date. The release
  # leads with YTD averages in the same wording as the monthly ones
  # ("year-to-date (YTD) residential detached average price of $468,679"), and
  # the 2026-08/09 runs stored those YTD prices as the month's headline.
  sentences <- strsplit(txt, "(?<=[.!?])\\s+", perl = TRUE)[[1]]
  txt_monthly <- paste(sentences[!grepl("YTD|year[- ]to[- ]date", sentences, ignore.case = TRUE)], collapse = " ")
  num <- function(pattern) {
    # A pattern the runner's PCRE2 rejects must cost one field, not the whole
    # parse (an invalid regex used to abort every field -> last-good, stale).
    hit <- tryCatch(regexpr(pattern, txt_monthly, perl = TRUE), error = function(e) {
      message(sprintf("[16] headline pattern rejected (%s): %s", conditionMessage(e), pattern))
      NULL
    })
    if (is.null(hit)) return(NA_real_)
    m <- regmatches(txt_monthly, hit)
    if (!length(m)) return(NA_real_)
    as.numeric(gsub("[^0-9.]", "", m[1]))
  }
  # These patterns are intentionally conservative; if the release wording drifts
  # they return NA and we fall back to last-good. (\x{00ae} = the ® glyph;
  # R's PCRE2 rejects the \u escape, so use the \x{...} form.)
  # WRREB's 2026 wording is "All MLS® sales of 1,326 were down 5% ..." (the ®
  # may carry a footnote digit: "MLS®1"); the older "1,326 MLS® sales" shape is
  # kept as the fallback. The optional digit makes the prefix variable-length,
  # which a lookbehind can't hold on the runner's older PCRE2 (it only worked
  # locally on 10.47) -- so match the prefix and drop it with \K instead.
  sales  <- num("All MLS\\x{00ae}[0-9]? sales of \\K[0-9,]+")
  if (is.na(sales)) sales <- num("[0-9,]+(?=\\s+MLS\\x{00ae} sales)")
  sfd    <- num("(?<=residential[- ]detached average price of \\$)[0-9,]+")
  condo  <- num("(?<=condominium average price of \\$)[0-9,]+")

  # "<Month> 2026 MLS® sales ..." matches the year as the count (every run from
  # 2026-08-10 wrote sales = 2026). A Winnipeg month is a few hundred to a few
  # thousand sales; reject anything that equals a nearby year or is out of range.
  yrs <- as.numeric(format(today, "%Y")) + (-1:0)
  if (!is.na(sales) && (sales %in% yrs || sales < 100 || sales > 20000)) sales <- NA_real_
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
