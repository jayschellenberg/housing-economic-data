# =============================================================================
# r/10b_dwelling_types_2016.R
# Add 2016 Census structural type onto web/public/data/housing/dwelling_types.json
# (which r/10 populated with 2021). Structural type is 100%-data, so it lives in
# the 2016 Census Profile (98-316). No CODR cube, and the www12 CPR2016 REST
# service is behind a bot check since 2026-10, so it comes from CensusMapper
# (r/lib/census2016.R; needs CM_API_KEY). Covers Canada + provinces + the
# CMAs/CAs and CSDs already in the JSON. Run AFTER r/10. Census-frequency,
# run-on-demand.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, WEB_DATA
source(file.path(.this_dir, "lib", "census2016.R"))   # 2016 profile via CensusMapper (www12 is bot-blocked)

# --- Merge onto the multi-year JSON ------------------------------------------
json_path <- file.path(WEB_DATA, "housing", "dwelling_types.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)

# CMA + CSD levels only for the provinces the JSON carries them for.
sub_provs <- unique(vapply(Filter(function(a) a$level %in% c("cma", "csd"), doc$areas),
                           function(a) as.character(a$prov), ""))
message(sprintf("[10b] fetching 2016 structural type (CensusMapper CA16) for %d areas...", length(doc$areas)))
tbl2016 <- census2016_fetch(provs = sub_provs, tag = "10b")
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  r <- census2016_row(tbl2016, a$uid, a$level, CA16_TYPES[["total"]])
  if (!is.null(r)) {
    a$census[["2016"]] <- list(total = round(r[[CA16_TYPES[["total"]]]]),
                               types = cleanv(unlist(r[1, CA16_TYPES[-1]], use.names = FALSE)))
    added <<- added + 1
  }
  a
})
message(sprintf("[10b] 2016 added to %d / %d areas", added, length(doc$areas)))

yrs <- unique(unlist(lapply(doc$areas, function(a) names(a$census))))
doc$censusYears <- as.list(sort(yrs, decreasing = TRUE))
doc$typeLabels[["2016"]] <- doc$typeLabels[["2021"]]   # same canonical 8-type order
doc$source <- "Statistics Canada, Census of Population — 2021 (table 98-10-0040) and 2016 (Census Profile 98-316), structural type of dwelling"

writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, na = "null"), json_path, useBytes = TRUE)
message(sprintf("[10b] Wrote %s (years: %s)", json_path, paste(unlist(doc$censusYears), collapse = ", ")))
