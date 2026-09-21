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
# TWO MODES
# ---------
# The boundaries never move; only the address list does (monthly). So the
# neighbourhood -> cluster -> community-area hierarchy is derived ONCE from the
# polygons and committed as r/lib/wpg_nbhd_hierarchy.csv, and the routine
# rebuild is pure text.
#
#   Rscript r/25_build_wpg_address_index.R
#       Fast path. Fresh addresses joined to the committed hierarchy by
#       neighbourhood name. Needs only jsonlite — no sf, no GDAL — which is why
#       it can run on the monthly GitHub Actions refresh, where sf's system
#       libraries are not installed.
#
#   WPG_ADDR_REBUILD_HIERARCHY=1 Rscript r/25_build_wpg_address_index.R
#       Re-derives the hierarchy from the City's cluster/community-area polygons
#       (point-in-polygon over every address), re-checks the nesting, rewrites
#       the CSV, then builds the index. Needs sf. Run this when the City adds a
#       neighbourhood — the fast path alerts when that happens rather than
#       guessing.
#
# Guards, so an automated run can't quietly publish junk:
#   * unknown neighbourhood names are reported and written to
#     data/wpg_address_new_nbhds.txt for CI to raise an issue;
#   * the index must not shrink materially against the committed one
#     (override with WPG_ADDR_ALLOW_SHRINK=1);
#   * every address is replayed through the written file before the build ends.
#
# Depends on: jsonlite  (plus sf, only in rebuild mode)
# ---------------------------------------------------------------------------

REBUILD_HIERARCHY <- nzchar(Sys.getenv("WPG_ADDR_REBUILD_HIERARCHY"))
ALLOW_SHRINK      <- Sys.getenv("WPG_ADDR_ALLOW_SHRINK", "0") %in% c("1", "true", "TRUE")

