# =============================================================================
# r/09_add_census_2006.R
# Add 2006 Census housing onto web/public/data/housing/census_housing.json
# (which r/07 + r/08 populated with 2021/2016/2011). The 2006 Community Profile
# (catalogue 92-591-XE) is a SUMMARY, so unlike 2011 it only carries the
# comparable condition metric (% needing major repairs) + total dwellings + a
# coarse before/after-1986 age split — not the detailed period-of-construction
# bands. Sources (same comp_download.cfm form as 2011):
#   - CSV101: Canada + provinces/territories  (header line 1)
#   - CSV301: per-province CSD files; uses MAN only (title+blank+header → skip 2)
# Run AFTER r/07 + r/08. Census-frequency, run-on-demand.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, DATA_DIR, WEB_DATA

PERIOD_LABELS_2006    <- c("1985 or before", "1986 to 2006")    # coarse 2-band split
CONDITION_LABELS_2006 <- c("Regular maintenance or minor repairs needed", "Major repairs needed")
CTLG <- "92-591-XE"
BASE <- "https://www12.statcan.gc.ca/census-recensement/2011/dp-pd/prof/details/download-telecharger/comprehensive/comp_download.cfm"

dl_dir <- file.path(DATA_DIR, "census2006"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)
fetch_unzip <- function(fmt, sub) {
  outdir <- file.path(dl_dir, sub)
  if (!dir.exists(outdir) || !length(list.files(outdir, pattern = "\\.csv$", ignore.case = TRUE))) {
    zp <- file.path(dl_dir, paste0(sub, ".zip"))
    message(sprintf("[09] downloading 2006 %s ...", fmt))
    utils::download.file(sprintf("%s?CTLG=%s&FMT=%s&Lang=E", BASE, CTLG, fmt), zp, mode = "wb", quiet = TRUE)
    utils::unzip(zp, exdir = outdir)
  }
  outdir
}

numv <- function(x) suppressWarnings(as.numeric(gsub("[^0-9.]", "", x)))
getv <- function(char, total, pattern) {
  i <- grep(pattern, char, ignore.case = TRUE)[1]
  if (is.na(i)) NA_real_ else numv(total[i])
}

# Parse one 2006 Community Profile CSV. Condition comes as a %, so the major
# count is derived from the total. Read positionally (fields are quoted) to
# dodge read.csv's header/row.names quirk: skip = lines before the data; the
# CPT and CSD files have different column layouts.
parse_2006 <- function(path, skip, geoCol, charCol, totalCol, geo_ok) {
  df <- utils::read.csv(path, header = FALSE, skip = skip, colClasses = "character",
                        stringsAsFactors = FALSE, fileEncoding = "latin1", quote = "\"", fill = TRUE)
  geo <- df[[geoCol]]; char <- df[[charCol]]; total <- df[[totalCol]]
  out <- list()
  for (g in unique(geo)) {
    if (is.na(g) || !geo_ok(g)) next
    sel <- geo == g; ch <- char[sel]; tt <- total[sel]
    tot  <- getv(ch, tt, "Total private dwellings occupied by usual residents")
    mpct <- getv(ch, tt, "requiring major repair")          # a percentage
    ab   <- getv(ch, tt, "constructed before 1986")
    aa   <- getv(ch, tt, "constructed between 1986")
    if (!is.finite(tot) || tot <= 0) next
    major <- if (is.finite(mpct)) round(mpct / 100 * tot) else NA_real_
    cond  <- if (is.finite(major)) c(tot - major, major) else c(NA_real_, NA_real_)
    out[[g]] <- list(total = round(tot),
                     age = c(if (is.finite(ab)) round(ab) else NA, if (is.finite(aa)) round(aa) else NA),
                     condition = cond)
  }
  out
}

message("[09] parsing 2006 Community Profiles...")
cpt_dir <- fetch_unzip("CSV101", "cpt")
csd_dir <- fetch_unzip("CSV301", "csd")
# CPT (CSV101): header line 1 → skip 1; cols Geo_Code=1, Characteristic=4, Total=6.
# CSD (CSV301): title+blank+header → skip 3; cols Geo_Code=1, Characteristic=7, Total=9.
cpt  <- parse_2006(list.files(cpt_dir, pattern = "-101\\.csv$", full.names = TRUE, ignore.case = TRUE)[1],
                   skip = 1, geoCol = 1, charCol = 4, totalCol = 6,
                   geo_ok = function(g) g == "1" || grepl("^[0-9]{2}$", g))
# Manitoba CSDs only — SK & AB municipalities carry 2016 + 2021 census data only
# (no pre-2016 municipal detail), so the 2006 CSD back-year is Manitoba-only.
man  <- parse_2006(list.files(csd_dir, pattern = "-301-MAN\\.csv$",  full.names = TRUE, ignore.case = TRUE)[1],
                   skip = 3, geoCol = 1, charCol = 7, totalCol = 9, geo_ok = function(g) grepl("^[0-9]{7}$", g))
lookup <- c(cpt, man)
message(sprintf("[09] 2006 geographies parsed: %d (CPT %d, MAN %d)",
                length(lookup), length(cpt), length(man)))

# --- Merge onto the multi-year JSON ------------------------------------------
json_path <- file.path(WEB_DATA, "housing", "census_housing.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  key <- if (identical(a$level, "country")) "1" else a$uid
  b <- lookup[[key]]
  if (!is.null(b)) {
    a$census[["2006"]] <- list(total = b$total, age = cleanv(b$age), condition = cleanv(b$condition))
    added <<- added + 1
  }
  a
})
doc$censusYears <- list("2021", "2016", "2011", "2006")
doc$periodLabels[["2006"]]    <- as.list(PERIOD_LABELS_2006)
doc$conditionLabels[["2006"]] <- as.list(CONDITION_LABELS_2006)
doc$source <- "Statistics Canada, Census of Population — 2021 (98-10-0233), 2016 (Census Profile), 2011 (NHS Profile) and 2006 (Community Profile, 92-591-XE)"

writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, na = "null"), json_path, useBytes = TRUE)
message(sprintf("[09] Added 2006 to %d areas; wrote %s", added, json_path))
