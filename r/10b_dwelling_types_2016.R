# =============================================================================
# r/10b_dwelling_types_2016.R
# Add 2016 Census structural type onto web/public/data/housing/dwelling_types.json
# (which r/10 populated with 2021). Structural type is 100%-data, so it lives in
# the 2016 Census Profile (98-316) — pulled per-area from the CPR2016 REST
# service (no CODR cube). Covers Canada + provinces + the MB/SK CMAs/CAs already
# in the JSON. Run AFTER r/10. Census-frequency, run-on-demand.
#
# CPR2016 structural-type TEXT_IDs (verified live): 3000 = total; the eight leaf
# types map to our canonical order as 3001/3004/3005/3006/3007/3002/3008/3009
# (3003 "Other attached dwelling" is a subtotal we skip).
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
`%||%` <- function(a, b) if (is.null(a)) b else a

# Canonical 8-type order (same as r/10) → CPR2016 TEXT_IDs.
TYPE_TEXT_IDS_2016 <- c(3001L,  # Single-detached house
                        3004L,  # Semi-detached house
                        3005L,  # Row house
                        3006L,  # Apartment or flat in a duplex
                        3007L,  # Apartment, building with fewer than five storeys
                        3002L,  # Apartment, building with five or more storeys
                        3008L,  # Other single-attached house
                        3009L)  # Movable dwelling

# DGUID candidates per area. CMAs and census agglomerations share level "cma"
# in our JSON but use different 2016 DGUID schemas (S0503 = CMA, S0504 = CA), so
# try both and keep whichever returns data.
dguid_2016 <- function(uid, level) {
  if (level == "country")       "2016A000011124"
  else if (level == "province") paste0("2016A0002", uid)
  else if (level == "cma")      c(paste0("2016S0503", uid), paste0("2016S0504", uid))
  else                          paste0("2016A0005", uid)   # csd
}

fetch_one_2016 <- function(dguid) {
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
      total <- num(3000L)
      if (!is.finite(total) || total <= 0) return(NULL)
      return(list(total = total, types = vapply(TYPE_TEXT_IDS_2016, num, numeric(1))))
    }
    Sys.sleep(1)
  }
  NULL
}

# Try each DGUID candidate (CMA schema, then CA schema) until one returns data.
fetch_2016 <- function(uid, level) {
  for (dg in dguid_2016(uid, level)) {
    res <- fetch_one_2016(dg)
    if (!is.null(res)) return(res)
  }
  NULL
}

# --- Merge onto the multi-year JSON ------------------------------------------
json_path <- file.path(WEB_DATA, "housing", "dwelling_types.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)

message(sprintf("[10b] fetching 2016 structural type for %d areas...", length(doc$areas)))
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  b <- fetch_2016(a$uid, a$level)
  Sys.sleep(0.05)
  if (!is.null(b)) {
    a$census[["2016"]] <- list(total = round(b$total), types = cleanv(b$types))
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
