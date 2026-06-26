# =============================================================================
# r/18_affordability_sk.R
# Extra inputs for the Affordability tab (beyond MB's census_profile income+rent):
#   - SK (province + CMAs/CAs): median household income — StatsCan cube 98-10-0055
#     ("Median total income of household", 2020; coordinate geo.1.1.1.1.22.1 =
#     Total household dims, income-group member 22 = median, year member 1 = 2020;
#     WDS reorders, so match by echoed coordinate) + CMHC "Average Rent".
#   - MB centres (province + CMAs/CAs): CMHC "Average Rent", to pair with the
#     census MEDIAN rent the tab already has — so MB & SK centre rental factors
#     can both be computed on the comparable CMHC average-rent basis.
# Rent = CMHC Rms "Average Rent", Bedroom Type = Total, latest year.
# Output: web/public/data/economy/affordability_extra.json
# Run-on-demand (census 5-yearly; CMHC rent annual — refresh when convenient).
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, WEB_DATA, cmhc
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr); library(cmhc)
})
`%||%` <- function(a, b) if (is.null(a)) b else a

# SK geographies: province + CMAs/CAs. mid = 98-10-0055 geography memberId;
# code = the 3-digit CMA/CA code (CMHC + census convention). uid = prov+code.
SK <- tibble::tribble(
  ~mid, ~code, ~name,                   ~level,
  111L, "47",  "Saskatchewan",          "PR",
  117L, "725", "Saskatoon (CMA)",       "CMA",
  116L, "705", "Regina (CMA)",          "CMA",
  115L, "745", "Prince Albert (CA)",    "CMA",
  113L, "715", "Moose Jaw (CA)",        "CMA",
  114L, "735", "North Battleford (CA)", "CMA",
  118L, "720", "Swift Current (CA)",    "CMA",
  120L, "710", "Yorkton (CA)",          "CMA",
  112L, "750", "Estevan (CA)",          "CMA",
  119L, "755", "Weyburn (CA)",          "CMA"
)
SK$uid <- ifelse(SK$level == "PR", "47", paste0("47", SK$code))

# --- Median household income (cube 98-10-0055) -------------------------------
PID <- 98100055L; WDS <- "https://www150.statcan.gc.ca/t1/wds/rest"
mkc <- function(geo) sprintf("%d.1.1.1.1.22.1.0.0.0", geo)   # Total dims; income member 22; year member 1 (2020)
coords <- vapply(SK$mid, mkc, character(1))
body <- lapply(coords, function(co) list(productId = PID, coordinate = co, latestN = 1L))
inc <- rep(NA_real_, nrow(SK))
resp <- tryCatch(POST(file.path(WDS, "getDataFromCubePidCoordAndLatestNPeriods"),
                      body = body, encode = "json",
                      add_headers(`Content-Type` = "application/json"), timeout(90)),
                 error = function(e) NULL)
if (!is.null(resp) && status_code(resp) == 200) {
  parsed <- content(resp, as = "parsed", encoding = "UTF-8")
  got <- character(length(parsed)); val <- rep(NA_real_, length(parsed))
  for (k in seq_along(parsed)) {
    p <- parsed[[k]]; got[k] <- as.character(p$object$coordinate %||% NA_character_)
    if (identical(p$status, "SUCCESS")) {
      dp <- p$object$vectorDataPoint
      if (length(dp)) { v <- dp[[length(dp)]]$value; if (!is.null(v) && length(v)) val[k] <- suppressWarnings(as.numeric(v)) }
    }
  }
  inc <- val[match(coords, got)]
}
message(sprintf("[18] SK median income fetched for %d / %d geos", sum(is.finite(inc)), nrow(SK)))

