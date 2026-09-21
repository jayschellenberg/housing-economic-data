#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 25_build_wpg_address_index.R — street-range index that resolves a Winnipeg
# street address to the three City-of-Winnipeg geographies the Census Profile
# tab reports on: Neighbourhood / Neighbourhood Cluster / Community Area.
#
# Sources, both City of Winnipeg Open Data (Open Government Licence - Winnipeg):
#   * Addresses (Socrata cam2-ii3u) — ~244k currently-active official addresses
#     with coordinates AND the City's own `neighbourhood` label. Monthly.
#   * Census Boundaries (Socrata re9d-6c9j) — the 23 Neighbourhood Cluster and
#     12 Community Area ("CCA") polygons, 2016 vintage (current boundaries).
#
# WHY THE CITY'S OWN GEOGRAPHY AND NOT A DISSEMINATION-AREA JOIN
# --------------------------------------------------------------
# The obvious alternative is to place each address in its 2021 census DA and
# read the areas off r/lib/wpg_geography_lookup.csv — the same lookup r/12
# aggregates the census numbers from. That was tried and measured; it is worse:
# DAs are coarser than neighbourhoods in newly-built areas, and the lookup
# assigns each DA wholly to one neighbourhood, so addresses in the minority
# part of a straddling DA come out wrong. Measured against the City's own
# address labels, the DA join disagreed for 11.7% of addresses at neighbourhood
# level and 4.1% at CLUSTER level (e.g. 33 Birchbark Bay: the City says
# Templeton-Sinclair / Seven Oaks East, its DA belongs to Rosser-Old Kildonan /
# Seven Oaks West — Templeton-Sinclair has just 7 large DAs, one spilling over).
#
# The City's per-address label is authoritative and finer, so it is used
# directly, and cluster/community area come from point-in-polygon against the
# City's own boundaries. Verified over all 244,175 addresses: every
# neighbourhood falls wholly inside ONE cluster (zero splits), and only 10
# addresses miss every cluster polygon. Cluster and community-area names match
# the app's regions exactly once " - " is normalised to "-" ("St. James -
# Assiniboia West" at the City vs "St. James-Assiniboia West" here).
#
# The census build publishes 211 of the City's 237 neighbourhoods; the other 26
# (~15k addresses: Prairie Pointe, Crestview, Leila North, Bridgwater Lakes,
# Heritage Park, Exchange District, ...) are newer or finer than the 2021 DA
# vintage. They still resolve to a cluster and community area, which do have
# data — the web layer checks each level against the regions it actually has
# rather than this file second-guessing it.
#
# OUTPUT — web/public/data/geo/wpg_address_index.json (~150 KB, ~50 KB gzipped)
#   { generated, vintage, source,
#     areas:   [[neighbourhood|null, cluster, communityArea], ...],
#     streets: { "<NAME TYPE DIR>": <areaIdx>              # whole street, one area
#                                   | [evenRuns, oddRuns] } }   # [[fromNumber, areaIdx], ...]
# Runs are split by parity because boundary streets routinely have their two
# sides in different areas; splitting is both smaller and exact, where a single
# merged sequence interpolates wrongly between the two sides.
#
# The script re-reads its own output and replays every address through it
# before finishing; a single mismatch aborts the build.
#
# Re-run whenever you want new subdivisions picked up — the City refreshes the
# address file monthly:
#   Rscript r/25_build_wpg_address_index.R      (or: npm run data:wpgaddr)
#
# Depends on: sf, jsonlite
# ---------------------------------------------------------------------------

suppressPackageStartupMessages({
  for (p in c("sf", "jsonlite")) {
    if (!requireNamespace(p, quietly = TRUE))
      install.packages(p, repos = "https://cloud.r-project.org")
  }
  library(sf); library(jsonlite)
})

