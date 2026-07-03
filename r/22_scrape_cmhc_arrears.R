# =============================================================================
# r/22_scrape_cmhc_arrears.R
# Pull every catalog entry with provider="cmhc_arrears" from CMHC's quarterly
# "Mortgage Delinquency Rate: Canada, Provinces and CMAs" data table (Equifax-
# sourced, 90+ days past due) and write data/cmhc_arrears.csv in the same long
# form as the other indicator scrapers (id, seriesId, date, value, units, geo,
# frequency, transform).
#
# The workbook has no static href on the landing page — the Download button is
# resolved client-side from a hidden <input id="ReportDocumentId"> Sitecore
# media GUID (see cmhc-custom.js: GetReportFileUrl). We do the same at run time:
# extract the GUID, ask /api/Sitecore/PubsAndReports/GetReportFileUrl for the
# file URL, and fall back to the Sitecore media handler /-/media/{GUID}.ashx
# (verified to serve the XLSX directly). Failure policy per the build plan:
# fail LOUDLY — the weekly workflow aborts, shards keep the last-known-good
# data, and the UI's per-tile "as of" dates surface the staleness.
#
# The parser is deliberately layout-agnostic: it hunts for quarter labels
# ("2024Q3" / "Q3 2024") anywhere in each sheet, works out whether quarters run
# down a column or across a row, then matches the catalog geographies against
# the labels on the other axis. On any parse failure it dumps the workbook
# structure so a CI log is enough to diagnose a CMHC layout change.
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

LANDING_URL <- "https://www.cmhc-schl.gc.ca/professionals/housing-markets-data-and-research/housing-data/data-tables/mortgage-and-debt/mortgage-delinquency-rate-canada-provinces-cmas"
# CMHC's CDN rejects the default libcurl UA; present as a browser.
UA <- user_agent(paste0("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"))

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
arr_series <- Filter(function(s) identical(s$provider, "cmhc_arrears") && !isTRUE(s$disabled),
                     catalog$series)
if (length(arr_series) == 0) { message("[arrears] no cmhc_arrears series in catalog — nothing to do"); quit(status = 0) }
message(sprintf("[arrears] %d series to build", length(arr_series)))

# --- 1. Resolve + download the XLSX from the landing page --------------------
resolve_xlsx_url <- function() {
  resp <- tryCatch(GET(LANDING_URL, UA, timeout(60), config(followlocation = TRUE)),
                   error = function(e) NULL)
  if (is.null(resp) || status_code(resp) != 200)
    stop(sprintf("[arrears] landing page HTTP %s",
                 if (is.null(resp)) "no response" else status_code(resp)))
  html <- content(resp, as = "text", encoding = "UTF-8")
  raw <- regmatches(html, regexpr('\\{[0-9A-Fa-f-]{36}\\}"\\s*id="ReportDocumentId"', html))
  if (!length(raw)) stop("[arrears] no ReportDocumentId GUID on the landing page")
  guid <- gsub("[^0-9A-Fa-f-]", "", sub('".*$', "", raw))
  message(sprintf("[arrears] ReportDocumentId: {%s}", guid))
  # Preferred: the same API the page's own Download button uses.
  api <- sprintf("https://www.cmhc-schl.gc.ca/api/Sitecore/PubsAndReports/GetReportFileUrl?documentId=%s&contextLanguage=en",
                 utils::URLencode(sprintf("{%s}", guid), reserved = TRUE))
  r <- tryCatch(GET(api, UA, timeout(30)), error = function(e) NULL)
  if (!is.null(r) && status_code(r) == 200) {
    u <- gsub('^\\s*"|"\\s*$', "", content(r, as = "text", encoding = "UTF-8"))
    u <- trimws(u)
    if (nzchar(u) && !grepl("[<>]", u)) {
      if (grepl("^//", u)) u <- paste0("https:", u)
      if (!grepl("^https?://", u)) u <- paste0("https://www.cmhc-schl.gc.ca", u)
      return(gsub("&amp;", "&", u, fixed = TRUE))
    }
  }
  # Fallback: the Sitecore media handler serves the document by GUID directly.
  sprintf("https://www.cmhc-schl.gc.ca/-/media/%s.ashx", toupper(gsub("-", "", guid)))
}
xlsx_url <- resolve_xlsx_url()
message(sprintf("[arrears] resolved XLSX: %s", xlsx_url))

