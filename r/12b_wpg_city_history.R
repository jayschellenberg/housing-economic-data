# =============================================================================
# r/12b_wpg_city_history.R
# Enrich the Winnipeg virtual geographies (WPG_Cluster / WPG_CA) in
# census_profile.json with CITY OF WINNIPEG historical census profiles for
# 2006, 2011 and 2016. The 2021 figures stay as-is (CensusMapper, DA-aggregated
# by r/12). This script appends the earlier census years from a *different*
# source so clusters/CAs gain a real population & dwelling trend back to 2006
# and a 2011/2016 demographics comparison.
#
# Source: City of Winnipeg legacy census profiles — Community Social Data
# Strategy (CSDS) custom tabulation of the StatCan Census — at
# legacy.winnipeg.ca/census. NOTE this is a different tabulation than the
# CensusMapper data feeding the PR/CMA/CD/CSD rows and the 2021 clusters, so a
# 2016->2021 step in a cluster series can be partly a source artifact.
#   - 2016: a clean per-cluster and per-CA .xlsx (direct values).
#   - 2011 & 2006: NO cluster aggregate is published — only per-neighbourhood
#     .xls. Cluster/CA totals are summed from their neighbourhoods (listed in
#     r/lib/wpg_city_neighbourhoods.csv). Counts sum cleanly; rates are
#     re-derived; medians are NOT aggregatable and are left null. 2006 is
#     trends-only (the Demographics period selector offers 2021/2016/2011).
#
# Run AFTER r/12_census_profile.R. No CensusMapper key needed — only downloads
# from legacy.winnipeg.ca, cached under r/lib/cache/wpg_city/ so re-runs are
# offline. RUN-ONCE / MANUAL (census is 5-yearly).
#
# Depends on: readxl, jsonlite
# =============================================================================

suppressPackageStartupMessages({
  for (p in c("readxl", "jsonlite")) {
    if (!requireNamespace(p, quietly = TRUE))
      install.packages(p, repos = "https://cloud.r-project.org")
  }
  library(readxl); library(jsonlite)
})

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# ---- Paths -----------------------------------------------------------------
.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
JSON_PATH <- normalizePath(file.path(.this_dir, "..", "web", "public", "data",
                                     "housing", "census_profile.json"),
                           winslash = "/", mustWork = TRUE)
MANIFEST  <- file.path(.this_dir, "lib", "wpg_city_neighbourhoods.csv")
CACHE     <- file.path(.this_dir, "lib", "cache", "wpg_city")
dir.create(CACHE, recursive = TRUE, showWarnings = FALSE)
HOST <- "https://legacy.winnipeg.ca"

# ---- Download + cache ------------------------------------------------------
# A returned HTML 404 stub is ~3 KB; treat anything tiny / non-OLE2 / non-zip as
# missing so callers can skip it.
fetch_cached <- function(url_path, key) {
  dest <- file.path(CACHE, key)
  if (file.exists(dest) && file.info(dest)$size > 8000) return(dest)
  url <- paste0(HOST, gsub(" ", "%20", url_path))
  ok <- tryCatch({
    suppressWarnings(download.file(url, dest, mode = "wb", quiet = TRUE))
    TRUE
  }, error = function(e) FALSE)
  if (!ok || !file.exists(dest)) return(NA_character_)
  sig <- readBin(dest, "raw", 2)
  is_xls  <- length(sig) == 2 && sig[1] == as.raw(0xD0) && sig[2] == as.raw(0xCF)
  is_xlsx <- length(sig) == 2 && sig[1] == as.raw(0x50) && sig[2] == as.raw(0x4B)
  if (file.info(dest)$size < 8000 || !(is_xls || is_xlsx)) { unlink(dest); return(NA_character_) }
  dest
}

