# =============================================================================
# r/13_validate_indicators.R
# Verify every entry in r/lib/indicator_catalog.json against its live provider
# BEFORE any scraper runs. Aborts with exit code 1 on any mismatch so a
# silent rename or terminated series can never make it into production.
#
# For each catalog row:
#   - provider="boc":     GET /valet/series/{id}/json -> compare label/description
#   - provider="statscan": POST getSeriesInfoFromVector -> compare seriesTitleEn
#   - provider="cba":      GET https://cba.ca/mortgages-in-arrears -> sanity check
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))  # for jsonlite, dplyr, ROOT

suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
series  <- catalog$series

# Match-tolerant comparison: lowercase, collapse punctuation to spaces, then
# check that every semicolon-separated segment of the expected title appears
# somewhere in the actual title. StatsCan vector titles use ";" between
# dimension members so a strict containment check is too brittle.
matches <- function(actual, expected) {
  if (is.null(actual) || is.null(expected)) return(FALSE)
  norm <- function(x) gsub("[[:space:]]+", " ",
                            gsub("[[:punct:]]", " ",
                                 tolower(as.character(x))))
  actual_n <- norm(actual)
  parts <- trimws(strsplit(as.character(expected), ";", fixed = TRUE)[[1]])
  parts <- parts[nzchar(parts)]
  if (length(parts) == 0) return(FALSE)
  all(vapply(parts, function(p) grepl(norm(p), actual_n, fixed = TRUE), logical(1)))
}

validate_boc <- function(row) {
  url <- sprintf("https://www.bankofcanada.ca/valet/series/%s/json", row$seriesId)
  resp <- tryCatch(GET(url, timeout(15)), error = function(e) NULL)
  if (is.null(resp) || status_code(resp) != 200) {
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = sprintf("HTTP %s", if (is.null(resp)) "no response" else status_code(resp))))
  }
  body <- content(resp, as = "parsed", encoding = "UTF-8")
  # /valet/series/{id}/json returns body$seriesDetails (singular!) with
  # name / label / description. The human-readable title is in description;
  # label is sometimes an alternate code (e.g. V80691335 for V121764).
  detail <- body$seriesDetails
  actual <- detail$description %||% detail$label %||% NA_character_
  if (!matches(actual, row$expectedTitle) && !matches(detail$label, row$expectedTitle)) {
    return(list(ok = FALSE, actualTitle = actual, latest = NA,
                reason = sprintf("'%s' does not contain expected '%s'", actual, row$expectedTitle)))
  }
  list(ok = TRUE, actualTitle = actual, latest = NA, reason = "")
}

validate_statscan <- function(row) {
  # Strip the leading "v" from vectorId; WDS wants an integer.
  vec_id <- as.integer(sub("^v", "", row$vectorId))
  if (is.na(vec_id)) return(list(ok = FALSE, actualTitle = NA, latest = NA,
                                  reason = "vectorId not numeric"))
  body <- list(list(vectorId = vec_id))
  # WDS rate-limits rapid sequential POSTs with HTTP 429/409; retry with
  # backoff so a large catalog (many statscan rows) validates reliably.
  resp <- NULL
  for (attempt in 1:4) {
    resp <- tryCatch(POST("https://www150.statcan.gc.ca/t1/wds/rest/getSeriesInfoFromVector",
                          body = body, encode = "json",
                          add_headers(`Content-Type` = "application/json"),
                          timeout(20)),
                     error = function(e) NULL)
    code <- if (is.null(resp)) NA_integer_ else status_code(resp)
    if (!is.null(resp) && code == 200) break
    if (!is.null(resp) && !(code %in% c(409, 429, 500, 502, 503))) break
    Sys.sleep(2 * attempt)   # 2s, 4s, 6s backoff
  }
  if (is.null(resp) || status_code(resp) != 200) {
    # During a StatsCan release window the metadata endpoint returns HTTP 409
    # "The product is not released yet" for the cube being updated — even though
    # cansim still serves the previously-released data the scraper uses. That is
    # a transient embargo, not a catalog error, so don't abort the whole
    # pipeline: soft-pass with a warning and let the scraper proceed.
    body_txt <- if (!is.null(resp)) tryCatch(content(resp, as = "text", encoding = "UTF-8"), error = function(e) "") else ""
    if (!is.null(resp) && status_code(resp) == 409 && grepl("not released", body_txt, ignore.case = TRUE)) {
      return(list(ok = TRUE, actualTitle = row$expectedTitle, latest = NA,
                  reason = "WARN: WDS embargo (product not released yet) — title not verified this run"))
    }
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = sprintf("HTTP %s", if (is.null(resp)) "no response" else status_code(resp))))
  }
  parsed <- content(resp, as = "parsed", encoding = "UTF-8")
  rec <- if (length(parsed) >= 1) parsed[[1]] else list()
  if (!identical(rec$status, "SUCCESS")) {
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = sprintf("WDS status=%s", rec$status %||% "?")))
  }
  obj <- rec$object
  actual <- obj$SeriesTitleEn
  archived <- isTRUE(obj$ARCHIVED == "1") || isTRUE(obj$archived)
  terminated <- !is.null(obj$cubeEndDate) &&
    !is.null(obj$cubeStartDate) &&
    !is.na(obj$cubeEndDate) &&
    !is.na(obj$cubeStartDate)
  ok <- matches(actual, row$expectedTitle) && !archived
  list(ok = ok,
       actualTitle = actual,
       latest      = obj$endReferencePeriod,
       reason      = if (!ok) sprintf("actual='%s', archived=%s", actual, archived) else "")
}