dl_dir <- file.path(DATA_DIR, "cmhc_arrears"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)
xlsx_path <- file.path(dl_dir, "mortgage-delinquency-rate.xlsx")
resp <- GET(xlsx_url, UA, timeout(120), config(followlocation = TRUE), write_disk(xlsx_path, overwrite = TRUE))
if (status_code(resp) != 200 || !file.exists(xlsx_path) || file.size(xlsx_path) < 5000)
  stop(sprintf("[arrears] XLSX download failed (HTTP %s, %s bytes)",
               status_code(resp), if (file.exists(xlsx_path)) file.size(xlsx_path) else 0))
message(sprintf("[arrears] downloaded %s (%d bytes)", xlsx_path, file.size(xlsx_path)))

# --- 2. Locate the quarter axis + geography axis ------------------------------
# A cell is a quarter label if it looks like "2024Q3", "2024 Q3", "Q3 2024",
# or "2024-Q3" (any spacing/case).
QUARTER_RE <- "^\\s*((19|20)\\d{2})\\s*[-. ]?\\s*[Qq]\\s*([1-4])\\s*$|^\\s*[Qq]\\s*([1-4])\\s*[-. ]?\\s*((19|20)\\d{2})\\s*$"
parse_quarter <- function(x) {
  m <- regmatches(x, regexec(QUARTER_RE, trimws(as.character(x))))[[1]]
  if (!length(m)) return(NA_character_)
  yr <- if (nzchar(m[2])) m[2] else m[6]
  q  <- if (nzchar(m[4])) m[4] else m[5]
  # Some CMHC tables use fiscal quarters; the file itself labels calendar
  # quarters (Q1=Jan-Mar). Anchor each quarter to its closing month.
  sprintf("%s-%02d-01", yr, as.integer(q) * 3L)
}
is_quarter <- function(x) !is.na(parse_quarter(x))

norm_geo <- function(x) gsub("[[:space:]]+", " ", gsub("[[:punct:]]", " ", tolower(trimws(as.character(x)))))
# Catalog geo code -> predicate over a normalised axis label. "manitoba" must
# be a standalone label (not "winnipeg manitoba"); "winnipeg" may carry a
# "cma" / province suffix.
geo_matcher <- function(geo) {
  switch(geo,
    "CA"           = function(l) l == "canada",
    "MB"           = function(l) l == "manitoba",
    "Winnipeg-CMA" = function(l) grepl("^winnipeg\\b", l),
    stop(sprintf("[arrears] no matcher for catalog geo '%s'", geo)))
}

sheets <- excel_sheets(xlsx_path)
dump_structure <- function() {
  message("[arrears] ---- workbook structure dump ----")
  for (sh in sheets) {
    m <- tryCatch(suppressMessages(read_excel(xlsx_path, sheet = sh, col_names = FALSE,
                                              col_types = "text", .name_repair = "minimal")),
                  error = function(e) NULL)
    if (is.null(m)) { message(sprintf("  sheet '%s': unreadable", sh)); next }
    message(sprintf("  sheet '%s': %d x %d", sh, nrow(m), ncol(m)))
    for (r in seq_len(min(10, nrow(m))))
      message(sprintf("    row %02d | %s", r,
                      paste(substr(as.character(unlist(m[r, seq_len(min(8, ncol(m)))])), 1, 18),
                            collapse = " | ")))
  }
  message("[arrears] ---- end dump ----")
}

