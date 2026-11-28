# =============================================================================
# r/16b_scrape_wrreb.R  (LOCAL ONLY: never run in GitHub Actions)
# Winnipeg Regional Real Estate Board (WRREB) monthly market-release figures
# for the MB Economic Update tab: sales, active listings, and detached /
# attached / condominium average prices, each with the prior-year and 5-year-
# average comparisons from the release PDF.
#
# Why local: WRREB's website terms allow private, non-commercial use only and
# forbid publishing the data in any form. The figures therefore never go into
# the public site. This script writes one small JSON to the firm's
# AppMarketData-Internal tier (staff and select people), and the site reads it
# in the browser through the Local Data strip (web/src/wrreb-store.js).
#
# Output (Dropbox root found from this file's location, never a drive letter):
#   <Dropbox>/SharedInfo/AppMarketData/AppMarketData-Internal/WRREBMarket/wrreb_market.json
# Override with `--out <path>`.
#
# Graceful degradation: the existing output file is the last-good cache. If
# the scrape fails, the last-good figures are kept with stale = true and the
# script exits 2 so the scheduled-task wrapper (scripts/wrreb_monthly.ps1)
# raises an alert. Exit 1 = setup problem (no AppMarketData folder, CI run).
# Runs monthly from the Windows task housing-economic-wrreb-monthly.
# =============================================================================

if (identical(Sys.getenv("GITHUB_ACTIONS"), "true") || nzchar(Sys.getenv("CI"))) {
  message("[16b] refusing to run in CI: WRREB figures are internal-only (see file header)")
  quit(status = 1)
}

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else normalizePath("r", winslash = "/")
}
suppressPackageStartupMessages({
  for (p in c("httr", "rvest", "pdftools", "jsonlite"))
    if (!requireNamespace(p, quietly = TRUE)) install.packages(p, repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

# r/ -> housing-economic-data/ -> ClaudeCode/ -> Dropbox root
DROPBOX  <- dirname(dirname(dirname(.this_dir)))
AMD      <- file.path(DROPBOX, "SharedInfo", "AppMarketData")
DEFAULT_OUT <- file.path(AMD, "AppMarketData-Internal", "WRREBMarket", "wrreb_market.json")

cli <- commandArgs(trailingOnly = TRUE)
oi  <- match("--out", cli)
OUT_PATH <- if (!is.na(oi) && oi < length(cli)) cli[oi + 1] else DEFAULT_OUT
if (identical(OUT_PATH, DEFAULT_OUT) && !dir.exists(AMD)) {
  # Never invent the tier tree somewhere else (a different Dropbox layout).
  message(sprintf("[16b] %s not found: is this the Dropbox ClaudeCode tree? Use --out to write elsewhere.", AMD))
  quit(status = 1)
}
dir.create(dirname(OUT_PATH), recursive = TRUE, showWarnings = FALSE)
today <- Sys.Date()

read_json_safe <- function(p) if (file.exists(p)) tryCatch(jsonlite::read_json(p, simplifyVector = TRUE), error = function(e) NULL) else NULL
write_json <- function(obj, p) writeLines(jsonlite::toJSON(obj, auto_unbox = TRUE, na = "null", pretty = TRUE, digits = 6), p, useBytes = TRUE)

# -----------------------------------------------------------------------------
# WRREB publishes a monthly release (URL + slug change every month). Since the
# 2026-09 release the web prose carries only percentages ("up 3% from 2025");
# the figures live in the attached "<Month> <Year> Market Release.pdf", whose
# tables give every value we need plus prior-year and 5-year-average columns:
#
#   March 2020 - All Residential Detached      (layout only; made-up numbers)
#                    March 2020        vs. 2019            vs. 5-Year Average
#   Active Listings     2,000      +10% ▲  (1,818)      +5% ▲   (1,905)
#   Sales                 500       -5% ▼    (526)      +2% ▲     (490)
#   Average Price    $400,000       +4% ▲ ($384,615)    +7% ▲ ($373,832)
#
# We read the monthly (non-YTD) region-wide tables: All MLS® (sales, active
# listings), All Residential Detached / Attached / Condominium (average price).
# Anything not parsed keeps its last-good sub-object; if the month or fewer
# than 3 of the 5 headline fields parse we stop() -> last-good, stale = TRUE.
# -----------------------------------------------------------------------------
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
# block's title remainder (after "<Month> <Year> - "). Returns a named list of
# rows, each list(value, vsPriorYearPct, priorYearValue, vs5yrAvgPct, fiveYrAvg).
wrreb_table <- function(lines, month_rx, title) {
  # Title must be the WHOLE line (so "All Residential Detached - Winnipeg" and
  # "YTD October 2026 - All ..." are excluded).
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

scrape_headline <- function(prev) {
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

  out <- prev %||% list()
  out$kind    <- "wrreb-market-release"
  out$version <- 1
  out$asOf    <- as_of
  out$source  <- paste0("Winnipeg Regional Real Estate Board (WRREB), ", url)
  out$pdf     <- pdf_url
  out$fetched <- as.character(today)
  out$stale   <- FALSE
  out$internalOnly <- TRUE
  for (k in names(fields)) {
    f <- fields[[k]]
    if (is.null(f)) next
    # NA comparison (e.g. "N/A*" 5-yr avg) -> drop the key rather than write null.
    out[[k]] <- Filter(function(v) !is.na(v), f)
  }
  # Fields kept from an earlier month would mix months: flag it.
  out$comparisonsStale <- got < length(fields)
  message(sprintf("[16b] %s from release PDF, %d/5 fields (sales %s, detached $%s, condo $%s)",
                  as_of, got, fields$sales$value %||% "-", fields$sfd_avg_price$value %||% "-",
                  fields$condo_avg_price$value %||% "-"))
  out
}

prev <- read_json_safe(OUT_PATH)
failed <- FALSE
out <- tryCatch(scrape_headline(prev), error = function(e) {
  message("[16b] WRREB scrape FAILED: ", conditionMessage(e), " - keeping last-good (stale)")
  failed <<- TRUE
  if (!is.null(prev)) { prev$stale <- TRUE; prev } else NULL
})
if (!is.null(out)) {
  write_json(out, OUT_PATH)
  message(sprintf("[16b] -> %s (asOf %s, stale=%s)", OUT_PATH, out$asOf %||% "?", out$stale %||% TRUE))
} else {
  message("[16b] no WRREB data and no last-good file")
}
if (failed) quit(status = 2)
message("[16b] done.")
