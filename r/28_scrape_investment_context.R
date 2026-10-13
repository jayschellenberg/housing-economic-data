# =============================================================================
# r/28_scrape_investment_context.R
# Discount-rate context for the Market Discount Rates tab. Writes
# web/public/data/economy/investment_context.json with:
#   - series : growth-of-$100 inputs, each { id, label, dates[], values[] }
#       xic  S&P/TSX total return  — iShares Core S&P/TSX Capped Composite
#            ETF (XIC.TO), Yahoo adjusted close (dividends reinvested), daily
#       zfl  Govt bonds (10yr+) TR — BMO Long Federal Bond Index ETF (ZFL.TO),
#            Yahoo adjusted close, daily
#       cpi  Canada All-items CPI (2002=100), StatsCan 18-10-0004 v41690973, monthly
#   - gic    : current 5-year GIC rates, { id, institution, product, rate,
#              updated (the page's "last updated" date), checked, url }
#       scu  Steinbach Credit Union, 60-month GIC, $250K and over
#       acu  Access Credit Union, 60-month GIC (annual interest; one tier)
#
# Replaces the Yahoo/cansim fetch in the "$ Investment Return Charts" Quarto
# project (which used VCN.TO and XGB.TO; XIC and ZFL match the labels).
# Weekly, in refresh-indicators.yml. Each part is independent: one that
# fails keeps its last-good values from the committed file and logs
# "keeping last-good", which the refresh email lists as a soft failure.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, WEB_DATA, jsonlite, dplyr
suppressPackageStartupMessages({
  library(httr)
  library(jsonlite)
})

OUT  <- file.path(WEB_DATA, "economy", "investment_context.json")
FROM <- as.Date("2006-01-01")
UA   <- "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
TODAY <- format(Sys.Date())

prev <- if (file.exists(OUT)) tryCatch(fromJSON(OUT, simplifyVector = FALSE), error = function(e) NULL) else NULL
prev_part <- function(kind, id) {
  for (x in prev[[kind]] %||% list()) if (identical(x$id, id)) return(x)
  NULL
}
`%||%` <- function(a, b) if (is.null(a)) b else a

# --- Yahoo adjusted closes ---------------------------------------------------

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
  }, error = function(e) { message(sprintf("[investment] %s fetch failed (%s) — keeping last-good", symbol, conditionMessage(e))); NULL })
  if (is.null(res)) return(prev_part("series", id))
  message(sprintf("[investment] %s: %d days, %s to %s", symbol, nrow(res), res$date[1], res$date[nrow(res)]))
  list(id = id, label = label, symbol = symbol, note = note, frequency = "daily",
       dates = res$date, values = round(res$value, 4))
}

# --- CPI ---------------------------------------------------------------------

cpi_series <- function() {
  res <- tryCatch({
    v <- cansim::get_cansim_vector("v41690973", start_time = FROM)
    d <- data.frame(date = paste0(substr(as.character(v$REF_DATE), 1, 7), "-01"), value = as.numeric(v$VALUE))
    d <- d[is.finite(d$value), ]
    d <- d[order(d$date), ]
    if (nrow(d) < 60) stop("only ", nrow(d), " months")
    d
  }, error = function(e) { message(sprintf("[investment] CPI v41690973 fetch failed (%s) — keeping last-good", conditionMessage(e))); NULL })
  if (is.null(res)) return(prev_part("series", "cpi"))
  message(sprintf("[investment] CPI: %d months to %s", nrow(res), res$date[nrow(res)]))
  list(id = "cpi", label = "Inflation (CPI)", vector = "v41690973",
       note = "Statistics Canada Table 18-10-0004-01, Consumer Price Index, Canada, All-items (2002=100)",
       frequency = "monthly", dates = res$date, values = res$value)
}

# --- GIC rates ---------------------------------------------------------------

page_text <- function(url) {
  r <- GET(url, user_agent(UA), timeout(60))
  stop_for_status(r)
  s <- content(r, "text", encoding = "UTF-8")
  s <- gsub("(?s)<script.*?</script>|<style.*?</style>", " ", s, perl = TRUE)
  s <- gsub("<[^>]+>", " | ", s)
  s <- xml2::xml_text(xml2::read_html(paste0("<p>", gsub("&(?![a-zA-Z#0-9]+;)", "&amp;", s, perl = TRUE), "</p>")))
  gsub("(\\s*\\|\\s*)+", " | ", s)
}
month_date <- function(x) {
  d <- as.Date(x, format = "%B %d, %Y")
  if (is.na(d)) NA_character_ else format(d)
}

gic_rate <- function(id, institution, product, url, rate_re, updated_re) {
  res <- tryCatch({
    t <- page_text(url)
    m <- regmatches(t, regexec(rate_re, t, perl = TRUE))[[1]]
    if (length(m) < 2) stop("rate not found on the page")
    rate <- as.numeric(m[2])
    if (!is.finite(rate) || rate <= 0 || rate > 15) stop("implausible rate ", m[2])
    u <- regmatches(t, regexec(updated_re, t, perl = TRUE))[[1]]
    list(id = id, institution = institution, product = product, rate = rate,
         updated = if (length(u) >= 2) month_date(u[2]) else NA_character_,
         checked = TODAY, url = url)
  }, error = function(e) { message(sprintf("[investment] %s GIC scrape failed (%s) — keeping last-good", institution, conditionMessage(e))); NULL })
  if (is.null(res)) {
    old <- prev_part("gic", id)
    if (!is.null(old)) old$stale <- TRUE
    return(old)
  }
  message(sprintf("[investment] %s %s: %.2f%% (updated %s)", institution, product, res$rate, res$updated))
  res
}

series <- Filter(Negate(is.null), list(
  yahoo_series("xic", "XIC.TO", "S&P/TSX Total Return",
               "iShares Core S&P/TSX Capped Composite Index ETF (XIC), adjusted close with distributions reinvested"),
  yahoo_series("zfl", "ZFL.TO", "Govt Bonds (10yr+) TR",
               "BMO Long Federal Bond Index ETF (ZFL), adjusted close with distributions reinvested"),
  cpi_series()))

gic <- Filter(Negate(is.null), list(
  gic_rate("scu", "Steinbach Credit Union", "5-year GIC (deposits of $250,000 and over)",
           "https://scu.mb.ca/rates/gics",
           "60-month \\| .*?\\$250K\\** and over \\| ([0-9.]+)%",
           "GIC rates last updated ([A-Z][a-z]+ [0-9]{1,2}, [0-9]{4})"),
  gic_rate("acu", "Access Credit Union", "5-year GIC",
           "https://www.accesscu.ca/en/rates",
           "GIC 60 Months \\| ([0-9.]+)%",
           "Deposit Accounts \\| .*?last updated ([A-Z][a-z]+ [0-9]{1,2}, [0-9]{4})")))

if (!length(series)) stop("[investment] no series fetched and no last-good file — nothing to write")

out <- list(built = TODAY, series = series, gic = gic)
dir.create(dirname(OUT), showWarnings = FALSE, recursive = TRUE)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, null = "null", na = "null"), OUT, useBytes = TRUE)
message(sprintf("[investment] wrote %s (%s KB)", OUT, round(file.size(OUT) / 1024)))