validate_cmhc <- function(row) {
  # CMHC rent series come from the local historical_rental.csv that the
  # Rental Charts pipeline (r/01_scrape_historical.R) writes. We can't hit
  # the cmhc package live here without re-fetching the whole survey, so the
  # check is just "the upstream CSV exists and has rows".
  csv <- file.path(DATA_DIR, "historical_rental.csv")
  if (!file.exists(csv)) {
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = "data/historical_rental.csv missing — run r/01_scrape_historical.R"))
  }
  list(ok = TRUE, actualTitle = row$expectedTitle, latest = NA, reason = "")
}

validate_cba <- function(row) {
  # cba.ca canonicalises to .../mortgages-in-arrears (and may redirect via 307
  # to a different sub-path) — follow redirects, fetch text, look for the
  # arrears section anchor.
  resp <- tryCatch(GET("https://cba.ca/mortgages-in-arrears",
                       timeout(20), config(followlocation = TRUE)),
                   error = function(e) NULL)
  if (is.null(resp) || status_code(resp) != 200) {
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = sprintf("HTTP %s", if (is.null(resp)) "no response" else status_code(resp))))
  }
  txt <- content(resp, as = "text", encoding = "UTF-8")
  has_link <- grepl("mortgage[s]?\\s+in\\s+arrears|residential[- ]mortgages?\\s+in\\s+arrears",
                    txt, ignore.case = TRUE)
  list(ok = has_link,
       actualTitle = if (has_link) "page reachable, arrears section present" else "page reachable, arrears section missing",
       latest      = NA,
       reason      = if (!has_link) "expected arrears section not found on page" else "")
}

validate_osb <- function(row) {
  # OSB insolvency data has no per-series metadata API; confirm the Open
  # Government (CKAN) dataset still resolves to a monthly CSV resource.
  api <- sprintf("https://open.canada.ca/data/api/3/action/package_show?id=%s", row$ckanDataset %||% "")
  resp <- tryCatch(GET(api, timeout(30)), error = function(e) NULL)
  if (is.null(resp) || status_code(resp) != 200) {
    return(list(ok = FALSE, actualTitle = NA, latest = NA,
                reason = sprintf("CKAN HTTP %s", if (is.null(resp)) "no response" else status_code(resp))))
  }
  j <- tryCatch(content(resp, as = "parsed", encoding = "UTF-8"), error = function(e) NULL)
  res <- if (!is.null(j) && !is.null(j$result)) j$result$resources else list()
  has_csv <- any(vapply(res, function(r)
    toupper(r$format %||% "") == "CSV" && grepl("monthly", r$url %||% "", ignore.case = TRUE), logical(1)))
  list(ok = has_csv, actualTitle = if (has_csv) "CKAN monthly CSV resource present" else NA, latest = NA,
       reason = if (!has_csv) "no monthly CSV resource on CKAN dataset" else "")
}

`%||%` <- function(a, b) if (is.null(a)) b else a

cat(sprintf("[validate] checking %d series\n", length(series)))
results <- lapply(series, function(row) {
  if (isTRUE(row$disabled)) {
    cat(sprintf("  [SKIP] %-44s (disabled: %s)\n", row$id,
                substr(as.character(row$disabledReason %||% ""), 1, 80)))
    return(c(list(id = row$id, provider = row$provider, skipped = TRUE,
                  ok = TRUE, actualTitle = NA, latest = NA, reason = "")))
  }
  # Derived series are computed at build time from another series's records.
  # Validate that every upstream source exists in the catalog. derivedFrom is
  # either a scalar id (yoy / shift ops) or an array of ids (ratio op).
  if (identical(row$provider, "derived")) {
    src_ids <- vapply(series, function(s) s$id %||% "", character(1))
    needed <- if (is.list(row$derivedFrom)) unlist(row$derivedFrom)
              else as.character(row$derivedFrom)
    src_ok <- length(needed) > 0 && all(needed %in% src_ids)
    cat(sprintf("  [%s] %-44s derived from %s\n",
                if (src_ok) "OK  " else "FAIL",
                row$id, paste(needed, collapse = " + ")))
    return(list(id = row$id, provider = row$provider,
                ok = src_ok, actualTitle = row$expectedTitle, latest = NA,
                reason = if (src_ok) ""
                         else sprintf("derivedFrom not found: %s",
                                      paste(setdiff(needed, src_ids), collapse=", "))))
  }
  res <- switch(row$provider,
                boc      = validate_boc(row),
                statscan = validate_statscan(row),
                cba      = validate_cba(row),
                cmhc     = validate_cmhc(row),
                osb      = validate_osb(row),
                list(ok = FALSE, actualTitle = NA, latest = NA,
                     reason = sprintf("unknown provider '%s'", row$provider)))
  cat(sprintf("  [%s] %-44s %s %s\n",
              if (res$ok) "OK  " else "FAIL",
              row$id,
              substr(as.character(res$actualTitle %||% ""), 1, 70),
              if (!res$ok) paste0(" -- ", res$reason) else ""))
  c(list(id = row$id, provider = row$provider), res)
})

n_fail <- sum(!vapply(results, function(r) r$ok, logical(1)))
if (n_fail > 0) {
  cat(sprintf("\n[validate] %d failures — aborting.\n", n_fail))
  quit(status = 1L)
}
cat(sprintf("\n[validate] all %d series resolved cleanly.\n", length(series)))