# --- Paths ------------------------------------------------------------------
this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
out_dir   <- file.path(repo_root, "web", "public", "data", "geo")
out_json  <- file.path(out_dir, "wpg_address_index.json")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir,   recursive = TRUE, showWarnings = FALSE)

# --- Config -----------------------------------------------------------------
ADDR_URL <- paste0("https://data.winnipeg.ca/resource/cam2-ii3u.csv",
                   "?$select=street_number,street_name,street_type,street_direction,",
                   "neighbourhood,location&$limit=300000")
# Boundary vintage: 2016 is the current published set for both levels.
BND_URL  <- paste0("https://data.winnipeg.ca/resource/re9d-6c9j.json",
                   "?$select=boundary_type,boundary_name,location&$where=year=2016",
                   "&$limit=500")
# An address that lands in no polygon (river lots, perimeter edges) is snapped to
# the nearest area, but only within this distance; past it the address is
# dropped rather than guessed at. Metres, in EPSG:3347 (StatCan Lambert).
SNAP_LIMIT_M <- 150

# Cluster and community-area names carry spaced hyphens at the City
# ("St. James - Assiniboia West"); the app's regions use the tight form.
norm_name <- function(x) trimws(gsub("\\s+", " ", gsub(" - ", "-", x, fixed = TRUE)))

fetch_text <- function(url, dest, min_bytes) {
  if (file.exists(dest)) unlink(dest)
  message(sprintf("  downloading: %s", sub("\\?.*$", "?...", url)))
  old <- getOption("timeout"); options(timeout = 900); on.exit(options(timeout = old), add = TRUE)
  utils::download.file(url, dest, mode = "wb", quiet = TRUE)
  if (!file.exists(dest) || file.info(dest)$size < min_bytes)
    stop("download looks truncated: ", basename(dest))
  dest
}

# --- 1. Addresses -----------------------------------------------------------
message("[addresses]")
addr_csv <- fetch_text(ADDR_URL, file.path(cache_dir, "wpg_addresses.csv"), 1e6)
addr <- utils::read.csv(addr_csv, colClasses = "character", check.names = FALSE)
message(sprintf("  %s address points", format(nrow(addr), big.mark = ",")))

# Socrata renders the point column as "\n,  \n(lat, lon)".
rx  <- "\\(-?[0-9.]+,\\s*-?[0-9.]+\\)"
has <- grepl(rx, addr$location)
if (any(!has)) message(sprintf("  %d without coordinates — dropped", sum(!has)))
addr <- addr[has, , drop = FALSE]
xy <- do.call(rbind, lapply(
  strsplit(gsub("[()]", "", regmatches(addr$location, regexpr(rx, addr$location))), ",\\s*"),
  as.numeric))
addr$lat <- xy[, 1]; addr$lon <- xy[, 2]

addr$number <- suppressWarnings(as.integer(addr$street_number))
if (any(is.na(addr$number))) {
  message(sprintf("  %d with non-numeric street number — dropped", sum(is.na(addr$number))))
  addr <- addr[!is.na(addr$number), , drop = FALSE]
}

# Street key: "<NAME> <TYPE> <DIRECTION>", blanks collapsed. This is the exact
# string the browser normaliser reconstructs from typed input.
addr$street <- trimws(gsub("\\s+", " ",
  paste(addr$street_name, addr$street_type, addr$street_direction)))

addr$nbhd <- trimws(addr$neighbourhood)
addr$nbhd[!nzchar(addr$nbhd)] <- NA_character_

# --- 2. Cluster + community-area boundaries --------------------------------
message("[boundaries]")
bnd_json <- fetch_text(BND_URL, file.path(cache_dir, "wpg_census_boundaries.json"), 1e5)
bnd <- jsonlite::fromJSON(bnd_json, simplifyVector = FALSE)