# Try each sheet until one yields a quarter axis and all catalog geographies.
extract_sheet <- function(sh) {
  m <- tryCatch(suppressMessages(read_excel(xlsx_path, sheet = sh, col_names = FALSE,
                                            col_types = "text", .name_repair = "minimal")),
                error = function(e) NULL)
  if (is.null(m) || nrow(m) < 3 || ncol(m) < 3) return(NULL)
  m <- as.matrix(m)
  qmask <- matrix(vapply(m, is_quarter, logical(1)), nrow = nrow(m))

  col_hits <- colSums(qmask)   # quarters running DOWN a column
  row_hits <- rowSums(qmask)   # quarters running ACROSS a row
  down <- max(col_hits) >= max(row_hits)

  if (down) {
    qcol  <- which.max(col_hits)
    qrows <- which(qmask[, qcol])
    if (length(qrows) < 8) return(NULL)
    dates <- vapply(m[qrows, qcol], parse_quarter, character(1))
    # Geography labels live in the header rows above the first quarter cell.
    hdr_rows <- seq_len(min(qrows) - 1)
    series <- lapply(arr_series, function(s) {
      match_fn <- geo_matcher(s$geo)
      hit <- which(apply(m[hdr_rows, , drop = FALSE], 2,
                         function(colv) any(match_fn(norm_geo(colv)))))
      hit <- setdiff(hit, qcol)
      if (!length(hit)) return(NULL)
      list(s = s, values = m[qrows, hit[1]])
    })
  } else {
    qrow  <- which.max(row_hits)
    qcols <- which(qmask[qrow, ])
    if (length(qcols) < 8) return(NULL)
    dates <- vapply(m[qrow, qcols], parse_quarter, character(1))
    # Geography labels live in the leading columns before the first quarter cell.
    lbl_cols <- seq_len(max(1, min(qcols) - 1))
    series <- lapply(arr_series, function(s) {
      match_fn <- geo_matcher(s$geo)
      hit <- which(apply(m[, lbl_cols, drop = FALSE], 1,
                         function(rowv) any(match_fn(norm_geo(rowv)))))
      hit <- setdiff(hit, qrow)
      if (!length(hit)) return(NULL)
      list(s = s, values = m[hit[1], qcols])
    })
  }
  if (any(vapply(series, is.null, logical(1)))) return(NULL)
  list(dates = dates, series = series)
}

hit <- NULL
for (sh in sheets) {
  hit <- extract_sheet(sh)
  if (!is.null(hit)) { message(sprintf("[arrears] parsed sheet '%s'", sh)); break }
}
if (is.null(hit)) { dump_structure(); stop("[arrears] no sheet contained a quarter axis + all catalog geographies") }

# --- 3. Build the long-form records -------------------------------------------
to_num <- function(x) suppressWarnings(as.numeric(gsub("[%[:space:]]", "", as.character(x))))
rows <- lapply(hit$series, function(e) {
  v <- to_num(e$values)
  keep <- !is.na(v) & !is.na(hit$dates)
  tibble::tibble(id = e$s$id, seriesId = e$s$id, date = hit$dates[keep], value = v[keep],
                 units = e$s$units, geo = e$s$geo, frequency = e$s$frequency,
                 transform = e$s$transform)
})
combined <- dplyr::bind_rows(rows) %>% arrange(id, date)

# Excel percent cells come back as fractions (0.0024); CMHC also publishes the
# rate as a percent number (0.24). Normalise to percent: national 90+ day rates
# have lived between roughly 0.1 and 0.6 since 2012, so a max under 0.05 can
# only be the fraction form.
if (nrow(combined) && max(combined$value, na.rm = TRUE) < 0.05) {
  message("[arrears] values look like fractions — scaling x100 to percent")
  combined$value <- combined$value * 100
}

# --- 4. Sanity gates (fail loudly, per the build plan) ------------------------
for (s in arr_series) {
  sub <- combined[combined$id == s$id, ]
  if (nrow(sub) < 12)
    { dump_structure(); stop(sprintf("[arrears] %s: only %d quarters parsed (expected 12+)", s$id, nrow(sub))) }
  rng <- range(sub$value)
  if (rng[1] < 0 || rng[2] > 5)
    { dump_structure(); stop(sprintf("[arrears] %s: values outside plausible 0-5%% band (%.4f..%.4f)", s$id, rng[1], rng[2])) }
  message(sprintf("  [arrears] %-28s -> %d quarters (%s..%s), latest=%.2f%%",
                  s$id, nrow(sub), sub$date[1], sub$date[nrow(sub)], sub$value[nrow(sub)]))
}

out_path <- file.path(DATA_DIR, "cmhc_arrears.csv")
readr::write_csv(combined, out_path)
message(sprintf("\n[arrears] Wrote %s (%d rows; %d series; latest %s)",
                out_path, nrow(combined), dplyr::n_distinct(combined$id), max(combined$date)))
