# =============================================================================
# r/12b_wpg_city_history.R
# Enrich the Winnipeg virtual geographies (WPG_Cluster / WPG_CA / WPG_Nbhd) in
# census_profile.json with City of Winnipeg census profiles for 2006, 2011 and
# 2016. The 2021 figures stay as-is (CensusMapper, DA-aggregated by r/12). This
# script adds the earlier census years from a *different* tabulation so the
# Winnipeg geos gain a population & dwelling trend back to 2006 and a 2011/2016
# demographics comparison.
#
# Source: City of Winnipeg Open Data portal (data.winnipeg.ca), Community Social
# Data Strategy (CSDS) custom tabulation of the Statistics Canada Census,
# published under the Open Government Licence - Winnipeg. The underlying figures
# are Statistics Canada data (Statistics Canada Open Licence). This replaced the
# legacy.winnipeg.ca/census .xls/.xlsx downloads (City website copyright) in
# Nov 2026. NOTE this is a different tabulation than the CensusMapper data
# feeding the PR/CMA/CD/CSD rows and the 2021 Winnipeg geos, so a 2016->2021 step
# in a cluster series can be partly a source artifact.
#   - 2011 + 2016: dataset ckim-fid6 "Census Values" (long: year, subject,
#     description, sex, boundary_type, boundary_name, value). Neighbourhoods,
#     clusters and CCAs (= community areas) are all published directly, so no
#     neighbourhood summing and the cluster/CA medians are real values.
#   - 2006: wide per-topic datasets bfic-t43j (population) and cem6-ktqa
#     (dwellings). 2006 is trends-only (the Demographics period selector offers
#     2021/2016/2011).
#   - 2021 dwelling condition: NOT on the portal. CensusMapper has no condition
#     vector, so the cluster/CA 2021 condition_* still come from the legacy
#     per-cluster/CA .xlsx (section 3 below), unchanged.
#
# Every run prints a comparison of the values already in census_profile.json
# against the values this run produces (exact matches, differences, newly
# filled, lost) and writes the full table to data/12b_compare.csv.
#   Rscript r/12b_wpg_city_history.R --dry-run   # compare only, no write
#   Rscript r/12b_wpg_city_history.R             # compare, then write
#
# Run AFTER r/12_census_profile.R. No API key needed. Portal responses are
# cached under r/lib/cache/wpg_open_data/ (legacy 2021 files under
# r/lib/cache/wpg_city/) so re-runs are offline; delete the cache to refresh.
# RUN-ONCE / MANUAL (census is 5-yearly).
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
DRY_RUN <- "--dry-run" %in% commandArgs(trailingOnly = TRUE)

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
CACHE_OD  <- file.path(.this_dir, "lib", "cache", "wpg_open_data")
CACHE_LEG <- file.path(.this_dir, "lib", "cache", "wpg_city")
COMPARE_CSV <- file.path(.this_dir, "..", "data", "12b_compare.csv")
dir.create(CACHE_OD,  recursive = TRUE, showWarnings = FALSE)
dir.create(CACHE_LEG, recursive = TRUE, showWarnings = FALSE)
SODA <- "https://data.winnipeg.ca/resource"
LEGACY_HOST <- "https://legacy.winnipeg.ca"

# ---- Open Data (Socrata) download + cache ----------------------------------
# Pages through the SODA CSV endpoint and caches the combined table, so a re-run
# reads the cache and never touches the network.
soda_fetch <- function(id, key, where = NULL, select = NULL) {
  dest <- file.path(CACHE_OD, paste0(key, ".csv"))
  rd <- function(f) read.csv(f, colClasses = "character", check.names = FALSE,
                             encoding = "UTF-8", na.strings = character(0))
  if (file.exists(dest) && file.info(dest)$size > 500) return(rd(dest))
  page <- 50000; off <- 0; parts <- list()
  repeat {
    q <- c(if (!is.null(select)) paste0("$select=", URLencode(select, reserved = TRUE)),
           if (!is.null(where))  paste0("$where=",  URLencode(where,  reserved = TRUE)),
           sprintf("$limit=%d", page), sprintf("$offset=%d", off), "$order=:id")
    url <- sprintf("%s/%s.csv?%s", SODA, id, paste(q, collapse = "&"))
    tmp <- tempfile(fileext = ".csv")
    download.file(url, tmp, mode = "wb", quiet = TRUE)
    df <- rd(tmp); unlink(tmp)
    parts[[length(parts) + 1]] <- df
    if (nrow(df) < page) break
    off <- off + page
  }
  all <- do.call(rbind, parts)
  if (!nrow(all)) stop("[12b] portal returned no rows for ", id, " (", key, ")")
  write.csv(all, dest, row.names = FALSE, fileEncoding = "UTF-8")
  message(sprintf("    fetched %s: %d rows -> %s", id, nrow(all), basename(dest)))
  all
}

