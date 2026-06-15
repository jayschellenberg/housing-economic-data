# =============================================================================
# r/10_dwelling_types.R
# Dwellings by structural type (single-detached, semi, row, apartment <5 / 5+,
# duplex, other-attached, movable) for Canada + provinces + Manitoba &
# Saskatchewan CMAs/CAs. Writes web/public/data/housing/dwelling_types.json
# for the Dwelling Type tab.
#
# 2021 comes from CODR cube 98-10-0040 (Structural type of dwelling and
# household size — the variant that includes CMA/CA geography), via the reliable
# WDS getDataFromCubePidCoord endpoint (responses mapped back by echoed
# coordinate, since WDS does not preserve request order). Earlier censuses
# (2016/2011/2006) come from the StatsCan Census Profile downloads and are added
# by later scripts — the JSON is multi-year from the start.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, WEB_DATA
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})

PID <- 98100040L
WDS <- "https://www150.statcan.gc.ca/t1/wds/rest"
# Structural type members 1=Total, 2..9 = the eight types (cube dimension 2).
TYPE_LABELS <- c("Single-detached house", "Semi-detached house", "Row house",
                 "Apartment or flat in a duplex",
                 "Apartment in a building that has fewer than five storeys",
                 "Apartment in a building that has five or more storeys",
                 "Other single-attached house", "Movable dwelling")   # members 2..9

# 98-10-0040 geography memberId → our uid/name/level. (Canada + 10 provinces +
# MB/SK CMAs/CAs. uid = province SGC code / 3-digit CMA code, matching the
# rental tab's convention.)
AREAS <- tibble::tribble(
  ~mid, ~uid,  ~name,                       ~level,     ~prov,
  1L,   "CA",  "Canada",                    "country",  "CA",
  2L,   "10",  "Newfoundland and Labrador", "province", "10",
  7L,   "11",  "Prince Edward Island",      "province", "11",
  10L,  "12",  "Nova Scotia",               "province", "12",
  16L,  "13",  "New Brunswick",             "province", "13",
  26L,  "24",  "Quebec",                    "province", "24",
  56L,  "35",  "Ontario",                   "province", "35",
  104L, "46",  "Manitoba",                  "province", "46",
  111L, "47",  "Saskatchewan",              "province", "47",
  121L, "48",  "Alberta",                   "province", "48",
  141L, "59",  "British Columbia",          "province", "59",
  110L, "602", "Winnipeg (CMA)",            "cma",      "46",
  105L, "610", "Brandon (CA)",              "cma",      "46",
  106L, "607", "Portage la Prairie (CA)",   "cma",      "46",
  107L, "605", "Steinbach (CA)",            "cma",      "46",
  108L, "640", "Thompson (CA)",             "cma",      "46",
  109L, "603", "Winkler (CA)",              "cma",      "46",
  116L, "705", "Regina (CMA)",              "cma",      "47",
  117L, "725", "Saskatoon (CMA)",           "cma",      "47",
  112L, "750", "Estevan (CA)",              "cma",      "47",
  113L, "715", "Moose Jaw (CA)",            "cma",      "47",
  114L, "735", "North Battleford (CA)",     "cma",      "47",
  115L, "745", "Prince Albert (CA)",        "cma",      "47",
  118L, "720", "Swift Current (CA)",        "cma",      "47",
  119L, "755", "Weyburn (CA)",              "cma",      "47",
  120L, "710", "Yorkton (CA)",              "cma",      "47"
)

# coordinate = geography.structuralType.householdSize(Total) ...
mk <- function(geo, type) sprintf("%d.%d.1.0.0.0.0.0.0.0", geo, type)
reqs <- do.call(rbind, lapply(seq_len(nrow(AREAS)), function(i)
  data.frame(mid = AREAS$mid[i], type = 1:9,
             coordinate = vapply(1:9, function(t) mk(AREAS$mid[i], t), character(1)),
             stringsAsFactors = FALSE)))

fetch_batch <- function(coords) {
  body <- lapply(coords, function(co) list(productId = PID, coordinate = co, latestN = 1L))
  for (attempt in 1:3) {
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
      return(unname(val[match(coords, got)]))
    }
    Sys.sleep(1)
  }
  rep(NA_real_, length(coords))
}
`%||%` <- function(a, b) if (is.null(a)) b else a

message(sprintf("[10] fetching 2021 structural type — %d coords", nrow(reqs)))
reqs$value <- unlist(lapply(split(reqs$coordinate, ceiling(seq_len(nrow(reqs)) / 250)), fetch_batch))

build_area <- function(i) {
  r <- reqs[reqs$mid == AREAS$mid[i], ]; r <- r[order(r$type), ]
  total <- r$value[r$type == 1]
  types <- r$value[r$type %in% 2:9]
  if (!length(total) || !is.finite(total) || total <= 0) return(NULL)
  list(uid = AREAS$uid[i], name = AREAS$name[i], level = AREAS$level[i], prov = AREAS$prov[i],
       census = list("2021" = list(total = round(total),
                                   types = lapply(types, function(v) if (is.finite(v)) round(v) else NA))))
}
areas_out <- Filter(Negate(is.null), lapply(seq_len(nrow(AREAS)), build_area))
message(sprintf("[10] areas with 2021 data: %d", length(areas_out)))

payload <- list(
  source       = "Statistics Canada, 2021 Census of Population, table 98-10-0040 (structural type of dwelling)",
  sourceUrl    = "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810004001",
  censusYears  = list("2021"),
  typeLabels   = list("2021" = as.list(TYPE_LABELS)),
  areas        = areas_out
)
out_dir <- file.path(WEB_DATA, "housing"); dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "dwelling_types.json")
writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null"), out_path, useBytes = TRUE)
message(sprintf("[10] Wrote %s (%d areas)", out_path, length(areas_out)))
