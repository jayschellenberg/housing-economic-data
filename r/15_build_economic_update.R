# =============================================================================
# r/15_build_economic_update.R
# Consolidate everything the MB Economic Update tab needs into one JSON:
#   - StatsCan economic indicators from data/statscan_indicators.csv
#     (retail / manufacturing / wholesale / farm cash / CPI / employment /
#      building permits / housing starts) — compute MoM / YoY / YTD deltas
#   (no CREA HPI or WRREB figures: those are internal-only, see r/16_scrape_mls.R
#    and r/16b_scrape_wrreb.R)
#   - Manual config (census intro, minimum wage, GDP, outlook prose)
# Output: web/public/data/economy/economic-update.json
# Depends on r/11 (statscan CSV) having run first.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

ECON_DIR <- file.path(WEB_DATA, "economy")
dir.create(ECON_DIR, recursive = TRUE, showWarnings = FALSE)
OUT_PATH <- file.path(ECON_DIR, "economic-update.json")

# --- StatsCan observations ---------------------------------------------------
stc_path <- file.path(DATA_DIR, "statscan_indicators.csv")
stc <- if (file.exists(stc_path)) read_csv(stc_path, show_col_types = FALSE) else tibble::tibble()

series_df <- function(id) {
  if (!nrow(stc)) return(NULL)
  d <- stc %>% filter(id == !!id, !is.na(value)) %>%
    mutate(date = as.Date(date)) %>% arrange(date)
  if (!nrow(d)) NULL else d
}
month_label <- function(d) format(as.Date(d), "%B %Y")
dir_of <- function(p) if (is.na(p)) NA_character_ else if (p > 0.05) "up" else if (p < -0.05) "down" else "flat"

# Month-over-month % change of the latest observation.
metric_mom <- function(id, comparison = "month-to-month, seasonally adjusted") {
  d <- series_df(id)
  if (is.null(d) || nrow(d) < 2) return(list(stale = TRUE))
  n <- nrow(d); cur <- d$value[n]; prev <- d$value[n - 1]
  chg <- if (is.finite(prev) && prev != 0) (cur / prev - 1) * 100 else NA_real_
  list(value = cur, changePct = round(chg, 1), direction = dir_of(chg),
       period = month_label(d$date[n]), comparison = comparison,
       source = "Statistics Canada", stale = FALSE)
}
# Year-over-year % change (lag = 12 for monthly).
metric_yoy <- function(id, comparison = "year-over-year") {
  d <- series_df(id)
  if (is.null(d) || nrow(d) < 13) return(list(stale = TRUE))
  n <- nrow(d); cur <- d$value[n]; prev <- d$value[n - 12]
  chg <- if (is.finite(prev) && prev != 0) (cur / prev - 1) * 100 else NA_real_
  list(value = cur, changePct = round(chg, 1), direction = dir_of(chg),
       period = month_label(d$date[n]), comparison = comparison,
       source = "Statistics Canada", stale = FALSE)
}
# Year-to-date change: sum(Jan..latest month this year) vs same span prior year.
metric_ytd <- function(id, source = "CMHC / Statistics Canada") {
  d <- series_df(id)
  if (is.null(d) || nrow(d) < 13) return(list(stale = TRUE))
  d$yr <- as.integer(format(d$date, "%Y")); d$mo <- as.integer(format(d$date, "%m"))
  last_yr <- max(d$yr); last_mo <- max(d$mo[d$yr == last_yr])
  ytd_now  <- sum(d$value[d$yr == last_yr      & d$mo <= last_mo], na.rm = TRUE)
  ytd_prev <- sum(d$value[d$yr == last_yr - 1L & d$mo <= last_mo], na.rm = TRUE)
  chg <- if (ytd_prev != 0) (ytd_now / ytd_prev - 1) * 100 else NA_real_
  list(value = ytd_now, ytdChangePct = round(chg, 1), direction = dir_of(chg),
       period = sprintf("year-to-date to %s", month_label(max(d$date[d$yr == last_yr]))),
       comparison = "year-to-date change", source = source, stale = FALSE)
}
# Annual YoY for farm cash (latest year vs prior year).
annual_change <- function(id) {
  d <- series_df(id)
  if (is.null(d) || nrow(d) < 2) return(NA_real_)
  n <- nrow(d)
  if (d$value[n - 1] == 0) NA_real_ else round((d$value[n] / d$value[n - 1] - 1) * 100, 1)
}

indicators <- list(
  retail_trade        = metric_mom("statscan.retail.manitoba"),
  manufacturing_sales = metric_mom("statscan.manufacturing.manitoba"),
  wholesale_trade     = metric_mom("statscan.wholesale.manitoba"),
  cpi                 = metric_yoy("statscan.cpi_allitems.manitoba"),
  employment          = metric_yoy("statscan.employment.manitoba"),
  weekly_earnings     = metric_yoy("statscan.weekly_earnings.manitoba")
)

