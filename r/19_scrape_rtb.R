# =============================================================================
# r/19_scrape_rtb.R
# Manitoba Residential Tenancies Branch (RTB) rent-control data for the
# "RTB (MB)" tab. Writes web/public/data/economy/rtb_mb.json with:
#   - current  : the current annual rent-increase guideline (value, effective
#                date, economic adjustment factor, the $/mo exemption threshold)
#                scraped live from the RTB "current guideline" page.
#   - history  : the full year-by-year guideline series (seeded 1982-2026 from
#                the RTB "Rent Increases" history sheet; the live current-year
#                value is merged in so the series stays current as new guidelines
#                are published each year — no PDF parsing, so it runs anywhere).
#   - cpi      : Manitoba All-items CPI annual % change (the series the guideline
#                is derived from), best-effort via cansim; the overlay simply
#                drops out if StatsCan is unreachable.
#
# Monthly (the guideline is annual but announced ~Aug of the prior year, so a
# monthly scrape catches it within weeks). Part of the data:all pipeline; needs
# no API key. When the current guideline year/value changes vs the committed
# file, writes data/rtb_new_guideline.txt so CI can raise an alert.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, DATA_DIR, WEB_DATA, jsonlite, dplyr
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

GUIDELINE_URL <- "https://www.gov.mb.ca/cca/rtb/rentincreaseguideline/currentrentguideline.html"
RTB_URL       <- "https://www.gov.mb.ca/cca/rtb/"
HISTORY_URL   <- "https://www.manitoba.ca/cca/rtb/resource_list/rentincreases.pdf"
CALCULATE_URL <- "https://www.gov.mb.ca/cca/rtb/rentincreaseguideline/calculate.html"
ACT_URL       <- "https://web2.gov.mb.ca/laws/regs/current/156-92.php?lang=en"

# Year-by-year guideline history (per cent), seeded from the RTB "Rent Increases"
# sheet (resource_list/rentincreases.pdf) + the 2024-2026 news releases. Old years
# are fixed; the live scrape below merges the current year so the series advances
# as each new guideline is published.
HISTORY_SEED <- list(
  `2026` = 1.8, `2025` = 1.7, `2024` = 3.0, `2023` = 0.0, `2022` = 0.0, `2021` = 1.6,
  `2020` = 2.4, `2019` = 2.2, `2018` = 1.3, `2017` = 1.5, `2016` = 1.1, `2015` = 2.4,
  `2014` = 2.0, `2013` = 1.0, `2012` = 1.0, `2011` = 1.5, `2010` = 1.0, `2009` = 2.5,
  `2008` = 2.0, `2007` = 2.5, `2006` = 2.5, `2005` = 1.5, `2004` = 1.5, `2003` = 1.0,
  `2002` = 2.0, `2001` = 1.5, `2000` = 1.0, `1999` = 1.0, `1998` = 1.0, `1997` = 1.0,
  `1996` = 1.0, `1995` = 1.0, `1994` = 1.0, `1993` = 1.0, `1992` = 3.0, `1991` = 4.0,
  `1990` = 3.0, `1989` = 3.0, `1988` = 3.0, `1987` = 3.0, `1986` = 3.0, `1985` = 4.5,
  `1984` = 6.0, `1983` = 8.0, `1982` = 9.0)

# Economic adjustment factor (per cent) by year — a SEPARATE figure the RTB
# publishes on the guideline page (used for above-guideline applications; NOT part
# of the guideline's CPI formula). First published for 2024, so 2023 and earlier
# have none (rendered "**"). Seeded from the RTB guideline pages (2024 via the
# Internet Archive); the live current-year value is merged in from the scrape so
# it advances as each year is published.
EAF_SEED <- list(`2026` = 1.1, `2025` = 1.1, `2024` = 1.9)

MONTHS <- c(January=1, February=2, March=3, April=4, May=5, June=6, July=7,
            August=8, September=9, October=10, November=11, December=12)

OUT_DIR  <- file.path(WEB_DATA, "economy"); dir.create(OUT_DIR, showWarnings = FALSE, recursive = TRUE)
OUT_PATH <- file.path(OUT_DIR, "rtb_mb.json")
FLAG_PATH <- file.path(DATA_DIR, "rtb_new_guideline.txt")

