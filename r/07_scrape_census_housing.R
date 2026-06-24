# =============================================================================
# r/07_scrape_census_housing.R
# 2021 Census housing stock — dwelling condition + period of construction
# (StatsCan table 98-10-0233) for Canada + provinces/territories + every
# Manitoba & Saskatchewan census subdivision. Writes
# web/public/data/housing/census_housing.json for the Housing Stock tab.
#
# The Census is 5-yearly, so this is a run-on-demand generator, NOT part of the
# monthly refresh. Re-run when the next Census housing release lands.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))  # jsonlite, dplyr, WEB_DATA
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})

`%||%` <- function(a, b) if (is.null(a)) b else a
PID <- 98100233L
WDS <- "https://www150.statcan.gc.ca/t1/wds/rest"

# Dimension member ids (fixed in the cube): period 1=Total then 12 bands;
# structural type 1=Total; statistics 1=Number of private households;
# dwelling condition 1=Total,2=Regular,3=Minor,4=Major; tenure 1=Total.
PERIOD_LABELS <- c("1920 or before", "1921 to 1945", "1946 to 1960",
                   "1961 to 1970", "1971 to 1980", "1981 to 1990",
                   "1991 to 1995", "1996 to 2000", "2001 to 2005",
                   "2006 to 2010", "2011 to 2015", "2016 to 2021")  # period ids 2..13
CONDITION_LABELS <- c("Regular maintenance needed", "Minor repairs are needed",
                      "Major repairs needed")                       # condition ids 2..4

# 2016 Census Profile uses coarser bands + a combined condition category. Pulled
# per-area from the CPR2016 REST service (no CODR cube). TEXT_IDs: 27026 = total
# period, 27027..27033 = the 7 bands; 27034 = total condition, 27035/27036 = the
# two condition categories.
PERIOD_LABELS_2016 <- c("1960 or before", "1961 to 1980", "1981 to 1990",
                        "1991 to 2000", "2001 to 2005", "2006 to 2010",
                        "2011 to 2016")
CONDITION_LABELS_2016 <- c("Regular maintenance or minor repairs needed",
                           "Major repairs needed")

# --- 1. Cube metadata: geography members -------------------------------------
message("[07] Fetching cube metadata...")
meta <- content(POST(file.path(WDS, "getCubeMetadata"),
                     body = list(list(productId = PID)), encode = "json",
                     add_headers(`Content-Type` = "application/json"), timeout(120)),
                as = "parsed", encoding = "UTF-8")
geo_dim <- Filter(function(d) grepl("geog", d$dimensionNameEn, ignore.case = TRUE),
                  meta[[1]]$object$dimension)[[1]]
gm <- geo_dim$member
g <- tibble::tibble(
  memberId = vapply(gm, function(m) as.integer(m$memberId), integer(1)),
  name     = vapply(gm, function(m) as.character(m$memberNameEn), character(1)),
  code     = vapply(gm, function(m) as.character(m$classificationCode %||% ""), character(1)),
  level    = vapply(gm, function(m) as.integer(m$geoLevel %||% -1L), integer(1))
)

# --- 2. Area list: Canada + provinces/territories + MB/SK/AB CSDs --------------
areas <- dplyr::bind_rows(
  g %>% dplyr::filter(level == 0) %>% dplyr::mutate(lvl = "country",  prov = "CA"),
  g %>% dplyr::filter(level == 2) %>% dplyr::mutate(lvl = "province", prov = code),
  g %>% dplyr::filter(level == 5, substr(code, 1, 2) %in% c("46", "47", "48")) %>%
        dplyr::mutate(lvl = "csd", prov = substr(code, 1, 2))
) %>% dplyr::arrange(match(lvl, c("country", "province", "csd")), name)
message(sprintf("[07] Areas: %d (Canada + %d provinces + %d MB/SK/AB CSDs)",
                nrow(areas), sum(areas$lvl == "province"), sum(areas$lvl == "csd")))

# --- 3. Coordinates: per area, period 1..13 (age, all-else Total) + condition
#        2..4 (all-else Total). coordinate = geo.period.type.stat.cond.tenure...
mk <- function(geo, period, cond) sprintf("%d.%d.1.1.%d.1.0.0.0.0", geo, period, cond)
reqs <- do.call(rbind, lapply(seq_len(nrow(areas)), function(i) {
  geo <- areas$memberId[i]
  age  <- data.frame(idx = i, kind = "age",  key = 1:13, coordinate = vapply(1:13, function(p) mk(geo, p, 1), character(1)), stringsAsFactors = FALSE)
  cond <- data.frame(idx = i, kind = "cond", key = 2:4,  coordinate = vapply(2:4,  function(c) mk(geo, 1, c), character(1)), stringsAsFactors = FALSE)
  rbind(age, cond)
}))
message(sprintf("[07] Coordinates to fetch: %d (in batches)", nrow(reqs)))

# --- 4. Batch fetch the values -----------------------------------------------
fetch_batch <- function(coords) {
  body <- lapply(coords, function(co) list(productId = PID, coordinate = co, latestN = 1L))
  for (attempt in 1:3) {
    resp <- tryCatch(POST(file.path(WDS, "getDataFromCubePidCoordAndLatestNPeriods"),
                          body = body, encode = "json",
                          add_headers(`Content-Type` = "application/json"), timeout(90)),
                     error = function(e) NULL)
    if (!is.null(resp) && status_code(resp) == 200) {
      parsed <- content(resp, as = "parsed", encoding = "UTF-8")
      # WDS does NOT preserve request order but echoes each coordinate — map
      # values back by the returned coordinate, never by position.
      got <- character(length(parsed)); val <- rep(NA_real_, length(parsed))
      for (k in seq_along(parsed)) {
        p <- parsed[[k]]
        got[k] <- as.character(p$object$coordinate %||% NA_character_)
        if (identical(p$status, "SUCCESS")) {
          dp <- p$object$vectorDataPoint
          if (length(dp)) {
            v <- dp[[length(dp)]]$value
            if (!is.null(v) && length(v)) val[k] <- suppressWarnings(as.numeric(v))
          }
        }
      }
      return(unname(val[match(coords, got)]))
    }
    Sys.sleep(1)
  }
  rep(NA_real_, length(coords))
}

