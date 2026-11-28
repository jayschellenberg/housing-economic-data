# =============================================================================
# r/28b_scrape_market_returns.R  (LOCAL ONLY: never run in GitHub Actions)
# Equity and bond total-return series for the Market Discount Rates tab's
# growth-of-$100 chart and narrative:
#   xic  S&P/TSX total return  -- iShares Core S&P/TSX Capped Composite ETF
#        (XIC.TO), Yahoo Finance adjusted close (distributions reinvested), daily
#   zfl  Govt bonds (10yr+) TR -- BMO Long Federal Bond Index ETF (ZFL.TO),
#        Yahoo Finance adjusted close, daily
#
# Why local: Yahoo grants no licence to republish its prices (its terms cover
# personal, non-commercial use, and the prices are exchange data it licenses),
# so the public site ships none of them. This writes to AppMarketData-Internal
# and the tab merges the series in the browser through the Local Data strip
# (web/src/market-returns-store.js). The CPI line and GIC rates stay public
# (r/28_scrape_investment_context.R).
#
# A failed fetch keeps that series' last-good values with stale = TRUE and
# exits 2, so the scheduled-task wrapper (scripts/wrreb_monthly.ps1) raises an
# alert. Exit 1 = setup problem (no AppMarketData folder, CI run).
# Output (--out overrides):
#   <Dropbox>/SharedInfo/AppMarketData/AppMarketData-Internal/MarketReturns/market_returns.json
# =============================================================================

if (identical(Sys.getenv("GITHUB_ACTIONS"), "true") || nzchar(Sys.getenv("CI"))) {
  message("[28b] refusing to run in CI: Yahoo Finance prices are internal-only (see file header)")
  quit(status = 1)
}

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else normalizePath("r", winslash = "/")
}
suppressPackageStartupMessages({
  for (p in c("httr", "jsonlite"))
    if (!requireNamespace(p, quietly = TRUE)) install.packages(p, repos = "https://cloud.r-project.org")
  library(httr)
  library(jsonlite)
})
`%||%` <- function(a, b) if (is.null(a)) b else a

# r/ -> housing-economic-data/ -> ClaudeCode/ -> Dropbox root
DROPBOX <- dirname(dirname(dirname(.this_dir)))
AMD     <- file.path(DROPBOX, "SharedInfo", "AppMarketData")
DEFAULT_OUT <- file.path(AMD, "AppMarketData-Internal", "MarketReturns", "market_returns.json")
cli <- commandArgs(trailingOnly = TRUE)
oi  <- match("--out", cli)
OUT <- if (!is.na(oi) && oi < length(cli)) cli[oi + 1] else DEFAULT_OUT
if (identical(OUT, DEFAULT_OUT) && !dir.exists(AMD)) {
  # Never invent the tier tree somewhere else (a different Dropbox layout).
  message(sprintf("[28b] %s not found: is this the Dropbox ClaudeCode tree? Use --out to write elsewhere.", AMD))
  quit(status = 1)
}
dir.create(dirname(OUT), recursive = TRUE, showWarnings = FALSE)

FROM  <- as.Date("2006-01-01")
UA    <- "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
TODAY <- format(Sys.Date())

prev <- if (file.exists(OUT)) tryCatch(fromJSON(OUT, simplifyVector = FALSE), error = function(e) NULL) else NULL
prev_series <- function(id) {
  for (x in prev$series %||% list()) if (identical(x$id, id)) return(x)
  NULL
}
any_stale <- FALSE

yahoo_series <- function(id, symbol, label, note) {
  url <- sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s", symbol)
  res <- tryCatch({
    r <- GET(url, user_agent(UA), timeout(60), query = list(
      period1 = as.integer(as.POSIXct(FROM, tz = "UTC")),
      period2 = as.integer(Sys.time()) + 86400L,
      interval = "1d", events = "div,split"))
    stop_for_status(r)
    j <- fromJSON(content(r, "text", encoding = "UTF-8"), simplifyVector = TRUE)
    out <- j$chart$result
    ts  <- out$timestamp[[1]]
    adj <- out$indicators$adjclose[[1]]$adjclose[[1]]
    tz  <- out$meta$exchangeTimezoneName %||% "America/Toronto"
    d <- data.frame(date = format(as.POSIXct(ts, origin = "1970-01-01", tz = tz), "%Y-%m-%d"),
                    value = as.numeric(adj))
    d <- d[is.finite(d$value), ]
    d <- d[!duplicated(d$date, fromLast = TRUE), ]
    if (nrow(d) < 250) stop("only ", nrow(d), " observations")
    d
  }, error = function(e) { message(sprintf("[28b] %s fetch failed (%s) -- keeping last-good", symbol, conditionMessage(e))); NULL })
  if (is.null(res)) {
    any_stale <<- TRUE
    old <- prev_series(id)
    if (!is.null(old)) old$stale <- TRUE
    return(old)
  }
  message(sprintf("[28b] %s: %d days, %s to %s", symbol, nrow(res), res$date[1], res$date[nrow(res)]))
  list(id = id, label = label, symbol = symbol, note = note, frequency = "daily",
       dates = res$date, values = round(res$value, 4))
}

series <- Filter(Negate(is.null), list(
  yahoo_series("xic", "XIC.TO", "S&P/TSX Total Return",
               "iShares Core S&P/TSX Capped Composite Index ETF (XIC), adjusted close with distributions reinvested"),
  yahoo_series("zfl", "ZFL.TO", "Govt Bonds (10yr+) TR",
               "BMO Long Federal Bond Index ETF (ZFL), adjusted close with distributions reinvested")))

if (!length(series)) {
  message("[28b] no series fetched and no last-good file -- nothing written")
  quit(status = 2)
}

out <- list(kind = "market-returns", version = 1, built = TODAY, stale = any_stale,
            source = "Yahoo Finance (adjusted close)", series = series)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, null = "null", na = "null"), OUT, useBytes = TRUE)
message(sprintf("[28b] wrote %s (%s KB, stale=%s)", OUT, round(file.size(OUT) / 1024), any_stale))
if (any_stale) quit(status = 2)