# --- 1. Scrape the current guideline page ------------------------------------
# Strip tags to plain text and regex the published sentence forms. Graceful:
# on any failure we fall back to the previously committed `current` so a bad
# fetch never blanks the tab.
scrape_current <- function() {
  txt <- tryCatch({
    r <- GET(GUIDELINE_URL, user_agent("housing-economic-data/rtb"), timeout(60))
    stop_for_status(r)
    h <- content(r, as = "text", encoding = "UTF-8")
    h <- gsub("<[^>]+>", " ", h)            # drop tags
    h <- gsub("&nbsp;", " ", h, fixed = TRUE)
    h <- gsub("&#36;", "$", h, fixed = TRUE)
    gsub("[ \t\r\n]+", " ", h)
  }, error = function(e) { message("[19] current-page fetch failed: ", conditionMessage(e)); NA_character_ })
  if (is.na(txt)) return(NULL)

  num <- function(pat) { m <- regmatches(txt, regexec(pat, txt, perl = TRUE))[[1]]; if (length(m) >= 2) m[2] else NA_character_ }
  year  <- num("(?:guideline (?:set )?for|guideline for)\\s+(\\d{4})")
  pct   <- num("rent increase guideline (?:for \\d{4} )?is\\s+([0-9]+(?:\\.[0-9]+)?)\\s*per cent")
  if (is.na(pct)) pct <- num("guideline is\\s+([0-9]+(?:\\.[0-9]+)?)\\s*per cent")
  eff   <- regmatches(txt, regexec("effective\\s+([A-Z][a-z]+)\\s+(\\d{1,2}),\\s+(\\d{4})", txt, perl = TRUE))[[1]]
  eaf   <- num("economic adjustment factor for \\d{4} is\\s+([0-9]+(?:\\.[0-9]+)?)\\s*per cent")
  thr   <- num("\\$([0-9,]+)\\s+or more per month")

  eff_date <- if (length(eff) >= 4 && !is.na(MONTHS[[eff[2]]] %||% NA))
    sprintf("%s-%02d-%02d", eff[4], MONTHS[[eff[2]]], as.integer(eff[3])) else NA_character_
  if (is.na(year) && length(eff) >= 4) year <- eff[4]

  if (is.na(year) || is.na(pct)) { message("[19] could not parse year/pct from current page"); return(NULL) }
  list(
    year = as.integer(year),
    guidelinePct = as.numeric(pct),
    effectiveDate = eff_date,
    economicAdjustmentFactorPct = if (is.na(eaf)) NA else as.numeric(eaf),
    exemptionThreshold = if (is.na(thr)) NA else as.numeric(gsub(",", "", thr))
  )
}

prev <- if (file.exists(OUT_PATH)) tryCatch(jsonlite::read_json(OUT_PATH), error = function(e) NULL) else NULL
cur  <- scrape_current()
if (is.null(cur)) {
  cur <- prev$current %||% NULL
  if (is.null(cur)) {
    # First run with no network: synthesise from the seed's newest year.
    yr <- max(as.integer(names(HISTORY_SEED)))
    cur <- list(year = yr, guidelinePct = HISTORY_SEED[[as.character(yr)]],
                effectiveDate = sprintf("%d-01-01", yr),
                economicAdjustmentFactorPct = NA, exemptionThreshold = NA)
    message("[19] using seed for current (no network + no prior file)")
  } else message("[19] kept previously committed current guideline")
} else {
  message(sprintf("[19] current: %d guideline = %.1f%%%s (EAF %s, exempt >= $%s)",
                  cur$year, cur$guidelinePct,
                  if (!is.na(cur$effectiveDate %||% NA)) paste0(", eff ", cur$effectiveDate) else "",
                  cur$economicAdjustmentFactorPct %||% "?", cur$exemptionThreshold %||% "?"))
}

# --- 2. History = seed + the live current value (guideline + EAF per year) ----
hist <- HISTORY_SEED
hist[[as.character(cur$year)]] <- cur$guidelinePct
eaf_map <- EAF_SEED
if (!is.na(cur$economicAdjustmentFactorPct %||% NA))
  eaf_map[[as.character(cur$year)]] <- cur$economicAdjustmentFactorPct   # advance with the live page
history <- lapply(sort(as.integer(names(hist)), decreasing = TRUE),
                  function(y) list(year = y, pct = hist[[as.character(y)]],
                                   eaf = eaf_map[[as.character(y)]] %||% NA))