BATCH <- 250L
vals <- rep(NA_real_, nrow(reqs))
n_batches <- ceiling(nrow(reqs) / BATCH)
for (b in seq_len(n_batches)) {
  lo <- (b - 1) * BATCH + 1; hi <- min(b * BATCH, nrow(reqs))
  vals[lo:hi] <- fetch_batch(reqs$coordinate[lo:hi])
  if (b %% 10 == 0 || b == n_batches)
    message(sprintf("[07]   batch %d/%d (%d coords)", b, n_batches, hi))
  Sys.sleep(0.15)
}
reqs$value <- vals

# --- 4b. 2016 Census Profile (per-area REST; coarser bands + combined cond) ---
dguid_2016 <- function(code, lvl) {
  if (lvl == "country")       "2016A000011124"
  else if (lvl == "province") paste0("2016A0002", code)
  else                        paste0("2016A0005", code)   # csd
}
fetch_2016 <- function(dguid) {
  url <- sprintf("https://www12.statcan.gc.ca/rest/census-recensement/CPR2016.json?lang=E&dguid=%s&topic=0&notes=0&stat=0", dguid)
  for (attempt in 1:3) {
    resp <- tryCatch(GET(url, timeout(40)), error = function(e) NULL)
    if (!is.null(resp) && status_code(resp) == 200) {
      txt <- sub("^[^{\\[]*", "", content(resp, as = "text", encoding = "UTF-8"))
      j <- tryCatch(jsonlite::fromJSON(txt, simplifyVector = FALSE), error = function(e) NULL)
      if (is.null(j) || is.null(j$DATA)) return(NULL)
      cols <- unlist(j$COLUMNS); ti <- which(cols == "TEXT_ID"); vi <- which(cols == "T_DATA_DONNEE")
      m <- list(); for (row in j$DATA) m[[as.character(row[[ti]])]] <- row[[vi]]
      num <- function(id) { v <- m[[as.character(id)]]; if (is.null(v)) NA_real_ else suppressWarnings(as.numeric(v)) }
      return(list(total = num(27026),
                  age   = vapply(27027:27033, num, numeric(1)),   # 7 bands
                  cond  = c(num(27035), num(27036))))             # reg-or-minor, major
    }
    Sys.sleep(1)
  }
  NULL
}
message(sprintf("[07] Fetching 2016 Census Profile for %d areas...", nrow(areas)))
prof2016 <- vector("list", nrow(areas))
for (i in seq_len(nrow(areas))) {
  prof2016[[i]] <- fetch_2016(dguid_2016(areas$code[i], areas$lvl[i]))
  if (i %% 100 == 0 || i == nrow(areas)) message(sprintf("[07]   2016 %d/%d", i, nrow(areas)))
  Sys.sleep(0.05)
}
message(sprintf("[07] 2016 areas returned: %d", sum(!vapply(prof2016, is.null, logical(1)))))

# --- 5. Assemble per-area profiles + write JSON ------------------------------
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)
build_area <- function(i) {
  rows <- reqs[reqs$idx == i, ]
  age_all <- rows[rows$kind == "age", ]; age_all <- age_all[order(age_all$key), ]
  total21 <- age_all$value[age_all$key == 1]
  age21   <- age_all$value[age_all$key %in% 2:13]             # 12 bands
  cond_rows <- rows[rows$kind == "cond", ]; cond_rows <- cond_rows[order(cond_rows$key), ]
  cond21  <- cond_rows$value                                  # 3 conditions
  census <- list()
  if (length(total21) && is.finite(total21) && total21 > 0)
    census[["2021"]] <- list(total = round(total21), age = cleanv(age21), condition = cleanv(cond21))
  p16 <- prof2016[[i]]
  if (!is.null(p16) && length(p16$total) && is.finite(p16$total) && p16$total > 0)
    census[["2016"]] <- list(total = round(p16$total), age = cleanv(p16$age), condition = cleanv(p16$cond))
  if (length(census) == 0) return(NULL)
  list(
    uid    = if (areas$lvl[i] == "country") "CA" else areas$code[i],
    name   = areas$name[i],
    level  = areas$lvl[i],
    prov   = areas$prov[i],
    census = census
  )
}
out_areas <- Filter(Negate(is.null), lapply(seq_len(nrow(areas)), build_area))
message(sprintf("[07] Areas with data: %d", length(out_areas)))

payload <- list(
  source          = "Statistics Canada, Census of Population — 2021 (table 98-10-0233) and 2016 (Census Profile)",
  sourceUrl       = "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810023301",
  censusYears     = c("2021", "2016"),
  periodLabels    = list("2021" = PERIOD_LABELS,    "2016" = PERIOD_LABELS_2016),
  conditionLabels = list("2021" = CONDITION_LABELS, "2016" = CONDITION_LABELS_2016),
  areas           = out_areas
)
out_dir <- file.path(WEB_DATA, "housing")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "census_housing.json")
writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null"), out_path, useBytes = TRUE)
message(sprintf("[07] Wrote %s (%d areas)", out_path, length(out_areas)))