# Unemployment rate: report the rate + its year-over-year change in PERCENTAGE
# POINTS (a rate, not a % change). Mirrors the MBS Economic Dashboard headline.
unemp <- series_df("statscan.unemployment.manitoba")
indicators$unemployment_rate <- if (is.null(unemp) || nrow(unemp) < 13) list(stale = TRUE) else {
  n <- nrow(unemp)
  list(value = unemp$value[n], changePP = round(unemp$value[n] - unemp$value[n - 12], 1),
       period = month_label(unemp$date[n]), comparison = "year-over-year",
       source = "Statistics Canada (Labour Force Survey)", stale = FALSE)
}

# Merchandise exports (MBS Industry/Trade headline) — YTD vs prior year.
indicators$exports <- metric_ytd("statscan.exports.manitoba",
                                 source = "Statistics Canada (international merchandise trade, table 12-10-0175)")

# Farm cash receipts (annual; total/crop/livestock).
fc_total <- series_df("statscan.farm_cash_total.manitoba")
indicators$farm_cash_receipts <- if (is.null(fc_total)) list(stale = TRUE) else list(
  period = format(max(fc_total$date), "%Y"),
  totalChangePct     = annual_change("statscan.farm_cash_total.manitoba"),
  cropChangePct      = annual_change("statscan.farm_cash_crop.manitoba"),
  livestockChangePct = annual_change("statscan.farm_cash_livestock.manitoba"),
  totalDirection = dir_of(annual_change("statscan.farm_cash_total.manitoba")),
  source = "Statistics Canada (table 32-10-0045)", stale = FALSE
)

housing <- list(
  starts           = metric_ytd("statscan.housing_starts.manitoba"),
  building_permits = metric_mom("statscan.permits.residential.manitoba")
)

# --- Charts (employment; the HPI benchmark chart is internal) -------------
emp <- series_df("statscan.employment.manitoba")
charts <- list()
if (!is.null(emp)) {
  cut <- as.Date(sprintf("%d-01-01", as.integer(format(Sys.Date(), "%Y")) - 6))
  e <- emp %>% filter(date >= cut)
  charts$employment <- list(
    series = list(list(id = "statscan.employment.manitoba", chartLabel = "Manitoba",
                       units = "persons_thousands", geo = "MB", frequency = "monthly",
                       latestDate = as.character(max(emp$date)), latestValue = emp$value[nrow(emp)])),
    records = e %>% transmute(id = "statscan.employment.manitoba",
                             date = as.character(date), value = value)
  )
}

# --- Residential real estate: none in this public file ----------------------
# Neither the WRREB market-release figures nor the CREA MLS(R) HPI benchmark go
# in here: WRREB's terms forbid publishing them and CREA needs prior written
# consent. r/16b and r/16 write them to AppMarketData-Internal on Jason's PC and
# the tab merges them in the browser (wrreb-store.js, crea-store.js).
read_json_safe <- function(p) if (file.exists(p)) tryCatch(jsonlite::read_json(p, simplifyVector = TRUE), error = function(e) NULL) else NULL

# --- Manual config (intro / minimum wage / GDP / outlook) -------------------
manual <- read_json_safe(file.path(ROOT, "r", "config", "economic_update_manual.json"))
if (is.null(manual)) { manual <- list(); message("[15] WARN: manual config not found") }

# Auto-add the latest StatsCan quarterly population estimate to the (otherwise
# static 2021-census) intro, so the population figure stays current without
# hand-entry. Quarterly ref dates land on Jan/Apr/Jul/Oct 1 -> label as quarter.
intro <- manual$intro
pop <- series_df("statscan.population.manitoba")
if (!is.null(intro) && !is.null(pop)) {
  pd <- max(pop$date); q <- (as.integer(format(pd, "%m")) - 1) %/% 3 + 1
  intro$currentPopEstimate <- pop$value[nrow(pop)]
  intro$currentPopAsOf <- sprintf("Q%d %s", q, format(pd, "%Y"))
}

if (!is.null(manual$minimumWage))
  indicators$minimum_wage <- c(manual$minimumWage, list(manual = TRUE))
if (!is.null(manual$realGdp))
  indicators$real_gdp <- c(manual$realGdp, list(manual = TRUE))

# --- Assemble + write --------------------------------------------------------
payload <- list(
  version   = 1,
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  dataAsOf  = as.character(Sys.Date()),
  intro     = intro,
  indicators = indicators,
  housing   = housing,
  outlook   = manual$outlook,
  charts    = charts
)

writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null", pretty = TRUE, digits = 6),
           OUT_PATH, useBytes = TRUE)

# Quick console summary.
fmtpc <- function(x) if (is.null(x) || is.na(x)) "—" else sprintf("%+.1f%%", x)
message(sprintf("[15] Wrote %s", OUT_PATH))
message(sprintf("[15]   retail MoM %s | mfg %s | wholesale %s | CPI YoY %s | emp YoY %s",
                fmtpc(indicators$retail_trade$changePct), fmtpc(indicators$manufacturing_sales$changePct),
                fmtpc(indicators$wholesale_trade$changePct), fmtpc(indicators$cpi$changePct),
                fmtpc(indicators$employment$changePct)))
message(sprintf("[15]   starts YTD %s | permits MoM %s | farm total %s",
                fmtpc(housing$starts$ytdChangePct), fmtpc(housing$building_permits$changePct),
                fmtpc(indicators$farm_cash_receipts$totalChangePct)))