# --- 3. CPI change UNDERLYING each guideline (best-effort) --------------------
# The guideline for year N is set from the change in the average All-items CPI
# (Manitoba, NSA) over the 12 months ending June 30 of year N-1 vs the preceding
# 12 months (per the RTB "calculate" page), then rounded and capped to the Bank
# of Canada 1-3% band. So we key CPI by GUIDELINE year (not calendar year) using
# exactly that window — aligned to the guideline it produced, reproducing it where
# the cap/freezes don't override. **v41692055 = MB All-items** (table 18-10-0004);
# the earlier v41691233 was the WRONG series (Canada, all-items ex food+energy).
cpi <- tryCatch({
  if (!requireNamespace("cansim", quietly = TRUE)) install.packages("cansim", repos = "https://cloud.r-project.org")
  d <- as.data.frame(cansim::get_cansim_vector(41692055))
  val <- suppressWarnings(as.numeric(d$val_norm)); if (all(is.na(val))) val <- suppressWarnings(as.numeric(d$VALUE))
  ym  <- as.character(d$REF_DATE)
  key <- as.integer(substr(ym, 1, 4)) * 100 + as.integer(substr(ym, 6, 7))   # YYYYMM
  if (sum(is.finite(val)) < 24 || max(val, na.rm = TRUE) < 80 || max(val, na.rm = TRUE) > 400)
    stop("CPI vector failed sanity check")
  cpival <- function(y, m) { i <- which(key == y * 100 + m); if (length(i)) val[i[1]] else NA_real_ }
  jul_jun <- function(endYear) {     # mean of the 12 monthly CPI ending June 30, endYear
    ms <- c(vapply(7:12, function(m) cpival(endYear - 1, m), numeric(1)),
            vapply(1:6,  function(m) cpival(endYear,     m), numeric(1)))
    if (any(is.na(ms))) NA_real_ else mean(ms)
  }
  out <- list()
  for (N in sort(as.integer(names(HISTORY_SEED)), decreasing = TRUE)) {
    A <- jul_jun(N - 1); B <- jul_jun(N - 2)          # guideline N uses the window ending Jun N-1
    if (is.na(A) || is.na(B)) next
    out[[length(out) + 1]] <- list(year = N, changePct = round((A / B - 1) * 100, 1))
  }
  message(sprintf("[19] MB All-items CPI basis: %d guideline-years computed (latest %s = %.1f%%)",
                  length(out), out[[1]]$year, out[[1]]$changePct))
  out
}, error = function(e) { message("[19] CPI basis unavailable: ", conditionMessage(e)); list() })

# --- 4. New-guideline alert flag ---------------------------------------------
if (file.exists(FLAG_PATH)) file.remove(FLAG_PATH)
prev_cur <- prev$current
changed <- is.null(prev_cur) ||
  !identical(as.integer(prev_cur$year %||% -1), cur$year) ||
  !isTRUE(all.equal(as.numeric(prev_cur$guidelinePct %||% -1), cur$guidelinePct))
if (changed && !is.null(prev_cur)) {
  msg <- sprintf("New Manitoba RTB rent increase guideline: %.1f%% for %d (was %.1f%% for %d), effective %s.",
                 cur$guidelinePct, cur$year,
                 as.numeric(prev_cur$guidelinePct %||% NA), as.integer(prev_cur$year %||% NA),
                 cur$effectiveDate %||% "?")
  writeLines(msg, FLAG_PATH)
  message("[19] NEW GUIDELINE DETECTED -> ", FLAG_PATH)
}

# --- 5. Write JSON -----------------------------------------------------------
payload <- list(
  source       = "Manitoba Residential Tenancies Branch",
  sourceUrl    = RTB_URL,
  guidelineUrl = GUIDELINE_URL,
  historyUrl   = HISTORY_URL,
  calculateUrl = CALCULATE_URL,
  actUrl       = ACT_URL,
  scrapedAt    = format(Sys.Date()),
  current      = cur,
  history      = history,
  cpi          = cpi
)
writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null", digits = 4), OUT_PATH, useBytes = TRUE)
message(sprintf("[19] Wrote %s (current %d = %.1f%%, %d history yrs, %d cpi yrs)",
                OUT_PATH, cur$year, cur$guidelinePct, length(history), length(cpi)))