as_layer <- function(kind) {
  rows <- Filter(function(r) identical(r$boundary_type, kind), bnd)
  if (!length(rows)) stop("no '", kind, "' features in the boundary file")
  geoms <- lapply(rows, function(r)
    sf::st_geometry(sf::st_read(jsonlite::toJSON(r$location, auto_unbox = TRUE),
                                quiet = TRUE))[[1]])
  sf::st_sf(name = norm_name(vapply(rows, function(r) r$boundary_name, character(1))),
            geometry = sf::st_sfc(geoms, crs = 4326))
}
clusters <- as_layer("Neighbourhood Cluster")
ccas     <- as_layer("CCA")
message(sprintf("  %d clusters, %d community areas", nrow(clusters), nrow(ccas)))

# --- 3. Point-in-polygon ----------------------------------------------------
message("[locate]")
pts <- sf::st_transform(
  sf::st_as_sf(addr, coords = c("lon", "lat"), crs = 4326, remove = FALSE), 3347)

locate <- function(layer, label) {
  layer <- sf::st_transform(sf::st_make_valid(layer), 3347)
  hit <- sf::st_within(pts, layer)
  idx <- vapply(hit, function(i) if (length(i)) i[1] else NA_integer_, integer(1))
  miss <- which(is.na(idx))
  if (length(miss)) {
    near <- sf::st_nearest_feature(pts[miss, ], layer)
    dist <- as.numeric(sf::st_distance(pts[miss, ], layer[near, ], by_element = TRUE))
    ok <- dist <= SNAP_LIMIT_M
    idx[miss[ok]] <- near[ok]
    message(sprintf("  %s: %d outside every polygon — %d snapped (<= %d m), %d unresolved",
                    label, length(miss), sum(ok), SNAP_LIMIT_M, sum(!ok)))
  }
  layer$name[idx]
}
addr$cluster <- locate(clusters, "cluster")
addr$cca     <- locate(ccas,     "community area")

drop <- is.na(addr$cluster) | is.na(addr$cca)
if (any(drop)) {
  message(sprintf("  %d addresses unresolved — dropped", sum(drop)))
  addr <- addr[!drop, , drop = FALSE]
}
message(sprintf("  %s addresses resolved", format(nrow(addr), big.mark = ",")))

# --- 4. Consistency check: neighbourhoods must nest inside one cluster ------
# The whole design leans on this nesting. Report any breach loudly rather than
# silently letting one neighbourhood report two different clusters.
nest <- tapply(addr$cluster, addr$nbhd, function(v) length(unique(v)))
if (any(nest > 1)) {
  bad <- names(nest)[nest > 1]
  message(sprintf("  WARNING: %d neighbourhood(s) span more than one cluster: %s",
                  length(bad), paste(bad, collapse = ", ")))
} else {
  message(sprintf("  nesting OK — all %d neighbourhoods sit in exactly one cluster",
                  length(nest)))
}

# --- 5. Intern the area combinations ---------------------------------------
combo <- data.frame(n = addr$nbhd, c = addr$cluster, a = addr$cca, stringsAsFactors = FALSE)
uniq  <- unique(combo)
ckey  <- function(df) do.call(paste, c(unname(as.list(df)), sep = ""))
addr$area <- match(ckey(combo), ckey(uniq)) - 1L      # 0-based for the JSON consumer
areas <- lapply(seq_len(nrow(uniq)), function(i) list(
  if (is.na(uniq$n[i])) NULL else unbox(uniq$n[i]),
  unbox(uniq$c[i]), unbox(uniq$a[i])))
message(sprintf("[areas] %d distinct combinations", length(areas)))