# ---- Profile parser --------------------------------------------------------
read_profile <- function(path) {
  df <- suppressMessages(read_excel(path, sheet = 1, col_names = FALSE, .name_repair = "minimal"))
  m <- as.data.frame(lapply(df, as.character), stringsAsFactors = FALSE)
  m[is.na(m)] <- ""
  m
}
.num <- function(x) { x <- gsub("[,$%]", "", x); suppressWarnings(as.numeric(x[1])) }
.hdr <- function(m, rx, need_col2 = FALSE) {
  hit <- grep(rx, m[[1]], perl = TRUE, ignore.case = TRUE)
  if (need_col2) hit <- hit[m[[2]][hit] != "" & !grepl("\\.\\.\\.", m[[1]][hit])]
  if (length(hit)) hit[1] else NA_integer_
}
# value in column `col` of the first row after `start` whose col1 matches label_rx
.after <- function(m, start, label_rx, col = 2, span = 45) {
  if (is.na(start)) return(NA_real_)
  for (i in (start + 1):min(start + span, nrow(m)))
    if (grepl(label_rx, m[[1]][i], perl = TRUE, ignore.case = TRUE)) return(.num(m[[i, col]]))
  NA_real_
}
# value in column `col` of the first row anywhere whose col1 matches label_rx
.atrow <- function(m, label_rx, col = 2) {
  i <- grep(label_rx, m[[1]], perl = TRUE, ignore.case = TRUE)
  if (!length(i)) return(NA_real_)
  .num(m[[i[1], col]])
}
# first non-NA among several candidate labels
.firstof <- function(m, start, labels, col = 2) {
  for (l in labels) { v <- .after(m, start, l, col); if (!is.na(v)) return(v) }
  NA_real_
}

# Returns a flat named list of raw COUNTS (+ median_hh_income, avg_hh_size) for
# one profile, in our schema. NA where a field isn't present that census.
parse_file <- function(path, year) {
  m <- read_profile(path)
  o <- list()
  rp <- .hdr(m, "^TOTAL POPULATION$")
  o$population <- .after(m, rp, paste0("^", year, "\\s*CENSUS"))
  # structural type + occupied dwellings
  rd <- .hdr(m, "^Type of Dwelling")
  o$single_detached <- .after(m, rd, "^Single-detached")
  o$semi_detached   <- .after(m, rd, "^Semi-detached")
  o$row_house       <- .after(m, rd, "^Row house")
  o$apt_duplex      <- .after(m, rd, "duplex")
  o$apt_ge5         <- .after(m, rd, "five or more storeys")
  o$apt_lt5         <- .after(m, rd, "fewer than five storeys")
  o$other_attached  <- .after(m, rd, "Other single-attached")
  o$movable         <- .after(m, rd, "^Movable")
  o$households      <- .after(m, rd, "^TOTAL OCCUPIED PRIVATE DWELLINGS", span = 14)
  # tenure
  rt <- .hdr(m, "^Dwelling Tenure")
  o$owner        <- .after(m, rt, "^Owned")
  o$renter       <- .after(m, rt, "^Rented")
  o$tenure_total <- .after(m, rt, "^TOTAL", span = 6)
  # dwelling condition (regular/minor vs major repairs) — for the Housing Stock tab
  rcon <- .hdr(m, "^Dwelling Condition")
  o$condition_ok    <- .after(m, rcon, "regular maintenance")
  o$condition_major <- .after(m, rcon, "major repairs")
  o$condition_total <- .after(m, rcon, "^TOTAL", span = 6)
  # household size
  rh <- .hdr(m, "^Household Size")
  o$hh_size_1     <- .after(m, rh, "^1 person")
  o$hh_size_2     <- .after(m, rh, "^2 person")
  o$hh_size_3     <- .after(m, rh, "^3 person")
  o$hh_size_4     <- .after(m, rh, "^4 person")
  o$hh_size_5plus <- .after(m, rh, "^5 or more")
  o$hh_size_total <- .after(m, rh, "^TOTAL", span = 9)
  o$avg_hh_size   <- .after(m, rh, "Average number of persons per household", span = 9)
  # period of construction -> our 8 buckets (label variants across censuses)
  rc <- .hdr(m, "^Period of Construction")
  o$built_1960      <- .after(m, rc, "1960 or before")
  o$built_1961_1980 <- .after(m, rc, "1961 to 1980")
  o$built_1981_1990 <- .after(m, rc, "1981 to 1990")
  o$built_1991_2000 <- .after(m, rc, "1991 to 2000")
  o$built_2001_2005 <- .firstof(m, rc, c("2001 to 2005"))
  o$built_2006_2010 <- .firstof(m, rc, c("2006 to 2010", "2006 to 2011"))
  o$built_2011_2015 <- .firstof(m, rc, c("2011 to 2015", "2011 to 2016"))
  o$built_2016_2021 <- .after(m, rc, "2016 to 2021")
  o$period_total    <- .after(m, rc, "^TOTAL", span = 12)
  # age groups: data table where col2 = area name. Count = Male+Female if split,
  # else the first number column. Bucket by the row's lower-bound age.
  ra <- .hdr(m, "^POPULATION BY AGE", need_col2 = TRUE)
  o$age_0_14 <- o$age_15_64 <- o$age_65_plus <- NA_real_
  if (!is.na(ra)) {
    male_split <- grepl("male", paste(m[ra + 1, ], collapse = " "), ignore.case = TRUE)
    a0 <- a1 <- a2 <- 0; got <- FALSE
    for (i in (ra + 2):min(ra + 25, nrow(m))) {
      lab <- m[[1]][i]
      if (grepl("^\\s*TOTAL", lab, ignore.case = TRUE)) break
      lo <- suppressWarnings(as.integer(sub("^[^0-9]*([0-9]+).*", "\\1", lab)))
      if (is.na(lo)) next
      cnt <- if (male_split) sum(.num(m[[i, 2]]), .num(m[[i, 3]]), na.rm = TRUE) else .num(m[[i, 2]])
      if (is.na(cnt)) next
      got <- TRUE
      if (lo < 15) a0 <- a0 + cnt else if (lo < 65) a1 <- a1 + cnt else a2 <- a2 + cnt
    }
    if (got) { o$age_0_14 <- a0; o$age_15_64 <- a1; o$age_65_plus <- a2 }
  }
  # tenant households spending 30%+ on shelter (count) — for a derived rate
  o$tenant_stir_count <- .atrow(m, "^Tenant-occupied households spending 30")
  # median household income (only meaningful at the aggregate level the file
  # represents; used for the 2016 cluster/CA files, not neighbourhood sums)
  o$median_hh_income <- .atrow(m, "^Median household income")
  o
}