suppressPackageStartupMessages({
  need <- c("jsonlite", if (REBUILD_HIERARCHY) "sf")
  for (p in need) {
    if (!requireNamespace(p, quietly = TRUE))
      install.packages(p, repos = "https://cloud.r-project.org")
  }
  library(jsonlite)
  if (REBUILD_HIERARCHY) library(sf)
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

# --- 2. Neighbourhood -> cluster / community area ---------------------------
# Fast path: read the committed hierarchy. Rebuild path: derive it from the
# City's polygons, verify the nesting, and rewrite the CSV.
HIER_CSV <- file.path(repo_root, "r", "lib", "wpg_nbhd_hierarchy.csv")

if (REBUILD_HIERARCHY) {
  message("[boundaries] rebuilding the hierarchy from City polygons")
  bnd <- jsonlite::fromJSON(
    fetch_text(BND_URL, file.path(cache_dir, "wpg_census_boundaries.json"), 1e5),
    simplifyVector = FALSE)

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

  # The whole design leans on neighbourhoods nesting inside one cluster. A
  # breach means the City has changed its geography — stop rather than pick.
  keep <- !is.na(addr$nbhd) & !is.na(addr$cluster) & !is.na(addr$cca)
  nest <- tapply(addr$cluster[keep], addr$nbhd[keep], function(v) length(unique(v)))
  if (any(nest > 1))
    stop("neighbourhood(s) spanning more than one cluster: ",
         paste(names(nest)[nest > 1], collapse = ", "))
  message(sprintf("  nesting OK — all %d neighbourhoods sit in exactly one cluster",
                  length(nest)))

  hier <- unique(data.frame(Neighbourhood = addr$nbhd[keep],
                            Cluster       = addr$cluster[keep],
                            CommunityArea = addr$cca[keep],
                            stringsAsFactors = FALSE))
  # method = "radix" sorts by byte value, ignoring the locale. Without it the
  # row order depends on the machine that ran the build — Windows collation puts
  # "Portage-Ellice" before "Portage & Main", glibc does the opposite — so a
  # local run and the quarterly workflow would flip those rows back and forth,
  # each flip opening a spurious "hierarchy changed" issue.
  hier <- hier[order(hier$Neighbourhood, method = "radix"), , drop = FALSE]
  utils::write.csv(hier, HIER_CSV, row.names = FALSE, na = "")
  message(sprintf("  wrote %s — %d neighbourhoods", basename(HIER_CSV), nrow(hier)))
} else {
  message("[hierarchy]")
  if (!file.exists(HIER_CSV))
    stop("missing ", basename(HIER_CSV), " — run once with ",
         "WPG_ADDR_REBUILD_HIERARCHY=1 to derive it from the City's polygons.")
  hier <- utils::read.csv(HIER_CSV, colClasses = "character", check.names = FALSE)
  message(sprintf("  %d neighbourhoods, %d clusters, %d community areas",
                  nrow(hier), length(unique(hier$Cluster)),
                  length(unique(hier$CommunityArea))))

  lk <- match(addr$nbhd, hier$Neighbourhood)
  addr$cluster <- hier$Cluster[lk]
  addr$cca     <- hier$CommunityArea[lk]
}

# An address with no neighbourhood label (a handful each month) can be placed by
# the rebuild path's geometry but never by the fast path's name join. Drop it in
# BOTH, so the two modes produce byte-identical output and the monthly refresh
# doesn't churn the file depending on which path last ran.
addr$cluster[is.na(addr$nbhd)] <- NA_character_
addr$cca[is.na(addr$nbhd)]     <- NA_character_

# Names the City has started using that the committed hierarchy doesn't cover.
# Those addresses cannot be placed, so they are dropped — but loudly: the flag
# file lets the scheduled refresh raise an issue instead of silently shrinking.
FLAG_PATH <- file.path(repo_root, "data", "wpg_address_new_nbhds.txt")
if (file.exists(FLAG_PATH)) unlink(FLAG_PATH)
unknown <- unique(addr$nbhd[!is.na(addr$nbhd) & is.na(addr$cluster)])
if (length(unknown)) {
  n_addr <- sum(addr$nbhd %in% unknown)
  message(sprintf("  WARNING: %d new neighbourhood name(s) not in the hierarchy (%d addresses): %s",
                  length(unknown), n_addr, paste(unknown, collapse = ", ")))
  dir.create(dirname(FLAG_PATH), recursive = TRUE, showWarnings = FALSE)
  writeLines(c(
    sprintf("%d new City of Winnipeg neighbourhood name(s) (%d addresses) are not in r/lib/wpg_nbhd_hierarchy.csv:",
            length(unknown), n_addr),
    paste0("  - ", unknown),
    "",
    "Those addresses are excluded from web/public/data/geo/wpg_address_index.json.",
    "This self-heals: the quarterly 'Rebuild Winnipeg neighbourhood hierarchy'",
    "workflow (5th of Jan/Apr/Jul/Oct) re-derives the hierarchy from the City's",
    "polygons, and the next refresh picks the addresses up. To fix it sooner, run",
    "that workflow manually, or locally:",
    "  WPG_ADDR_REBUILD_HIERARCHY=1 Rscript r/25_build_wpg_address_index.R  (needs sf)"
  ), FLAG_PATH)
}

drop <- is.na(addr$cluster) | is.na(addr$cca)
if (any(drop)) {
  message(sprintf("  %d addresses unresolved — dropped", sum(drop)))
  addr <- addr[!drop, , drop = FALSE]
}
message(sprintf("  %s addresses resolved", format(nrow(addr), big.mark = ",")))

# --- 3. Intern the area combinations ---------------------------------------
combo <- data.frame(n = addr$nbhd, c = addr$cluster, a = addr$cca, stringsAsFactors = FALSE)
uniq  <- unique(combo)
ckey  <- function(df) do.call(paste, c(unname(as.list(df)), sep = ""))
addr$area <- match(ckey(combo), ckey(uniq)) - 1L      # 0-based for the JSON consumer
areas <- lapply(seq_len(nrow(uniq)), function(i) list(
  if (is.na(uniq$n[i])) NULL else unbox(uniq$n[i]),
  unbox(uniq$c[i]), unbox(uniq$a[i])))
message(sprintf("[areas] %d distinct combinations", length(areas)))

# --- 3b. Collapse duplicate civic addresses --------------------------------
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

# --- 4. Collapse to per-street, per-parity runs ----------------------------
message("[index]")
# Radix again (see the hierarchy sort above): this order becomes the JSON key
# order, so a locale-dependent sort would make the index differ by platform too.
a <- addr[order(addr$street, addr$number, method = "radix"), c("street", "number", "area")]
# split() would re-sort the grouping factor in locale order and undo that, so
# pin the levels to the order `a` is already in.
by_street <- split(seq_len(nrow(a)), factor(a$street, levels = unique(a$street)))

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

# --- 4b. Shrink guard ------------------------------------------------------
# A partial Socrata response would otherwise publish a thinned index that still
# passes the round-trip check (it is self-consistent, just smaller). Compare
# against the committed file and refuse a material drop.
SHRINK_TOLERANCE <- 0.02          # 2% fewer streets is already suspicious
if (file.exists(out_json)) {
  prev <- tryCatch(jsonlite::fromJSON(out_json, simplifyVector = FALSE),
                   error = function(e) NULL)
  prev_n <- if (is.null(prev$streets)) 0L else length(prev$streets)
  if (prev_n > 0 && length(streets) < prev_n * (1 - SHRINK_TOLERANCE)) {
    msg <- sprintf("street count fell from %d to %d (%.1f%%) — refusing to publish",
                   prev_n, length(streets), (1 - length(streets) / prev_n) * 100)
    if (ALLOW_SHRINK) message("  WARNING: ", msg, " [overridden by WPG_ADDR_ALLOW_SHRINK]")
    else stop(msg, ". Re-run with WPG_ADDR_ALLOW_SHRINK=1 if the drop is real.")
  }
  message(sprintf("  streets: %d previously, %d now", prev_n, length(streets)))
}

# --- 5. Write --------------------------------------------------------------
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

# --- 6. Self-check: replay every address through the written index ---------
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