# --- 5b. Collapse duplicate civic addresses --------------------------------
# Some civic addresses carry several address points (multi-building sites,
# re-surveyed parcels). Where those straddle a boundary they cannot both be
# represented in a street-range index, so take the majority area — ties broken
# by the lowest area index, to keep the build deterministic.
dup_key <- paste(addr$street, addr$number, sep = "")
if (anyDuplicated(dup_key)) {
  rows <- which(dup_key %in% dup_key[duplicated(dup_key)])
  grp  <- split(addr$area[rows], dup_key[rows])
  win  <- vapply(grp, function(v) {
    t <- table(v); min(as.integer(names(t)[t == max(t)]))
  }, integer(1))
  split_n <- sum(vapply(grp, function(v) length(unique(v)) > 1L, logical(1)))
  if (split_n) message(sprintf("  %d civic addresses straddle a boundary — majority area used",
                               split_n))
  addr$area[rows] <- unname(win[dup_key[rows]])
  addr <- addr[!duplicated(dup_key), , drop = FALSE]
  message(sprintf("  %s distinct civic addresses", format(nrow(addr), big.mark = ",")))
}

# --- 6. Collapse to per-street, per-parity runs ----------------------------
message("[index]")
a <- addr[order(addr$street, addr$number), c("street", "number", "area")]
by_street <- split(seq_len(nrow(a)), a$street)

runs_for <- function(rows) {
  # rows are already ordered by number; emit a breakpoint only where the area
  # changes, so the browser can bisect for "last run starting at or below N".
  n <- a$number[rows]; ar <- a$area[rows]
  keep <- c(TRUE, ar[-1] != ar[-length(ar)])
  lapply(which(keep), function(i) list(unbox(n[i]), unbox(ar[i])))
}

streets <- lapply(by_street, function(rows) {
  if (length(unique(a$area[rows])) == 1L) return(unbox(a$area[rows][1]))
  list(runs_for(rows[a$number[rows] %% 2L == 0L]),
       runs_for(rows[a$number[rows] %% 2L == 1L]))
})
n_runs <- sum(vapply(streets, function(s)
  if (inherits(s, "scalar")) 1L else as.integer(length(s[[1]]) + length(s[[2]])), integer(1)))
message(sprintf("  %d streets, %d runs", length(streets), n_runs))

# --- 7. Write --------------------------------------------------------------
doc <- list(
  generated = unbox(format(Sys.Date())),
  vintage   = list(addresses = unbox(format(Sys.Date())), boundaries = unbox("2016")),
  source    = unbox(paste0(
    "Addresses and neighbourhood / cluster / community-area boundaries: ",
    "City of Winnipeg Open Data (Open Government Licence - Winnipeg).")),
  areas     = areas,
  streets   = streets
)
if (file.exists(out_json)) unlink(out_json)
write(jsonlite::toJSON(doc, auto_unbox = FALSE, null = "null", digits = NA), out_json)
message(sprintf("  wrote %s — %.0f KB", basename(out_json), file.info(out_json)$size / 1024))

# --- 8. Self-check: replay every address through the written index ---------
# The index is lossy by design (runs interpolate between listed numbers), so the
# only honest check is to read the file back and confirm it reproduces the area
# for every address that went into it.
message("[verify]")
chk <- jsonlite::fromJSON(out_json, simplifyVector = FALSE)
lookup_area <- function(street, number) {
  e <- chk$streets[[street]]
  if (is.null(e)) return(NA_integer_)
  if (!is.list(e)) return(as.integer(e))
  runs <- e[[if (number %% 2 == 0) 1 else 2]]
  if (!length(runs)) runs <- e[[if (number %% 2 == 0) 2 else 1]]
  if (!length(runs)) return(NA_integer_)
  starts <- vapply(runs, function(r) as.numeric(r[[1]]), numeric(1))
  as.integer(runs[[max(1L, sum(starts <= number))]][[2]])
}
got <- vapply(seq_len(nrow(addr)),
              function(i) lookup_area(addr$street[i], addr$number[i]), integer(1))
bad <- sum(is.na(got) | got != addr$area)
if (bad > 0) stop(sprintf("index self-check FAILED: %d of %d addresses resolve wrongly",
                          bad, nrow(addr)))
message(sprintf("  OK — all %s addresses round-trip correctly",
                format(nrow(addr), big.mark = ",")))
message("Done.")