COUNT_KEYS <- c("population","households","single_detached","semi_detached","row_house",
  "apt_duplex","apt_ge5","apt_lt5","other_attached","movable","owner","renter","tenure_total",
  "hh_size_1","hh_size_2","hh_size_3","hh_size_4","hh_size_5plus","hh_size_total",
  "built_1960","built_1961_1980","built_1981_1990","built_1991_2000","built_2001_2005",
  "built_2006_2010","built_2011_2015","built_2016_2021","period_total",
  "age_0_14","age_15_64","age_65_plus","tenant_stir_count",
  "condition_ok","condition_major","condition_total")

# Sum a list of parsed profiles (neighbourhoods) into one aggregate. NA-sums
# stay NA only if every part is NA (so a bucket absent that census => NA => hidden).
agg_sum <- function(parts) {
  o <- list()
  for (k in COUNT_KEYS) {
    vals <- vapply(parts, function(p) p[[k]] %||% NA_real_, numeric(1))
    o[[k]] <- if (all(is.na(vals))) NA_real_ else sum(vals, na.rm = TRUE)
  }
  o   # median / avg deliberately omitted — not aggregatable
}

# ---- Build trend / demo objects in the JSON schema -------------------------
TREND_KEYS <- c("single_detached","apt_ge5","apt_lt5","semi_detached","row_house",
                "apt_duplex","movable","other_attached")
rnd <- function(x) if (is.null(x) || length(x) == 0 || !is.finite(x)) NA else round(x)

trend_obj <- function(o) {
  y <- list(population = rnd(o$population), households = rnd(o$households), dwellings = NA)
  for (k in TREND_KEYS) y[[k]] <- rnd(o[[k]])
  y
}
demo_obj <- function(o, median_hh = NA) {
  stir <- if (!is.na(o$tenant_stir_count %||% NA) && !is.na(o$renter %||% NA) && (o$renter %||% 0) > 0)
            round(o$tenant_stir_count / o$renter * 100) else NA
  d <- list(
    population = rnd(o$population), households = rnd(o$households),
    age_0_14 = rnd(o$age_0_14), age_15_64 = rnd(o$age_15_64), age_65_plus = rnd(o$age_65_plus),
    median_age = NA,
    hh_size_total = rnd(o$hh_size_total), hh_size_1 = rnd(o$hh_size_1), hh_size_2 = rnd(o$hh_size_2),
    hh_size_3 = rnd(o$hh_size_3), hh_size_4 = rnd(o$hh_size_4), hh_size_5plus = rnd(o$hh_size_5plus),
    avg_hh_size = if (is.finite(o$avg_hh_size %||% NA)) round(o$avg_hh_size, 1) else NA,
    bed_total = NA, bed_0 = NA, bed_1 = NA, bed_2 = NA, bed_3 = NA, bed_4plus = NA,
    period_total = rnd(o$period_total),
    built_1960 = rnd(o$built_1960), built_1961_1980 = rnd(o$built_1961_1980),
    built_1981_1990 = rnd(o$built_1981_1990), built_1991_2000 = rnd(o$built_1991_2000),
    built_2001_2005 = rnd(o$built_2001_2005), built_2006_2010 = rnd(o$built_2006_2010),
    built_2011_2015 = rnd(o$built_2011_2015), built_2016_2021 = rnd(o$built_2016_2021),
    tenure_total = rnd(o$tenure_total), owner = rnd(o$owner), renter = rnd(o$renter),
    median_dwelling_val = NA, median_rent = NA, median_ind_income = NA,
    median_hh_income = if (is.finite(median_hh %||% NA)) round(median_hh) else NA,
    tenant_stir_30 = stir,
    # dwelling condition (counts) — consumed by the Housing Stock tab, not shown
    # in the Census Profile demographics table.
    condition_ok = rnd(o$condition_ok), condition_major = rnd(o$condition_major),
    condition_total = rnd(o$condition_total))
  d
}