.num <- function(x) suppressWarnings(as.numeric(gsub("[,$%]", "", x)))
# Name key for matching portal names to our region names: letters/digits only
# ("St.Boniface East" / "St. Boniface East", "St. James Assiniboia" /
# "St. James-Assiniboia", "Bird's Hill" / "Birds Hill").
nkey <- function(s) gsub("[^a-z0-9]", "", tolower(s %||% ""))

# =============================================================================
# 1. 2011 + 2016 from "Census Values" (ckim-fid6).
# Field spec: year | description_id | our field | expected description (checked,
# so a relabelled portal row is caught). Several ids on one field are summed
# (age bands; 2011 "5 persons" + "6 or more persons"). Labels differ between the
# two years; the ids pin the exact row.
# =============================================================================
SPEC <- read.table(sep = "|", header = TRUE, strip.white = TRUE, quote = "",
                   colClasses = "character", comment.char = "", text = "
year|id|field|description
2011|1|population|Total - Age groups of the population in private households
2011|58402|households|Total number of occupied private dwellings by structural type of dwelling
2011|58642|single_detached|Single-detached house
2011|58996|semi_detached|Semi-detached house
2011|58995|row_house|Row house
2011|58993|apt_duplex|Apartment, duplex
2011|58639|apt_ge5|Apartment, building that has five or more storeys
2011|58992|apt_lt5|Apartment, building that has fewer than five storeys
2011|58994|other_attached|Other single-attached house
2011|58640|movable|Movable dwelling
2011|58328|tenure_total|Total number of private households by tenure
2011|58467|owner|Owner
2011|58468|renter|Renter
2011|58336|condition_total|Total number of occupied private dwellings by condition of dwelling
2011|58498|condition_ok|Only regular maintenance or minor repairs needed
2011|58497|condition_major|Major repairs needed
2011|58387|hh_size_total|Total number of private households by household size
2011|58592|hh_size_1|1 person
2011|58593|hh_size_2|2 persons
2011|58594|hh_size_3|3 persons
2011|58595|hh_size_4|4 persons
2011|58596|hh_size_5plus|5 persons
2011|58597|hh_size_5plus|6 or more persons
2011|58386|hh_persons|Total number of persons in private households
2011|58329|period_total|Total number of occupied private dwellings by period of construction
2011|58469|built_1960|1960 or before
2011|58470|built_1961_1980|1961 to 1980
2011|58471|built_1981_1990|1981 to 1990
2011|58472|built_1991_2000|1991 to 2000
2011|58473|built_2001_2005|2001 to 2005
2011|58474|built_2006_2010|2006 to 2011
2011|58364|age_0_14|0 to 4 years
2011|58373|age_0_14|5 to 9 years
2011|58365|age_0_14|10 to 14 years
2011|58366|age_15_64|15 to 19 years
2011|58367|age_15_64|20 to 24 years
2011|58368|age_15_64|25 to 29 years
2011|58369|age_15_64|30 to 34 years
2011|58370|age_15_64|35 to 39 years
2011|58371|age_15_64|40 to 44 years
2011|58372|age_15_64|45 to 49 years
2011|58374|age_15_64|50 to 54 years
2011|58375|age_15_64|55 to 59 years
2011|58376|age_15_64|60 to 64 years
2011|58377|age_65_plus|65 to 69 years
2011|58378|age_65_plus|70 to 74 years
2011|58379|age_65_plus|75 to 79 years
2011|58380|age_65_plus|80 to 84 years
2011|58381|age_65_plus|85 years and over
2011|58570|tenant_stir_pct|% of tenant households spending 30% or more of household total income on shelter costs
2011|58430|median_hh_income|Median household total income $
2016|1|population|Total - Age groups of the population in private households
2016|1718|households|Total - Occupied private dwellings by structural type of dwelling
2016|1719|single_detached|Single-detached house
2016|1722|semi_detached|Semi-detached house
2016|1723|row_house|Row house
2016|1724|apt_duplex|Apartment or flat in a duplex
2016|1720|apt_ge5|Apartment in a building that has five or more storeys
2016|1725|apt_lt5|Apartment in a building that has fewer than five storeys
2016|1726|other_attached|Other single-attached house
2016|1727|movable|Movable dwelling
2016|1668|tenure_total|Total - Private households by tenure
2016|1669|owner|Owner
2016|1670|renter|Renter
2016|1702|condition_total|Total - Occupied private dwellings by dwelling condition
2016|1703|condition_ok|Only regular maintenance or minor repairs needed
2016|1704|condition_major|Major repairs needed
2016|1596|hh_size_total|Total - Private households by household size
2016|1597|hh_size_1|1 person
2016|1598|hh_size_2|2 persons
2016|1599|hh_size_3|3 persons
2016|1600|hh_size_4|4 persons
2016|1601|hh_size_5plus|5 or more persons
2016|1602|hh_persons|Number of persons in private households
2016|1694|period_total|Total - Occupied private dwellings by period of construction
2016|1695|built_1960|1960 or before
2016|1696|built_1961_1980|1961 to 1980
2016|1697|built_1981_1990|1981 to 1990
2016|1698|built_1991_2000|1991 to 2000
2016|1699|built_2001_2005|2001 to 2005
2016|1700|built_2006_2010|2006 to 2010
2016|1701|built_2011_2015|2011 to 2016
2016|2|age_0_14|0 to 14 years
2016|6|age_15_64|15 to 64 years
2016|17|age_65_plus|65 years and over
2016|1765|tenant_stir_pct|% of tenant households spending 30% or more of its income on shelter costs
2016|1614|median_hh_income|Median total income of households in previous year ($)
")

# portal boundary_type -> our level
BT_LONG <- c("Neighbourhood" = "WPG_Nbhd", "Neighbourhood Cluster" = "WPG_Cluster", "CCA" = "WPG_CA")

# Returns list(level -> list(name key -> flat named list of fields)).
portal_long_year <- function(year) {
  sp <- SPEC[SPEC$year == year, ]
  ids <- unique(sp$id)
  where <- sprintf("year='%s' AND sex='All' AND boundary_type in(%s) AND description_id in(%s)",
                   year, paste0("'", names(BT_LONG), "'", collapse = ","),
                   paste0("'", ids, "'", collapse = ","))
  df <- soda_fetch("ckim-fid6", sprintf("census_values_%s", year), where = where,
                   select = "year,subject,description_id,description,boundary_type,boundary_name,value")
  df$description <- trimws(gsub("\\s+", " ", df$description))
  # an id can be reused under another subject; keep rows whose label is the one we expect
  exp_desc <- setNames(sp$description, sp$id)
  ok <- df$description == exp_desc[df$description_id]
  bad <- unique(df[!ok, c("description_id", "description")])
  if (nrow(bad)) message(sprintf("    %s: ignoring %d id/label rows not in the spec (e.g. id %s '%s')",
                                 year, nrow(bad), bad$description_id[1], bad$description[1]))
  miss <- setdiff(ids, unique(df$description_id[ok]))
  if (length(miss)) stop(sprintf("[12b] %s: spec ids missing or relabelled on the portal: %s",
                                 year, paste(miss, collapse = ", ")))
  df <- df[ok, ]
  df <- df[!duplicated(df[, c("boundary_type", "boundary_name", "description_id")]), ]
  df$field <- sp$field[match(df$description_id, sp$id)]
  df$v <- .num(df$value)
  out <- list()
  for (bt in names(BT_LONG)) {
    sub <- df[df$boundary_type == bt, ]
    lst <- list()
    for (nm in unique(sub$boundary_name)) {
      s <- sub[sub$boundary_name == nm, ]
      o <- list()
      for (f in unique(sp$field)) {
        v <- s$v[s$field == f]
        o[[f]] <- if (!length(v) || all(is.na(v))) NA_real_ else sum(v, na.rm = TRUE)
      }
      o$.name <- nm
      k <- nkey(nm)
      if (!is.null(lst[[k]])) message("    duplicate portal name key ", bt, ": ", nm)
      lst[[k]] <- o
    }
    out[[BT_LONG[[bt]]]] <- lst
    message(sprintf("    %s %-22s %d areas", year, bt, length(lst)))
  }
  out
}

message("[12b] 2011 + 2016: data.winnipeg.ca Census Values (ckim-fid6) …")
P <- list(`2011` = portal_long_year("2011"), `2016` = portal_long_year("2016"))

# =============================================================================
# 2. 2006 from the wide per-topic datasets (trends only).
# =============================================================================
message("[12b] 2006: data.winnipeg.ca Census 2006 population + dwelling …")
BT_06 <- c("Neighbourhood" = "WPG_Nbhd", "Neighbourhood Cluster" = "WPG_Cluster",
           "Community Area" = "WPG_CA")
pop06 <- soda_fetch("bfic-t43j", "census2006_population")
dw06  <- soda_fetch("cem6-ktqa", "census2006_dwelling")
DW06_MAP <- c(households = "dwelling_type_total",
              single_detached = "dwelling_type_single_detached",
              semi_detached = "dwelling_type_semi_detached",
              row_house = "dwelling_type_rowhouse",
              apt_duplex = "dwelling_type_apartment_duplex",
              apt_ge5 = "dwelling_type_apartment_5_storeys",
              apt_lt5 = "dwelling_type_apartment_4_or_less_storeys",
              other_attached = "dwelling_type_other_single_attached",
              movable = "dwelling_type_movable")
P[["2006"]] <- list()
for (bt in names(BT_06)) {
  lst <- list()
  pp <- pop06[pop06$boundary_type == bt, ]
  dd <- dw06[dw06$boundary_type == bt, ]
  for (nm in union(pp$boundary_name, dd$boundary_name)) {
    o <- list(population = .num(pp$population_2006[pp$boundary_name == nm][1]))
    di <- which(dd$boundary_name == nm)[1]
    for (f in names(DW06_MAP)) o[[f]] <- if (is.na(di)) NA_real_ else .num(dd[[DW06_MAP[[f]]]][di])
    o$.name <- nm
    # 2006 names carry the boundary type ("Downtown East Neighbourhood Cluster")
    lst[[nkey(sub("\\s+(Neighbourhood Cluster|Community Area)$", "", nm))]] <- o
  }
  P[["2006"]][[BT_06[[bt]]]] <- lst
  message(sprintf("    2006 %-22s %d areas", bt, length(lst)))
}

# =============================================================================
# 3. 2021 dwelling condition for clusters/CAs: legacy per-cluster/CA .xlsx.
# Not on the Open Data portal (it stops at 2016), and CensusMapper has no
# condition vector, so this one graft still reads legacy.winnipeg.ca as before.
# =============================================================================
fetch_legacy <- function(url_path, key) {
  dest <- file.path(CACHE_LEG, key)
  if (file.exists(dest) && file.info(dest)$size > 8000) return(dest)
  url <- paste0(LEGACY_HOST, gsub(" ", "%20", url_path))
  ok <- tryCatch({ suppressWarnings(download.file(url, dest, mode = "wb", quiet = TRUE)); TRUE },
                 error = function(e) FALSE)
  if (!ok || !file.exists(dest)) return(NA_character_)
  sig <- readBin(dest, "raw", 2)
  is_xlsx <- length(sig) == 2 && sig[1] == as.raw(0x50) && sig[2] == as.raw(0x4B)
  if (file.info(dest)$size < 8000 || !is_xlsx) { unlink(dest); return(NA_character_) }
  dest
}
parse_condition_2021 <- function(path) {
  df <- suppressMessages(read_excel(path, sheet = 1, col_names = FALSE, .name_repair = "minimal"))
  m <- as.data.frame(lapply(df, as.character), stringsAsFactors = FALSE)
  m[is.na(m)] <- ""
  start <- grep("^Dwelling Condition", m[[1]], ignore.case = TRUE)[1]
  after <- function(rx, span) {
    if (is.na(start)) return(NA_real_)
    for (i in (start + 1):min(start + span, nrow(m)))
      if (grepl(rx, m[[1]][i], perl = TRUE, ignore.case = TRUE)) return(.num(m[[i, 2]]))
    NA_real_
  }
  list(condition_ok = after("regular maintenance", 45), condition_major = after("major repairs", 45),
       condition_total = after("^TOTAL", 6))
}
message("[12b] 2021 condition: legacy per-cluster + per-CA .xlsx …")
man <- read.csv(MANIFEST, stringsAsFactors = FALSE, encoding = "UTF-8")
C21 <- list(WPG_Cluster = list(), WPG_CA = list())
for (kind in c("cluster", "ca")) {
  nms <- sort(unique(if (kind == "cluster") man$cluster else man$community_area))
  for (nm in nms) {
    path <- if (kind == "cluster")
      sprintf("/Census/2021/Clusters/%s Neighbourhood Cluster/%s Neighbourhood Cluster.xlsx", nm, nm)
    else sprintf("/Census/2021/Community Area/%s Community Area/%s Community Area.xlsx", nm, nm)
    f <- fetch_legacy(path, sprintf("2021_%s_%s.xlsx", kind, gsub("[^A-Za-z0-9]+", "_", nm)))
    if (is.na(f)) { message("    MISSING 2021 ", kind, ": ", nm); next }
    C21[[if (kind == "cluster") "WPG_Cluster" else "WPG_CA"]][[nkey(nm)]] <- parse_condition_2021(f)
  }
}

# =============================================================================
# 4. Build trend / demo objects in the JSON schema (unchanged field set).
# =============================================================================
TREND_KEYS <- c("single_detached","apt_ge5","apt_lt5","semi_detached","row_house",
                "apt_duplex","movable","other_attached")
rnd <- function(x) if (is.null(x) || length(x) == 0 || !is.finite(x)) NA else round(x)

trend_obj <- function(o) {
  y <- list(population = rnd(o$population), households = rnd(o$households), dwellings = NA)
  for (k in TREND_KEYS) y[[k]] <- rnd(o[[k]])
  y
}
demo_obj <- function(o) {
  # The portal publishes the tenant 30%+ shelter-cost rate directly (share of
  # tenant households with income > 0). Average household size is derived from
  # persons / households: the 2016 portal value is rounded to a whole number.
  avg <- if (is.finite(o$hh_persons %||% NA) && is.finite(o$hh_size_total %||% NA) && o$hh_size_total > 0)
           round(o$hh_persons / o$hh_size_total, 1) else NA
  list(
    population = rnd(o$population), households = rnd(o$households),
    age_0_14 = rnd(o$age_0_14), age_15_64 = rnd(o$age_15_64), age_65_plus = rnd(o$age_65_plus),
    median_age = NA,
    hh_size_total = rnd(o$hh_size_total), hh_size_1 = rnd(o$hh_size_1), hh_size_2 = rnd(o$hh_size_2),
    hh_size_3 = rnd(o$hh_size_3), hh_size_4 = rnd(o$hh_size_4), hh_size_5plus = rnd(o$hh_size_5plus),
    avg_hh_size = avg,
    bed_total = NA, bed_0 = NA, bed_1 = NA, bed_2 = NA, bed_3 = NA, bed_4plus = NA,
    period_total = rnd(o$period_total),
    built_1960 = rnd(o$built_1960), built_1961_1980 = rnd(o$built_1961_1980),
    built_1981_1990 = rnd(o$built_1981_1990), built_1991_2000 = rnd(o$built_1991_2000),
    built_2001_2005 = rnd(o$built_2001_2005), built_2006_2010 = rnd(o$built_2006_2010),
    built_2011_2015 = rnd(o$built_2011_2015 %||% NA), built_2016_2021 = NA,
    tenure_total = rnd(o$tenure_total), owner = rnd(o$owner), renter = rnd(o$renter),
    median_dwelling_val = NA, median_rent = NA, median_ind_income = NA,
    median_hh_income = rnd(o$median_hh_income),
    tenant_stir_30 = rnd(o$tenant_stir_pct),
    # dwelling condition (counts): consumed by the Housing Stock tab, not shown
    # in the Census Profile demographics table.
    condition_ok = rnd(o$condition_ok), condition_major = rnd(o$condition_major),
    condition_total = rnd(o$condition_total))
}

# =============================================================================
# 5. Integrate into census_profile.json.
# =============================================================================
message("[12b] Integrating into census_profile.json …")
doc <- fromJSON(JSON_PATH, simplifyVector = FALSE)
WPG_LEVELS <- c("WPG_Cluster", "WPG_CA", "WPG_Nbhd")
HIST_YEARS <- c("2006", "2011", "2016")

# Flatten the Winnipeg geos' values for the comparison step.
flatten_wpg <- function(d) {
  rows <- list()
  for (r in d$regions) {
    if (!(r$level %in% WPG_LEVELS)) next
    for (sec in c("trends", "demo")) {
      obj <- r[[sec]]
      for (yr in intersect(names(obj), c(HIST_YEARS, "2021"))) {
        vals <- obj[[yr]]
        if (yr == "2021") vals <- vals[intersect(names(vals), c("condition_ok","condition_major","condition_total"))]
        for (f in names(vals)) {
          v <- vals[[f]]
          rows[[length(rows) + 1]] <- data.frame(uid = r$uid, level = r$level, name = r$name,
            section = sec, year = yr, field = f,
            value = if (is.null(v) || !is.numeric(v)) NA_real_ else as.numeric(v),
            stringsAsFactors = FALSE)
        }
      }
    }
  }
  do.call(rbind, rows)
}
old_flat <- flatten_wpg(doc)

# Ensure trends/demo are year-keyed objects (the virtual geos may carry a flat
# 2021 demo); preserve the existing 2021 entry untouched.
as_year_keyed <- function(obj) {
  if (is.null(obj)) return(list())
  if (any(c(HIST_YEARS, "2021") %in% names(obj))) return(obj)
  if (length(obj)) return(list(`2021` = obj))
  list()
}

stats <- list()
used <- list()   # portal keys consumed, per year/level, to report unused portal areas
for (i in seq_along(doc$regions)) {
  r <- doc$regions[[i]]
  if (!(r$level %in% WPG_LEVELS)) next
  key <- nkey(r$name)
  tr <- as_year_keyed(r$trends); dm <- as_year_keyed(r$demo)
  # Drop any earlier-census values first so nothing from the old legacy source
  # survives for an area the portal does not cover.
  tr[HIST_YEARS] <- NULL; dm[HIST_YEARS] <- NULL
  hit <- character(0)
  for (yr in HIST_YEARS) {
    o <- P[[yr]][[r$level]][[key]]
    if (is.null(o)) next
    tr[[yr]] <- trend_obj(o)
    if (yr != "2006") dm[[yr]] <- demo_obj(o)
    hit <- c(hit, yr)
    used[[paste(yr, r$level)]] <- c(used[[paste(yr, r$level)]], key)
  }
  # 2021: keep CensusMapper trends/demographics, only graft in City condition_*.
  if (r$level != "WPG_Nbhd" && !is.null(C21[[r$level]][[key]])) {
    cc <- C21[[r$level]][[key]]
    if (is.null(dm[["2021"]])) dm[["2021"]] <- list()
    dm[["2021"]]$condition_ok    <- rnd(cc$condition_ok)
    dm[["2021"]]$condition_major <- rnd(cc$condition_major)
    dm[["2021"]]$condition_total <- rnd(cc$condition_total)
  }
  doc$regions[[i]]$trends <- tr[order(names(tr))]
  doc$regions[[i]]$demo   <- dm[order(names(dm))]
  for (yr in HIST_YEARS) {
    sk <- paste(r$level, yr)
    stats[[sk]] <- (stats[[sk]] %||% 0) + (yr %in% hit)
  }
  if (!length(hit) && r$level != "WPG_Nbhd") message("    NO portal match for ", r$level, " ", r$name)
}
message("[12b] Regions enriched (level / year: matched of total):")
for (lv in WPG_LEVELS) {
  tot <- sum(vapply(doc$regions, function(r) r$level == lv, logical(1)))
  message(sprintf("    %-11s %s", lv, paste(vapply(HIST_YEARS, function(yr)
    sprintf("%s %d/%d", yr, as.integer(stats[[paste(lv, yr)]] %||% 0), tot), ""), collapse = "  ")))
  for (yr in HIST_YEARS) {
    unused <- setdiff(names(P[[yr]][[lv]]), used[[paste(yr, lv)]])
    if (length(unused)) {
      nm <- vapply(unused, function(k) P[[yr]][[lv]][[k]]$.name, "")
      message(sprintf("      %s portal areas with no region (%d): %s", yr, length(nm),
                      paste(head(nm, 12), collapse = "; ")))
    }
  }
}

# =============================================================================
# 6. Comparison: values already in the JSON vs this run.
# =============================================================================
new_flat <- flatten_wpg(doc)
cmp <- merge(old_flat, new_flat, by = c("uid", "level", "name", "section", "year", "field"),
             all = TRUE, suffixes = c("_old", "_new"))
cmp <- cmp[!(is.na(cmp$value_old) & is.na(cmp$value_new)), ]
cmp$result <- ifelse(is.na(cmp$value_old), "new_filled",
              ifelse(is.na(cmp$value_new), "lost",
              ifelse(abs(cmp$value_old - cmp$value_new) < 1e-9, "match", "diff")))
cmp$diff <- cmp$value_new - cmp$value_old
cmp$pct  <- ifelse(is.finite(cmp$value_old) & cmp$value_old != 0, round(100 * cmp$diff / cmp$value_old, 2), NA)
dir.create(dirname(COMPARE_CSV), recursive = TRUE, showWarnings = FALSE)
write.csv(cmp[order(cmp$level, cmp$name, cmp$year, cmp$section, cmp$field), ],
          COMPARE_CSV, row.names = FALSE)

show_tab <- function(t, title) { message("\n", title); message(paste(capture.output(print(t)), collapse = "\n")) }
lv_yr <- paste(cmp$level, cmp$year, cmp$section)
show_tab(addmargins(table(lv_yr, factor(cmp$result, c("match","diff","new_filled","lost")))),
         "[12b] Comparison by level / year / section (counts of values):")
show_tab(table(paste(cmp$section, cmp$field), factor(cmp$result, c("match","diff","new_filled","lost"))),
         "[12b] Comparison by field:")
d <- cmp[cmp$result == "diff", ]
if (nrow(d)) {
  q <- tapply(abs(d$pct), paste(d$section, d$field), function(x)
    sprintf("median %5.2f%%  p90 %6.2f%%  max %7.2f%%", median(x, na.rm = TRUE),
            quantile(x, 0.9, na.rm = TRUE), max(x, na.rm = TRUE)))
  show_tab(noquote(q), "[12b] Size of differences (|% change|) by field:")
}
message(sprintf("\n[12b] Full comparison: %s (%d rows)", normalizePath(COMPARE_CSV, winslash = "/"), nrow(cmp)))

# =============================================================================
# 7. Provenance + write.
# =============================================================================
# Replace any earlier Winnipeg-history note (legacy wording included) with the
# Open Data credit. Idempotent: r/12b re-reads the JSON on every refresh.
src <- doc$source %||% ""
src <- sub(";\\s*Winnipeg (cluster/community-area|neighbourhood/cluster/community-area) history.*$", "", src)
doc$source <- paste0(src,
  "; Winnipeg neighbourhood/cluster/community-area history (2006/2011/2016) from the City of Winnipeg ",
  "Open Data portal (data.winnipeg.ca, Community Social Data Strategy tabulation of Statistics Canada ",
  "Census data). Contains information licensed under the Open Government Licence – Winnipeg. ",
  "Source: Statistics Canada, Census of Population, reproduced and distributed under the Statistics ",
  "Canada Open Licence. 2021 Winnipeg cluster/community-area dwelling condition from City of Winnipeg ",
  "2021 census profiles")
for (k in c("condition_ok","condition_major","condition_total"))
  if (!(k %in% unlist(doc$demoKeys))) doc$demoKeys <- c(doc$demoKeys, k)

if (DRY_RUN) {
  message("[12b] --dry-run: census_profile.json NOT written.")
} else {
  writeLines(toJSON(doc, auto_unbox = TRUE, na = "null", digits = 10), JSON_PATH, useBytes = TRUE)
  message("[12b] Done. Wrote ", JSON_PATH)
}
