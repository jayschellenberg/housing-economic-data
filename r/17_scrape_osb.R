# =============================================================================
# r/17_scrape_osb.R
# Pull every catalog entry with provider="osb" from the Office of the
# Superintendent of Bankruptcy's "Historical Insolvency Statistics by NAICS
# (Monthly)" open dataset, and write data/osb_indicators.csv in the same long
# form as the BoC / StatsCan scrapers (id, seriesId, date, value, units, geo,
# frequency, transform).
#
# The OSB no longer serves this on its own site; it lives on the Open Government
# portal (open.canada.ca) as a CSV whose filename embeds the release month
# (…-april-2026.csv), so the stable resource URL is resolved at run time via the
# CKAN package_show API rather than hard-coded.
#
# Source CSV is a pivoted bilingual cross-tab: province (col1) -> NAICS sector ->
# two component rows (Bankruptcies + Proposals), with ~470 month columns whose
# year is the header and whose month sits in the first data row. Two layouts
# coexist: provincial blocks carry the sector name in col3; the Canada block
# carries it in col2 with "Business Insolvencies/Bankruptcies/Proposals" labels.
# In both, total insolvencies for a sector = the two rows immediately following
# the sector marker. We emit a trailing-12-month sum to smooth the (often tiny)
# monthly counts.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, DATA_DIR, jsonlite, dplyr, readr
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a)) b else a

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
osb_series <- Filter(function(s) identical(s$provider, "osb") && !isTRUE(s$disabled), catalog$series)
if (length(osb_series) == 0) { message("[osb] no osb series in catalog — nothing to do"); quit(status = 0) }
message(sprintf("[osb] %d series to build", length(osb_series)))

# --- 1. Resolve + download the current CSV via the CKAN API ------------------
dataset_id <- osb_series[[1]]$ckanDataset
resolve_csv_url <- function(id) {
  api <- sprintf("https://open.canada.ca/data/api/3/action/package_show?id=%s", id)
  j <- tryCatch(content(GET(api, timeout(60)), as = "parsed", encoding = "UTF-8"), error = function(e) NULL)
  if (is.null(j) || is.null(j$result)) return(NA_character_)
  for (r in j$result$resources)
    if (toupper(r$format %||% "") == "CSV" && grepl("monthly", r$url %||% "", ignore.case = TRUE))
      return(r$url)
  NA_character_
}
csv_url <- resolve_csv_url(dataset_id)
if (is.na(csv_url)) stop("[osb] could not resolve a monthly CSV resource from CKAN")
message(sprintf("[osb] resolved CSV: %s", csv_url))

dl_dir <- file.path(DATA_DIR, "osb"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)
csv_path <- file.path(dl_dir, basename(csv_url))
if (!file.exists(csv_path)) {
  message("[osb] downloading ...")
  utils::download.file(csv_url, csv_path, mode = "wb", quiet = TRUE)
}

# --- 2. Parse the pivoted cross-tab ------------------------------------------
df <- utils::read.csv(csv_path, header = TRUE, colClasses = "character",
                      check.names = FALSE, fileEncoding = "latin1")
eng <- function(x) trimws(sub("/.*$", "", x))           # English half of "Eng/Fra"
c1 <- eng(df[[1]]); c2 <- eng(df[[2]]); c3 <- eng(df[[3]])
prov <- c1; for (i in seq_along(prov)) if (i > 1 && !nzchar(prov[i])) prov[i] <- prov[i - 1]

# Month columns: year is the header name, month is row 1. Build an ISO date per
# value column (cols 4..N); flag the ones that parse.
MONTHS <- c("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
vcol <- 4:ncol(df)
yr <- suppressWarnings(as.integer(names(df)[vcol]))
mo <- match(substr(eng(as.character(unlist(df[1, vcol]))), 1, 3), MONTHS)
date_ok <- !is.na(yr) & !is.na(mo)
dates <- ifelse(date_ok, sprintf("%04d-%02d-01", yr, mo), NA_character_)

numrow <- function(r) { v <- suppressWarnings(as.numeric(as.character(unlist(df[r, vcol])))); v[is.na(v)] <- 0; v }

# Locate the sector marker row for a (province, sector); the two component rows
# (bankruptcies + proposals) follow immediately. Total insolvencies = their sum.
sector_total <- function(province, sector) {
  r <- if (province == "Canada")
         which(prov == "Canada" & c2 == sector & c3 == "Business Insolvencies")
       else
         which(prov == province & c3 == sector)
  if (!length(r)) return(NULL)
  r <- r[1]
  numrow(r + 1) + numrow(r + 2)
}

# Data-completeness cutoff: the published file pads future months with zeros, so
# trailing sums would dip at the tail. Treat the last month where the national
# Construction + Real-Estate monthly total is > 0 as the last real month.
nat_probe <- (sector_total("Canada", "Construction") %||% rep(0, length(vcol))) +
             (sector_total("Canada", "Real Estate and Rental and Leasing") %||% rep(0, length(vcol)))
last_idx <- suppressWarnings(max(which(date_ok & nat_probe > 0)))
keep <- date_ok & (seq_along(vcol) <= last_idx)
message(sprintf("[osb] data through %s", max(dates[keep], na.rm = TRUE)))

roll12 <- function(v) { n <- length(v); out <- rep(NA_real_, n); for (i in 12:n) out[i] <- sum(v[(i - 11):i]); out }

# --- 3. Build each catalog series --------------------------------------------
rows <- lapply(osb_series, function(s) {
  tot <- sector_total(s$osbGeo, s$osbSector)
  if (is.null(tot)) { message(sprintf("  [osb] %s -> sector/geo not found", s$id)); return(NULL) }
  t12 <- roll12(tot)
  ok <- keep & !is.na(t12)
  if (!any(ok)) return(NULL)
  out <- tibble::tibble(id = s$id, seriesId = s$id, date = dates[ok], value = t12[ok],
                        units = s$units, geo = s$geo, frequency = s$frequency, transform = s$transform)
  message(sprintf("  [osb] %-38s -> %d months (%s..%s), latest=%g",
                  s$id, nrow(out), out$date[1], out$date[nrow(out)], out$value[nrow(out)]))
  out
})
ok <- Filter(Negate(is.null), rows)
if (length(ok) == 0) stop("[osb] no series produced data")

combined <- dplyr::bind_rows(ok)
out_path <- file.path(DATA_DIR, "osb_indicators.csv")
readr::write_csv(combined, out_path)
message(sprintf("\n[osb] Wrote %s (%d rows; %d series; latest %s)",
                out_path, nrow(combined), dplyr::n_distinct(combined$id), max(combined$date)))