# =============================================================================
# 1. Parse the per-cluster / per-CA 2016 .xlsx (direct values).
# =============================================================================
man <- read.csv(MANIFEST, stringsAsFactors = FALSE, encoding = "UTF-8")
clusters_city <- sort(unique(man$cluster))
cas_city      <- sort(unique(man$community_area))

message("[12b] 2016: per-cluster + per-CA .xlsx …")
ingest_2016 <- function(name, kind) {  # kind: "cluster" | "ca"
  if (kind == "cluster")
    path <- sprintf("/Census/2016/Clusters/%s Neighbourhood Cluster/%s Neighbourhood Cluster.xlsx", name, name)
  else
    path <- sprintf("/Census/2016/Community Area/%s Community Area/%s Community Area.xlsx", name, name)
  key <- sprintf("2016_%s_%s.xlsx", kind, gsub("[^A-Za-z0-9]+", "_", name))
  f <- fetch_cached(path, key)
  if (is.na(f)) { message("    MISSING 2016 ", kind, ": ", name); return(NULL) }
  parse_file(f, "2016")
}
city2016 <- list(cluster = list(), ca = list())
for (nm in clusters_city) { p <- ingest_2016(nm, "cluster"); if (!is.null(p)) city2016$cluster[[nm]] <- p }
for (nm in cas_city)      { p <- ingest_2016(nm, "ca");      if (!is.null(p)) city2016$ca[[nm]] <- p }

# =============================================================================
# 2. Parse + aggregate the per-neighbourhood 2011 & 2006 .xls.
# =============================================================================
aggregate_year <- function(year) {
  rows <- man[man$year == as.integer(year) | man$year == year, ]
  message(sprintf("[12b] %s: %d neighbourhood .xls -> aggregate…", year, nrow(rows)))
  parsed <- vector("list", nrow(rows)); ok <- 0
  for (i in seq_len(nrow(rows))) {
    key <- sprintf("%s_%s.xls", year, gsub("[^A-Za-z0-9]+", "_", paste(rows$cluster[i], rows$neighbourhood[i])))
    f <- fetch_cached(rows$xls_url[i], key)
    if (is.na(f)) { message("    MISSING ", year, ": ", rows$neighbourhood[i]); next }
    parsed[[i]] <- tryCatch(parse_file(f, year), error = function(e) NULL)
    if (!is.null(parsed[[i]])) ok <- ok + 1
    if (i %% 40 == 0) message(sprintf("      …%d/%d", i, nrow(rows)))
  }
  message(sprintf("    parsed %d/%d", ok, nrow(rows)))
  rows$.idx <- seq_len(nrow(rows))
  agg_by <- function(col) {
    out <- list()
    for (g in sort(unique(rows[[col]]))) {
      idx <- rows$.idx[rows[[col]] == g]
      parts <- Filter(Negate(is.null), parsed[idx])
      if (length(parts)) out[[g]] <- agg_sum(parts)
    }
    out
  }
  list(cluster = agg_by("cluster"), ca = agg_by("community_area"))
}
city2011 <- aggregate_year("2011")
city2006 <- aggregate_year("2006")

