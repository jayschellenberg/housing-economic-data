# =============================================================================
# r/10c_dwelling_types_2011.R
# Add 2011 Census structural type onto web/public/data/housing/dwelling_types.json
# (2021 from r/10, 2016 from r/10b). Structural type is 100%-data → it lives in
# the 2011 Census Profile (catalogue 98-316-XWE2011001), NOT the NHS profile.
# There is no 2011 REST service (CPR2011 returns HTML), so this parses the
# comprehensive-download CSVs:
#   - CSV101: Canada + provinces/territories  (skip 1; geo col1, char col4, total col6)
#   - CSV201: Census metropolitan areas / agglomerations
#             (skip 2; geo col1 = 3-digit CMA/CA code, char col6, total col8)
# All eight leaf types are reported as counts; "Other dwelling" is a subtotal we
# skip. Run AFTER r/10 (+ r/10b). Census-frequency, run-on-demand.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, DATA_DIR, WEB_DATA
# CSD-level 2011 lives in the ~330 MB 301 file; data.table::fread reads just the
# needed columns. Optional — CSD 2011 is skipped gracefully if it's unavailable.
if (!requireNamespace("data.table", quietly = TRUE))
  tryCatch(utils::install.packages("data.table", repos = "https://cloud.r-project.org"), error = function(e) NULL)

STRUCT_HDR <- "Total number of occupied private dwellings by structural type of dwelling"
# Trimmed 2011 leaf label → canonical 8-type slot (matches r/10 TYPE_LABELS order).
SLOT_2011 <- c(
  "Single-detached house"                                   = 1L,
  "Semi-detached house"                                     = 2L,
  "Row house"                                               = 3L,
  "Apartment, duplex"                                       = 4L,
  "Apartment, building that has fewer than five storeys"    = 5L,
  "Apartment, building that has five or more storeys"       = 6L,
  "Other single-attached house"                             = 7L,
  "Movable dwelling"                                        = 8L)

CTLG <- "98-316-XWE2011001"
BASE <- "https://www12.statcan.gc.ca/census-recensement/2011/dp-pd/prof/details/download-telecharger/comprehensive/comp_download.cfm"
dl_dir <- file.path(DATA_DIR, "cprof2011"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)

fetch_unzip <- function(fmt, want_pat) {
  if (!length(list.files(dl_dir, pattern = want_pat, full.names = TRUE, ignore.case = TRUE))) {
    zp <- file.path(dl_dir, paste0(fmt, ".zip"))
    message(sprintf("[10c] downloading %s %s ...", CTLG, fmt))
    utils::download.file(sprintf("%s?CTLG=%s&FMT=%s&Lang=E", BASE, CTLG, fmt), zp, mode = "wb", quiet = TRUE)
    utils::unzip(zp, exdir = dl_dir)
  }
  list.files(dl_dir, pattern = want_pat, full.names = TRUE, ignore.case = TRUE)[1]
}

numv <- function(x) suppressWarnings(as.numeric(gsub("[^0-9.]", "", x)))

# Within one geography's rows (file order): find the structural-type header, then
# map the eight leaf labels that follow it to their canonical slots.
parse_geo_block <- function(char, total) {
  ch <- trimws(char)
  pi <- which(ch == STRUCT_HDR)
  if (!length(pi)) return(NULL)
  pi <- pi[1]
  tot <- numv(total[pi])
  if (!is.finite(tot) || tot <= 0) return(NULL)
  types <- rep(NA_real_, 8)
  hi <- min(pi + 11L, length(ch))                       # block is 9 rows; cap the scan
  for (k in (pi + 1L):hi) {
    slot <- unname(SLOT_2011[ch[k]])                    # single-bracket → NA if not a leaf label
    if (!is.na(slot)) types[slot] <- numv(total[k])
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

# CSDs come from the big 301 file: read only Geo_Code (1), Characteristics (7),
# Total (9) with fread, and keep Manitoba codes (^46) only. Best-effort.
parse_csd_301 <- function(path, geo_ok) {
  if (!requireNamespace("data.table", quietly = TRUE)) {
    message("[10c] data.table unavailable — skipping CSD-level 2011"); return(list())
  }
  d <- tryCatch(data.table::fread(path, select = c(1L, 7L, 9L), colClasses = "character",
                                  header = TRUE, showProgress = FALSE, encoding = "Latin-1"),
                error = function(e) NULL)
  if (is.null(d)) { message("[10c] CSV301 read failed — skipping CSD-level 2011"); return(list()) }
  geo <- d[[1]]; char <- d[[2]]; total <- d[[3]]
  out <- list()
  for (g in unique(geo[geo_ok(geo)])) {
    sel <- geo == g
    blk <- parse_geo_block(char[sel], total[sel])
    if (!is.null(blk)) out[[g]] <- blk
  }
  out
}

message("[10c] parsing 2011 Census Profile structural type...")
f101 <- fetch_unzip("CSV101", "-101\\.csv$")
f201 <- fetch_unzip("CSV201", "-201\\.csv$")
cpt <- parse_file(f101, skip = 1, geoCol = 1, charCol = 4, totalCol = 6,
                  geo_ok = function(g) g == "01" || grepl("^[0-9]{2}$", g))
cma <- parse_file(f201, skip = 2, geoCol = 1, charCol = 6, totalCol = 8,
                  geo_ok = function(g) grepl("^[0-9]{3}$", g))
f301 <- tryCatch(fetch_unzip("CSV301", "-301\\.csv$"), error = function(e) NULL)
# Manitoba + western municipalities (SK/AB/BC) — the national 301 file carries
# every province's CSDs; keep MB plus the three western provinces so their
# municipalities gain the 2011 back-year (target western baseline). Best-effort.
csd  <- if (!is.null(f301)) parse_csd_301(f301, function(g) grepl("^(46|47|48|59)[0-9]{5}$", g)) else list()
lookup <- c(cpt, cma, csd)
message(sprintf("[10c] 2011 geographies parsed: %d (CPT %d, CMA %d, CSD %d)",
                length(lookup), length(cpt), length(cma), length(csd)))

# --- Merge onto the multi-year JSON ------------------------------------------
json_path <- file.path(WEB_DATA, "housing", "dwelling_types.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  key <- if (identical(a$level, "country")) "01" else a$uid
  b <- lookup[[key]]
  if (!is.null(b)) { a$census[["2011"]] <- list(total = b$total, types = cleanv(b$types)); added <<- added + 1 }
  a
})
message(sprintf("[10c] 2011 added to %d / %d areas", added, length(doc$areas)))

yrs <- unique(unlist(lapply(doc$areas, function(a) names(a$census))))
doc$censusYears <- as.list(sort(yrs, decreasing = TRUE))
doc$typeLabels[["2011"]] <- doc$typeLabels[["2021"]]   # same canonical 8-type order
doc$source <- "Statistics Canada, Census of Population — 2021 (98-10-0040), 2016 + 2011 (Census Profile 98-316), structural type of dwelling"

writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, na = "null"), json_path, useBytes = TRUE)
message(sprintf("[10c] Wrote %s (years: %s)", json_path, paste(unlist(doc$censusYears), collapse = ", ")))
