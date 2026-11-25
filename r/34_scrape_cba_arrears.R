# =============================================================================
# r/34_scrape_cba_arrears.R
# Pull every catalog entry with provider="cba_arrears" from the Canadian
# Bankers Association's monthly "Number of Residential Mortgages in Arrears"
# workbook and write data/cba_arrears.csv in the same long form as the other
# indicator scrapers (id, seriesId, date, value, units, geo, frequency,
# transform).
#
# Why: CMHC's quarterly Equifax delinquency table (r/22) can sit two or more
# quarters behind (Q4 2025 was still its latest in Nov 2026). The CBA file is
# monthly with a ~2-month lag and has a Manitoba sheet. It measures something
# narrower (CBA-member banks only, 3+ months in arrears) so it is charted as
# its own lines, never spliced into the CMHC series.
#
# File naming is fixed: stat-mortgages-arrears-{month}-{yyyy}-en.xlsx, one
# file per month (each holds the full history from 1995). We try the current
# month and walk back until one answers 200.
#
# Layout (each region sheet): two side-by-side blocks, 1995-2010 in columns
# 1-4 and 2011 onward in columns 6-9: As-at date (Excel serial), total number
# of mortgages, number in arrears, arrears ratio (a fraction). Rows for future
# months exist with blank values. We recompute the rate as arrears / total x
# 100 so the fraction-vs-percent question never comes up.
#
# Failure policy: stop() on any problem. The workflow runs this soft
# (`|| echo ::warning::`), and r/14 carries the last-good records forward.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, DATA_DIR, jsonlite, dplyr, readr
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  if (!requireNamespace("readxl", quietly = TRUE)) install.packages("readxl", repos = "https://cloud.r-project.org")
  library(httr)
  library(readxl)
})
`%||%` <- function(a, b) if (is.null(a)) b else a

BASE_URL <- "https://cba.ca/Assets/CanadianBankersAssociation/Documents/Articles/Statistics/stat-mortgages-arrears-%s-%d-en.xlsx"
UA <- user_agent(paste0("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"))
MONTHS <- c("january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december")
LOOKBACK_MONTHS <- 6

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
cba_series <- Filter(function(s) identical(s$provider, "cba_arrears") && !isTRUE(s$disabled),
                     catalog$series)
if (length(cba_series) == 0) { message("[cba] no cba_arrears series in catalog - nothing to do"); quit(status = 0) }
message(sprintf("[cba] %d series to build", length(cba_series)))

# --- 1. Find + download the newest monthly workbook ---------------------------
dl_dir <- file.path(DATA_DIR, "cba_arrears"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)
xlsx_path <- file.path(dl_dir, "mortgages-in-arrears.xlsx")
today <- Sys.Date()
y <- as.integer(format(today, "%Y")); mo <- as.integer(format(today, "%m"))
found <- NULL
for (k in 0:LOOKBACK_MONTHS) {
  mm <- mo - k; yy <- y
  while (mm < 1) { mm <- mm + 12; yy <- yy - 1 }
  url <- sprintf(BASE_URL, MONTHS[mm], yy)
  resp <- tryCatch(GET(url, UA, timeout(60), write_disk(xlsx_path, overwrite = TRUE)),
                   error = function(e) NULL)
  code <- if (is.null(resp)) NA else status_code(resp)
  if (!is.na(code) && code == 200 && file.size(xlsx_path) > 20000) { found <- url; break }
  message(sprintf("[cba] %s -> HTTP %s", basename(url), code))
}
if (is.null(found)) stop(sprintf("[cba] no arrears workbook found in the last %d months", LOOKBACK_MONTHS))
message(sprintf("[cba] using %s (%d bytes)", found, file.size(xlsx_path)))

# --- 2. Parse each catalog sheet -----------------------------------------------
excel_date <- function(x) {
  d <- as.Date(suppressWarnings(as.numeric(x)), origin = "1899-12-30")
  as.Date(format(d, "%Y-%m-01"))   # 1995-2010 rows are dated month-end
}
read_block <- function(m, cols) {
  if (ncol(m) < max(cols)) return(NULL)
  b <- m[, cols, drop = FALSE]
  keep <- grepl("^[0-9]+(\\.0+)?$", b[, 1]) & !is.na(b[, 2]) & !is.na(b[, 3])
  if (!any(keep)) return(NULL)
  b <- b[keep, , drop = FALSE]
  total <- suppressWarnings(as.numeric(b[, 2])); arrears <- suppressWarnings(as.numeric(b[, 3]))
  ok <- !is.na(total) & !is.na(arrears) & total > 0
  tibble::tibble(date = excel_date(b[ok, 1]), value = arrears[ok] / total[ok] * 100)
}
sheets <- excel_sheets(xlsx_path)
rows <- lapply(cba_series, function(s) {
  sh <- s$cbaSheet
  if (is.null(sh) || !(sh %in% sheets))
    stop(sprintf("[cba] %s: sheet '%s' not in workbook (sheets: %s)", s$id, sh %||% "", paste(sheets, collapse = ", ")))
  m <- as.matrix(suppressMessages(read_excel(xlsx_path, sheet = sh, col_names = FALSE,
                                             col_types = "text", .name_repair = "minimal")))
  hdr <- tolower(paste(m[1:min(10, nrow(m)), ], collapse = " "))
  if (!grepl("arrears", hdr)) stop(sprintf("[cba] %s: sheet '%s' has no 'arrears' header - layout changed?", s$id, sh))
  d <- dplyr::bind_rows(read_block(m, 1:4), read_block(m, 6:9)) %>%
    dplyr::filter(!is.na(date)) %>% dplyr::distinct(date, .keep_all = TRUE) %>% dplyr::arrange(date)
  if (nrow(d) < 120) stop(sprintf("[cba] %s: only %d months parsed (expected 120+)", s$id, nrow(d)))
  rng <- range(d$value)
  if (rng[1] < 0 || rng[2] > 3) stop(sprintf("[cba] %s: rate outside plausible 0-3%% band (%.3f..%.3f)", s$id, rng[1], rng[2]))
  message(sprintf("  [cba] %-24s -> %d months (%s..%s), latest=%.3f%%",
                  s$id, nrow(d), d$date[1], d$date[nrow(d)], d$value[nrow(d)]))
  tibble::tibble(id = s$id, seriesId = s$id, date = format(d$date, "%Y-%m-%d"),
                 value = round(d$value, 4), units = s$units, geo = s$geo,
                 frequency = s$frequency, transform = s$transform)
})
combined <- dplyr::bind_rows(rows) %>% dplyr::arrange(id, date)

out_path <- file.path(DATA_DIR, "cba_arrears.csv")
readr::write_csv(combined, out_path)
message(sprintf("\n[cba] Wrote %s (%d rows; %d series; latest %s)",
                out_path, nrow(combined), dplyr::n_distinct(combined$id), max(combined$date)))