# ---- 2021 dwelling condition (per-cluster/CA .xlsx) ------------------------
# CensusMapper supplies the 2021 trends/demographics for these virtual geos but
# has no dwelling-condition vector, so we take just condition_* from the City's
# 2021 files to complete the Housing Stock condition series.
message("[12b] 2021 condition: per-cluster + per-CA .xlsx …")
ingest_2021 <- function(name, kind) {
  if (kind == "cluster")
    path <- sprintf("/Census/2021/Clusters/%s Neighbourhood Cluster/%s Neighbourhood Cluster.xlsx", name, name)
  else
    path <- sprintf("/Census/2021/Community Area/%s Community Area/%s Community Area.xlsx", name, name)
  key <- sprintf("2021_%s_%s.xlsx", kind, gsub("[^A-Za-z0-9]+", "_", name))
  f <- fetch_cached(path, key)
  if (is.na(f)) { message("    MISSING 2021 ", kind, ": ", name); return(NULL) }
  parse_file(f, "2021")
}
city2021 <- list(cluster = list(), ca = list())
for (nm in clusters_city) { p <- ingest_2021(nm, "cluster"); if (!is.null(p)) city2021$cluster[[nm]] <- p }
for (nm in cas_city)      { p <- ingest_2021(nm, "ca");      if (!is.null(p)) city2021$ca[[nm]] <- p }

# =============================================================================
# 3. Integrate into census_profile.json.
# =============================================================================
message("[12b] Integrating into census_profile.json …")
doc <- fromJSON(JSON_PATH, simplifyVector = FALSE)

# Normalise a name for matching ("St. James - Assiniboia" vs "St. James-Assiniboia").
norm <- function(s) tolower(gsub("\\s*-\\s*", "-", gsub("\\s+", " ", trimws(s %||% ""))))
city_by_norm <- function(lst) setNames(lst, vapply(names(lst), norm, character(1)))

C16 <- list(WPG_Cluster = city_by_norm(city2016$cluster), WPG_CA = city_by_norm(city2016$ca))
C11 <- list(WPG_Cluster = city_by_norm(city2011$cluster), WPG_CA = city_by_norm(city2011$ca))
C06 <- list(WPG_Cluster = city_by_norm(city2006$cluster), WPG_CA = city_by_norm(city2006$ca))
C21 <- list(WPG_Cluster = city_by_norm(city2021$cluster), WPG_CA = city_by_norm(city2021$ca))

# Ensure trends/demo are year-keyed objects (the virtual geos may carry a flat
# 2021 demo); preserve the existing 2021 entry untouched.
as_year_keyed <- function(obj) {
  if (is.null(obj)) return(list())
  yrs <- c("2006","2011","2016","2021")
  if (any(yrs %in% names(obj))) return(obj)        # already year-keyed
  if (length(obj)) return(list(`2021` = obj))       # flat snapshot => 2021
  list()
}

stats <- list(matched = 0, t = 0, d = 0)
for (i in seq_along(doc$regions)) {
  r <- doc$regions[[i]]
  if (!(r$level %in% c("WPG_Cluster", "WPG_CA"))) next
  key <- norm(r$name)
  tr <- as_year_keyed(r$trends); dm <- as_year_keyed(r$demo)
  hit <- FALSE
  # trends: 2006/2011/2016 ; demographics: 2011/2016 (selector years)
  if (!is.null(C16[[r$level]][[key]])) { tr[["2016"]] <- trend_obj(C16[[r$level]][[key]])
    dm[["2016"]] <- demo_obj(C16[[r$level]][[key]], C16[[r$level]][[key]]$median_hh_income); hit <- TRUE; stats$d <- stats$d + 1 }
  if (!is.null(C11[[r$level]][[key]])) { tr[["2011"]] <- trend_obj(C11[[r$level]][[key]])
    dm[["2011"]] <- demo_obj(C11[[r$level]][[key]]); hit <- TRUE; stats$d <- stats$d + 1 }
  if (!is.null(C06[[r$level]][[key]])) { tr[["2006"]] <- trend_obj(C06[[r$level]][[key]]); hit <- TRUE }
  # 2021: keep CensusMapper trends/demographics, only graft in City condition_*.
  if (!is.null(C21[[r$level]][[key]])) {
    cc <- C21[[r$level]][[key]]
    if (is.null(dm[["2021"]])) dm[["2021"]] <- list()
    dm[["2021"]]$condition_ok    <- rnd(cc$condition_ok)
    dm[["2021"]]$condition_major <- rnd(cc$condition_major)
    dm[["2021"]]$condition_total <- rnd(cc$condition_total)
    hit <- TRUE
  }
  if (hit) {
    tr <- tr[order(names(tr))]; dm <- dm[order(names(dm))]
    doc$regions[[i]]$trends <- tr; doc$regions[[i]]$demo <- dm
    stats$matched <- stats$matched + 1; stats$t <- stats$t + 1
  } else message("    NO city match for ", r$level, " ", r$name)
}