# --- CMHC average rent (Rms, Total bedroom, latest) --------------------------
fetch_rent <- function(uid) {
  df <- tryCatch(cmhc::get_cmhc(survey = "Rms", series = "Average Rent", dimension = "Bedroom Type",
                                breakdown = "Historical Time Periods", geo_uid = uid),
                 error = function(e) NULL)
  if (is.null(df) || !nrow(df)) return(list(rent = NA_real_, year = NA_integer_))
  df <- df %>% mutate(across(where(is.factor), as.character)) %>%
    filter(`Bedroom Type` == "Total", !is.na(Value))
  if (!nrow(df)) return(list(rent = NA_real_, year = NA_integer_))
  df <- df[order(df$Date), ]
  list(rent = as.numeric(tail(df$Value, 1)),
       year = suppressWarnings(as.integer(substr(as.character(tail(df$Date, 1)), 1, 4))))
}
rents <- lapply(SK$code, fetch_rent)
SK$rent     <- vapply(rents, function(x) x$rent, numeric(1))
SK$rentYear <- vapply(rents, function(x) x$year, integer(1))
message(sprintf("[18] SK CMHC rent fetched for %d / %d geos", sum(is.finite(SK$rent)), nrow(SK)))

# --- Manitoba centres: CMHC average rent (keyed by census_profile uid) -------
MB <- tibble::tribble(
  ~uid,    ~code, ~name,
  "46",    "46",  "Manitoba",
  "46602", "602", "Winnipeg",
  "46610", "610", "Brandon",
  "46607", "607", "Portage la Prairie",
  "46605", "605", "Steinbach",
  "46640", "640", "Thompson",
  "46603", "603", "Winkler"
)
mbr <- lapply(MB$code, fetch_rent)
MB$rent     <- vapply(mbr, function(x) x$rent, numeric(1))
MB$rentYear <- vapply(mbr, function(x) x$year, integer(1))
message(sprintf("[18] MB centre CMHC rent fetched for %d / %d", sum(is.finite(MB$rent)), nrow(MB)))

