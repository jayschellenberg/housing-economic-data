# =============================================================================
# r/10d_dwelling_types_2006.R
# Add 2006 Census structural type onto web/public/data/housing/dwelling_types.json
# (2021/2016/2011 already present). The 2006 Community Profile (catalogue
# 92-591-XE) is a SUMMARY: structural type is published only as PERCENTAGES of
# occupied private dwellings, and only SIX categories (single-detached, semi,
# row, apartment-duplex, apartment <5 storeys, apartment 5+ storeys). It does NOT
# break out "movable" or "other single-attached" — those stay NA. Counts are
# derived as round(pct/100 * total). Sources (same comp_download.cfm as 2011):
#   - CSV101: Canada + provinces/territories  (skip 1; geo col1, char col4, total col6)
#   - CSV201: CMAs / agglomerations           (skip 3; geo col1 = 3-digit, char col6, total col8)
# Run AFTER r/10 (+ r/10b/r/10c). Census-frequency, run-on-demand.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, DATA_DIR, WEB_DATA

TOTAL_PAT <- "^Total private dwellings occupied by usual residents$"
# Canonical 8-type slot → regex matching the 2006 "... - as a %" label (trimmed).
# Slots 7 (other single-attached) and 8 (movable) are absent from the profile.
PCT_PAT_2006 <- c(
  "^Single-detached houses? - as a %",
  "^Semi-detached houses? - as a %",
  "^Row houses? - as a %",
  "^Apartments?, duplex - as a %",
  "fewer than five storeys - as a %",
  "five or more storeys - as a %")

CTLG <- "92-591-XE"
BASE <- "https://www12.statcan.gc.ca/census-recensement/2011/dp-pd/prof/details/download-telecharger/comprehensive/comp_download.cfm"
dl_dir <- file.path(DATA_DIR, "cp2006"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)

fetch_unzip <- function(fmt, want_pat) {
  if (!length(list.files(dl_dir, pattern = want_pat, full.names = TRUE, ignore.case = TRUE))) {
    zp <- file.path(dl_dir, paste0(fmt, ".zip"))
    message(sprintf("[10d] downloading %s %s ...", CTLG, fmt))
    utils::download.file(sprintf("%s?CTLG=%s&FMT=%s&Lang=E", BASE, CTLG, fmt), zp, mode = "wb", quiet = TRUE)
    utils::unzip(zp, exdir = dl_dir)
  }
  list.files(dl_dir, pattern = want_pat, full.names = TRUE, ignore.case = TRUE)[1]
}

numv <- function(x) suppressWarnings(as.numeric(gsub("[^0-9.]", "", x)))

parse_geo_block <- function(char, total) {
  ch <- trimws(char)
  ti <- grep(TOTAL_PAT, ch)
  if (!length(ti)) return(NULL)
  tot <- numv(total[ti[1]])
  if (!is.finite(tot) || tot <= 0) return(NULL)
  types <- rep(NA_real_, 8)
  for (s in seq_along(PCT_PAT_2006)) {
    i <- grep(PCT_PAT_2006[s], ch, ignore.case = TRUE)
    if (length(i)) {
      pct <- numv(total[i[1]])
      if (is.finite(pct)) types[s] <- round(pct / 100 * tot)
    }
  }
  list(total = round(tot), types = types)
}

parse_file <- function(path, skip, geoCol, charCol, totalCol, geo_ok) {
  df <- utils::read.csv(path, header = FALSE, skip = skip, colClasses = "character",
                        stringsAsFactors = FALSE, fileEncoding = "latin1", quote = "\"", fill = TRUE)
  geo <- df[[geoCol]]; char <- df[[charCol]]; total <- df[[totalCol]]
  out <- list()
  for (g in unique(geo)) {
    if (is.na(g) || !geo_ok(g)) next
    sel <- geo == g
    blk <- parse_geo_block(char[sel], total[sel])
    if (!is.null(blk)) out[[g]] <- blk
  }
  out
}

message("[10d] parsing 2006 Community Profile structural type...")
f101 <- fetch_unzip("CSV101", "-101\\.csv$")
f201 <- fetch_unzip("CSV201", "-201\\.csv$")
cpt <- parse_file(f101, skip = 1, geoCol = 1, charCol = 4, totalCol = 6,
                  geo_ok = function(g) g == "1" || grepl("^[0-9]{2}$", g))
cma <- parse_file(f201, skip = 3, geoCol = 1, charCol = 6, totalCol = 8,
                  geo_ok = function(g) grepl("^[0-9]{3}$", g))
lookup <- c(cpt, cma)
message(sprintf("[10d] 2006 geographies parsed: %d (CPT %d, CMA %d)", length(lookup), length(cpt), length(cma)))

# --- Merge onto the multi-year JSON ------------------------------------------
json_path <- file.path(WEB_DATA, "housing", "dwelling_types.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  key <- if (identical(a$level, "country")) "1" else a$uid
  b <- lookup[[key]]
  if (!is.null(b)) { a$census[["2006"]] <- list(total = b$total, types = cleanv(b$types)); added <<- added + 1 }
  a
})
message(sprintf("[10d] 2006 added to %d / %d areas", added, length(doc$areas)))

yrs <- unique(unlist(lapply(doc$areas, function(a) names(a$census))))
doc$censusYears <- as.list(sort(yrs, decreasing = TRUE))
doc$typeLabels[["2006"]] <- doc$typeLabels[["2021"]]   # same canonical 8-type order (slots 7-8 NA)
doc$source <- "Statistics Canada, Census of Population — 2021 (98-10-0040), 2016 + 2011 (98-316) and 2006 (Community Profile 92-591), structural type of dwelling"
doc$notes2006 <- "2006 structural type is from the Community Profile (percentages of occupied private dwellings); counts are derived and exclude separate 'movable' and 'other single-attached' categories."

writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, na = "null"), json_path, useBytes = TRUE)
message(sprintf("[10d] Wrote %s (years: %s)", json_path, paste(unlist(doc$censusYears), collapse = ", ")))