# =============================================================================
# 4. Neighbourhood history — per-neighbourhood profiles onto WPG_Nbhd regions.
# The WPG_Nbhd geos are 2021-only (DA-aggregated by r/12); this grafts the City's
# 2006/2011/2016 neighbourhood profiles onto each by name. 2016 files are .xlsx;
# 2011/2006 are .xls (already cached from the cluster aggregation — same cache
# key, so no re-download). 2006 is trends-only (the demographics period selector
# offers 2021/2016/2011); single-area medians are valid so they're kept for
# 2011/2016. The City and our 2021 neighbourhood sets differ a little, so some
# don't match — reported, not fatal.
# =============================================================================
nb_norm <- function(s) trimws(gsub("[^a-z0-9]+", " ", tolower(gsub("[‘’']", "", s %||% ""))))
nb_idx <- list()
for (i in seq_along(doc$regions))
  if (doc$regions[[i]]$level == "WPG_Nbhd") nb_idx[[nb_norm(doc$regions[[i]]$name)]] <- i
for (yr in c("2016", "2011", "2006")) {
  nb_rows <- man[as.character(man$year) == yr, ]
  message(sprintf("[12b] %s neighbourhoods: per-neighbourhood -> WPG_Nbhd (%d files)…", yr, nrow(nb_rows)))
  matched <- 0L; unmatched <- 0L
  for (k in seq_len(nrow(nb_rows))) {
    ri <- nb_idx[[nb_norm(nb_rows$neighbourhood[k])]]
    if (is.null(ri)) { unmatched <- unmatched + 1L; next }
    ckey <- if (yr == "2016") sprintf("2016nb_%s.xlsx", gsub("[^A-Za-z0-9]+", "_", nb_rows$neighbourhood[k]))
            else sprintf("%s_%s.xls", yr, gsub("[^A-Za-z0-9]+", "_", paste(nb_rows$cluster[k], nb_rows$neighbourhood[k])))
    f <- fetch_cached(nb_rows$xls_url[k], ckey)
    if (is.na(f)) next
    o <- tryCatch(parse_file(f, yr), error = function(e) NULL)
    if (is.null(o)) next
    tr <- as_year_keyed(doc$regions[[ri]]$trends); dm <- as_year_keyed(doc$regions[[ri]]$demo)
    tr[[yr]] <- trend_obj(o)
    if (yr != "2006") dm[[yr]] <- demo_obj(o, o$median_hh_income)
    doc$regions[[ri]]$trends <- tr[order(names(tr))]
    doc$regions[[ri]]$demo   <- dm[order(names(dm))]
    matched <- matched + 1L
    if (k %% 60 == 0) message(sprintf("      …%d/%d", k, nrow(nb_rows)))
  }
  message(sprintf("[12b]   %s: enriched %d WPG_Nbhd; %d had no match", yr, matched, unmatched))
}

# Append the Winnipeg-history provenance note, but idempotently — r/12b reads
# the existing JSON and re-runs on every refresh, so a blind paste0 accumulates
# the same sentence each time (it had stacked up 5×).
wpg_note <- paste0(
  "; Winnipeg cluster/community-area history (2006/2011/2016) from City of Winnipeg ",
  "census profiles (Community Social Data Strategy custom tabulation)")
if (!grepl("Winnipeg cluster/community-area history", doc$source %||% "", fixed = TRUE))
  doc$source <- paste0(doc$source, wpg_note)
# Advertise the dwelling-condition keys (Housing Stock tab) if not already listed.
for (k in c("condition_ok","condition_major","condition_total"))
  if (!(k %in% unlist(doc$demoKeys))) doc$demoKeys <- c(doc$demoKeys, k)

writeLines(toJSON(doc, auto_unbox = TRUE, na = "null", digits = 10), JSON_PATH, useBytes = TRUE)
message(sprintf("[12b] Done. Enriched %d virtual geographies. Wrote %s", stats$matched, JSON_PATH))
