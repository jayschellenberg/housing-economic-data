# 2016 Census Profile housing figures via CensusMapper (cancensus, dataset CA16).
#
# Replaces the per-area www12 CPR2016 REST calls r/07 and r/10b used to make:
# since 2026-10 www12.statcan.gc.ca answers scripts with a Cloudflare bot check
# (see r/lib/statcan_download.R). CensusMapper serves the same 2016 profile; it
# was checked against the previously committed REST values — every figure is
# within ±10 (StatCan random-rounds each product independently to multiples of 5).
#
# Needs a CensusMapper API key: CM_API_KEY (run with
# R_ENVIRON_USER=C:/Users/Jason/Documents/.Renviron, as for r/12). One call per
# geography level; the whole western set (~2,100 CSDs) fits the daily quota and
# is cached under CM_CACHE_PATH, so re-runs are free.

if (!requireNamespace("cancensus", quietly = TRUE))
  stop("Package 'cancensus' is required (see r/12_census_profile.R).", call. = FALSE)

# Canonical vector order. Period = total + 7 bands (1960 or before … 2011 to
# 2016); condition = regular-or-minor, major; types follow r/10's 8-type order.
CA16_PERIOD    <- c(total = "v_CA16_4862", sprintf("v_CA16_%d", 4863:4869))
CA16_CONDITION <- c("v_CA16_4871", "v_CA16_4872")
CA16_TYPES     <- c(total = "v_CA16_408",
                    "v_CA16_409",   # Single-detached house
                    "v_CA16_412",   # Semi-detached house
                    "v_CA16_413",   # Row house
                    "v_CA16_414",   # Apartment or flat in a duplex
                    "v_CA16_415",   # Apartment, building with fewer than five storeys
                    "v_CA16_410",   # Apartment, building with five or more storeys
                    "v_CA16_416",   # Other single-attached house
                    "v_CA16_417")   # Movable dwelling

census2016_setup <- function(tag = "census2016") {
  key <- getOption("cancensus.api_key", "")
  if (!nzchar(key)) key <- Sys.getenv("CM_API_KEY", Sys.getenv("CANCENSUS_API_KEY", ""))
  if (!nzchar(key))
    stop(sprintf("[%s] No CensusMapper API key. Run with R_ENVIRON_USER=C:/Users/Jason/Documents/.Renviron (sets CM_API_KEY).", tag),
         call. = FALSE)
  cache <- getOption("cancensus.cache_path", Sys.getenv("CM_CACHE_PATH", ""))
  if (!nzchar(cache) || !dir.exists(cache)) {
    cache <- path.expand("~/cancensus_cache"); dir.create(cache, recursive = TRUE, showWarnings = FALSE)
  }
  options(cancensus.api_key = key, cancensus.cache_path = cache)
}

# One row per area, keyed by our uids: "CA", 2-digit province, 3-digit CMA/CA,
# 7-digit CSD. `provs` limits the CMA + CSD levels (Canada + all provinces always).
census2016_fetch <- function(provs = c("46", "47", "48", "59"), levels = c("C", "PR", "CMA", "CSD"),
                             tag = "census2016") {
  census2016_setup(tag)
  vecs <- unique(c(CA16_PERIOD, CA16_CONDITION, CA16_TYPES))
  get <- function(regions, level) {
    d <- cancensus::get_census("CA16", regions = regions, level = level, vectors = vecs,
                               labels = "short", use_cache = TRUE, quiet = TRUE, geo_format = NA)
    as.data.frame(d[, c("GeoUID", "Dwellings", vecs)], stringsAsFactors = FALSE)
  }
  out <- list()
  if ("C" %in% levels)   { d <- get(list(C = "01"), "C");   d$uid <- "CA"; out$C <- d }
  if ("PR" %in% levels)  { d <- get(list(C = "01"), "PR");  d$uid <- d$GeoUID; out$PR <- d }
  if ("CSD" %in% levels || "CMA" %in% levels) {
    csd <- get(list(PR = provs), "CSD"); csd$uid <- csd$GeoUID
    if ("CSD" %in% levels) out$CSD <- csd
  }
  if ("CMA" %in% levels) {
    cma <- get(list(PR = provs), "CMA")
    # CensusMapper carries no profile values for the smaller, non-tracted census
    # agglomerations ("(D)" — Brandon, Steinbach, Moose Jaw…). Fill those by
    # summing their member CSDs. Members with suppressed values (e.g. a 1-dwelling
    # reserve) are skipped — StatCan's own CA totals exclude them too (North
    # Battleford sums to the published 7,930) — but only while they hold < 5% of
    # the CA's dwellings; otherwise the CA stays empty rather than undercounted.
    miss <- which(is.na(cma[[CA16_TYPES[["total"]]]]))
    if (length(miss)) {
      reg <- cancensus::list_census_regions("CA16", use_cache = TRUE, quiet = TRUE)
      reg <- reg[reg$level == "CSD", c("region", "CMA_UID")]
      filled <- 0L
      for (i in miss) {
        m <- csd[csd$GeoUID %in% reg$region[reg$CMA_UID == cma$GeoUID[i]], , drop = FALSE]
        gap <- !stats::complete.cases(m[, vecs])
        if (nrow(m) && !all(gap) &&
            sum(m$Dwellings[gap], na.rm = TRUE) < 0.05 * sum(m$Dwellings, na.rm = TRUE)) {
          cma[i, vecs] <- colSums(m[!gap, vecs, drop = FALSE]); filled <- filled + 1L
        }
      }
      message(sprintf("[%s] %d/%d CAs without CensusMapper values filled from member CSDs", tag, filled, length(miss)))
    }
    cma$uid <- substr(cma$GeoUID, 3, 5)   # CensusMapper prefixes the province code
    out$CMA <- cma
  }
  for (k in names(out)) out[[k]]$level <- c(C = "country", PR = "province", CMA = "cma", CSD = "csd")[[k]]
  do.call(rbind, lapply(out, function(d) d[, c("uid", "level", vecs)]))
}

# Look up one area's row (NULL if absent or no data for `total_vec`).
census2016_row <- function(tbl, uid, level, total_vec) {
  r <- tbl[tbl$uid == uid & tbl$level == level, , drop = FALSE]
  if (!nrow(r)) return(NULL)
  tot <- r[[total_vec]][1]
  if (!is.finite(tot) || tot <= 0) return(NULL)
  r[1, , drop = FALSE]
}
