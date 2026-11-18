# StatsCan Web Data Service (WDS) helpers: read a table CELL BY CELL instead of
# downloading it whole.
#
# StatsCan began blocking programmatic full-table downloads in 2026-11
# (cansim::get_cansim and the n1/tbl/csv/<pid>-eng.zip files now sit behind a
# captcha), while the metadata, vector and coordinate endpoints kept working.
# These helpers cover the pattern every converted script needs:
#
#   m <- wds_cube_metadata(32100249)        # dimensions + members
#   geo <- wds_members(m, 1)                 # data frame: memberId, name, code, parent, geoLevel
#   coords <- wds_coordinate(geo$memberId, 1, 2)   # "<geo>.1.2.0.0.0.0.0.0.0"
#   d <- wds_fetch_coords(32100249, coords)  # data frame: coordinate, refPer, value
#
# Every failure stops with an error, so a caller never writes a partial file.
# Needs httr (already used across r/).

suppressPackageStartupMessages(library(httr))

WDS_BASE  <- "https://www150.statcan.gc.ca/t1/wds/rest"
WDS_BATCH <- 250L   # 500 coordinates in one request is rejected (HTTP 416)

.wds_or <- function(a, b) if (is.null(a) || !length(a)) b else a

wds_post <- function(method, body, what = method) {
  for (attempt in 1:3) {
    resp <- tryCatch(POST(file.path(WDS_BASE, method), body = body, encode = "json",
                          add_headers(`Content-Type` = "application/json"), timeout(120)),
                     error = function(e) NULL)
    if (!is.null(resp) && status_code(resp) == 200) {
      parsed <- tryCatch(content(resp, as = "parsed", encoding = "UTF-8"), error = function(e) NULL)
      if (is.list(parsed) && length(parsed)) return(parsed)
    }
    Sys.sleep(2 * attempt)
  }
  stop(sprintf("[wds] %s failed after 3 attempts", what))
}

# Cube metadata object (dimension list etc.) for one product id.
wds_cube_metadata <- function(pid) {
  r <- wds_post("getCubeMetadata", list(list(productId = as.integer(pid))),
                sprintf("metadata for %s", pid))[[1]]
  if (!identical(r$status, "SUCCESS")) stop(sprintf("[wds] metadata for %s: status is not SUCCESS", pid))
  r$object
}

# Members of one dimension (by 1-based position) as a data frame, in table order.
wds_members <- function(meta, position) {
  dim <- Filter(function(d) identical(as.integer(d$dimensionPositionId), as.integer(position)), meta$dimension)
  if (!length(dim)) stop(sprintf("[wds] table has no dimension %d", position))
  m <- dim[[1]]$member
  data.frame(
    memberId = vapply(m, function(x) as.integer(x$memberId), integer(1)),
    name     = vapply(m, function(x) as.character(.wds_or(x$memberNameEn, NA_character_)), character(1)),
    code     = vapply(m, function(x) as.character(.wds_or(x$classificationCode, NA_character_)), character(1)),
    parent   = vapply(m, function(x) as.integer(.wds_or(x$parentMemberId, NA_integer_)), integer(1)),
    geoLevel = vapply(m, function(x) as.integer(.wds_or(x$geoLevel, NA_integer_)), integer(1)),
    stringsAsFactors = FALSE
  )
}

# Build 10-position coordinates; arguments are member ids per dimension, recycled.
wds_coordinate <- function(...) {
  ids <- list(...)
  if (length(ids) > 10L) stop("[wds] a coordinate has at most 10 positions")
  ids <- c(ids, rep(list(0L), 10L - length(ids)))
  do.call(paste, c(lapply(ids, as.integer), sep = "."))
}

# Fetch the latest `latest_n` periods for each coordinate. Returns one row per
# coordinate x period: coordinate, refPer (YYYY-MM-DD), value (NA if suppressed).
# WDS does not preserve request order but echoes each coordinate, so rows are
# keyed by the returned coordinate. A coordinate that comes back without a
# SUCCESS status is an error unless allow_missing = TRUE.
wds_fetch_coords <- function(pid, coords, latest_n = 1L, tag = "wds", allow_missing = FALSE) {
  pid <- as.integer(pid); coords <- unique(as.character(coords))
  n_batches <- ceiling(length(coords) / WDS_BATCH)
  out <- vector("list", n_batches)
  for (b in seq_len(n_batches)) {
    lo <- (b - 1L) * WDS_BATCH + 1L; hi <- min(b * WDS_BATCH, length(coords))
    chunk <- coords[lo:hi]
    body <- lapply(chunk, function(co) list(productId = pid, coordinate = co, latestN = as.integer(latest_n)))
    parsed <- wds_post("getDataFromCubePidCoordAndLatestNPeriods", body,
                       sprintf("table %s batch %d/%d", pid, b, n_batches))
    rows <- lapply(parsed, function(p) {
      if (!identical(p$status, "SUCCESS")) return(NULL)
      dp <- p$object$vectorDataPoint
      co <- as.character(p$object$coordinate)
      if (!length(dp)) return(data.frame(coordinate = co, refPer = NA_character_, value = NA_real_,
                                         stringsAsFactors = FALSE))
      data.frame(
        coordinate = co,
        refPer = vapply(dp, function(x) as.character(.wds_or(x$refPer, NA_character_)), character(1)),
        value  = vapply(dp, function(x) {
          v <- x$value
          if (is.null(v) || !length(v)) return(NA_real_)
          # value is in units of 10^scalarFactorCode
          suppressWarnings(as.numeric(v)) * 10^as.integer(.wds_or(x$scalarFactorCode, 0L))
        }, numeric(1)),
        stringsAsFactors = FALSE
      )
    })
    got <- do.call(rbind, rows)
    missing <- setdiff(chunk, unique(got$coordinate))
    if (length(missing) && !allow_missing)
      stop(sprintf("[%s] table %s batch %d/%d: %d of %d coordinates came back without data (first: %s)",
                   tag, pid, b, n_batches, length(missing), length(chunk), missing[1]))
    out[[b]] <- got
    if (b %% 10 == 0 || b == n_batches)
      message(sprintf("[%s]   table %s batch %d/%d (%d coordinates)", tag, pid, b, n_batches, hi))
    Sys.sleep(0.25)
  }
  do.call(rbind, out)
}