# --- Alberta + British Columbia ----------------------------------------------
# Discover each province's CMAs/CAs from cube 98-10-0055 (names end ", Alta." /
# ", B.C."; province members: Alberta 121, BC 141) and match each to its CMHC
# 3-digit code so rent pairs with income — same basis as SK above.
GEO_MEMBERS <- local({
  j <- tryCatch(POST(file.path(WDS, "getCubeMetadata"),
                     body = toJSON(list(list(productId = PID)), auto_unbox = TRUE),
                     content_type_json(), timeout(60)), error = function(e) NULL)
  if (is.null(j) || status_code(j) != 200) return(NULL)
  Filter(function(d) grepl("geograph", d$dimensionNameEn, ignore.case = TRUE),
         content(j, as = "parsed", encoding = "UTF-8")[[1]]$object$dimension)[[1]]$member
})
cma_code_by_name <- setNames(as.character(CMAS$uid), tolower(CMAS$name))
city_of <- function(nm) {
  s <- nm; p <- regexpr(" (", s, fixed = TRUE); if (p > 0) s <- substr(s, 1, p - 1)
  k <- regexpr(",", s, fixed = TRUE); if (k > 0) s <- substr(s, 1, k - 1); tolower(trimws(s))
}
fetch_income <- function(mids) {
  coords <- vapply(mids, mkc, character(1))
  reqs <- lapply(coords, function(co) list(productId = PID, coordinate = co, latestN = 1L))
  inc <- rep(NA_real_, length(mids))
  resp <- tryCatch(POST(file.path(WDS, "getDataFromCubePidCoordAndLatestNPeriods"),
                        body = reqs, encode = "json",
                        add_headers(`Content-Type` = "application/json"), timeout(90)),
                   error = function(e) NULL)
  if (!is.null(resp) && status_code(resp) == 200) {
    parsed <- content(resp, as = "parsed", encoding = "UTF-8")
    got <- character(length(parsed)); val <- rep(NA_real_, length(parsed))
    for (k in seq_along(parsed)) {
      p <- parsed[[k]]; got[k] <- as.character(p$object$coordinate %||% NA_character_)
      if (identical(p$status, "SUCCESS")) {
        dp <- p$object$vectorDataPoint
        if (length(dp)) { v <- dp[[length(dp)]]$value; if (!is.null(v) && length(v)) val[k] <- suppressWarnings(as.numeric(v)) }
      }
    }
    inc <- val[match(coords, got)]
  }
  inc
}
build_extra <- function(prov_name, suffix, prov_code) {
  if (is.null(GEO_MEMBERS)) return(list())
  rows <- list()
  for (m in GEO_MEMBERS) {
    nm <- m$memberNameEn; is_pr <- identical(nm, prov_name)
    if (!is_pr && !endsWith(nm, suffix)) next
    code <- if (is_pr) prov_code else unname(cma_code_by_name[city_of(nm)])
    rows[[length(rows) + 1]] <- data.frame(
      mid   = as.integer(m$memberId),
      code  = if (length(code) && !is.na(code)) code else NA_character_,
      name  = if (is_pr) prov_name else trimws(sub(suffix, "", nm, fixed = TRUE)),
      level = if (is_pr) "PR" else "CMA",
      uid   = if (is_pr) prov_code else paste0(prov_code, ifelse(length(code) && !is.na(code), code, "")),
      stringsAsFactors = FALSE)
  }
  tbl <- do.call(rbind, rows)
  if (is.null(tbl) || !nrow(tbl)) return(list())
  inc   <- fetch_income(tbl$mid)
  rents <- lapply(tbl$code, function(cd) if (is.na(cd)) list(rent = NA_real_, year = NA_integer_) else fetch_rent(cd))
  tbl$rent     <- vapply(rents, function(x) x$rent, numeric(1))
  tbl$rentYear <- vapply(rents, function(x) x$year, integer(1))
  message(sprintf("[18] %s: %d geos (income %d, rent %d)", prov_name, nrow(tbl),
                  sum(is.finite(inc)), sum(is.finite(tbl$rent))))
  lapply(seq_len(nrow(tbl)), function(i) list(
    uid = tbl$uid[i], name = tbl$name[i], level = tbl$level[i], prov = prov_code,
    income = if (is.finite(inc[i])) round(inc[i]) else NULL, incomeYear = "2021",
    rent = if (is.finite(tbl$rent[i])) round(tbl$rent[i]) else NULL,
    rentYear = if (is.finite(tbl$rentYear[i])) tbl$rentYear[i] else NULL,
    rentSource = "CMHC"))
}
ab_areas <- build_extra("Alberta",          ", Alta.", "48")
bc_areas <- build_extra("British Columbia", ", B.C.",  "59")

# --- Write ------------------------------------------------------------------
sk_areas <- lapply(seq_len(nrow(SK)), function(i) list(
  uid = SK$uid[i], name = SK$name[i], level = SK$level[i], prov = "47",
  income = if (is.finite(inc[i])) round(inc[i]) else NULL,
  incomeYear = "2021",                                   # 2021 Census (2020 income)
  rent = if (is.finite(SK$rent[i])) round(SK$rent[i]) else NULL,
  rentYear = if (is.finite(SK$rentYear[i])) SK$rentYear[i] else NULL,
  rentSource = "CMHC"
))
mb_rent <- lapply(seq_len(nrow(MB)), function(i) list(
  uid = MB$uid[i],
  avgRent  = if (is.finite(MB$rent[i])) round(MB$rent[i]) else NULL,
  rentYear = if (is.finite(MB$rentYear[i])) MB$rentYear[i] else NULL
))
payload <- list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  incomeSource = "Statistics Canada, 2021 Census, table 98-10-0055 (median total household income, 2020)",
  rentSource   = "CMHC Rental Market Survey, average rent (all bedroom types), latest",
  sk = sk_areas,
  ab = ab_areas,
  bc = bc_areas,
  mbCmhcRent = mb_rent
)
out_dir <- file.path(WEB_DATA, "economy"); dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "affordability_extra.json")
writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 6), out_path, useBytes = TRUE)
message(sprintf("[18] Wrote %s (%d SK, %d AB, %d BC areas; %d MB centres)",
                out_path, length(sk_areas), length(ab_areas), length(bc_areas), length(mb_rent)))
