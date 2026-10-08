#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 27_build_csd_highways.R — provincial highways serving each Manitoba
# municipality, for the Census Profile tab's community-profile narrative
# ("Access and roadways": PTH 12 and PTH 52 pass through; PR 311 nearby;
# ~50 km southeast of Winnipeg).
#
# Source: Manitoba Road Network 2023 (Manitoba Transportation and
# Infrastructure, via the Manitoba GeoPortal — Manitoba Open Data Licence).
# Provincial roads only (PTH = Provincial Trunk Highway, PR = Provincial Road);
# ramps, service roads, access roads and municipal roads are dropped. The file
# is a fixed snapshot (~7.8 MB GeoJSON, EPSG:26914), cached under
# r/lib/cache/geo/ (gitignored). RUN-ONCE / MANUAL, like r/20 — no key needed:
#   Rscript r/27_build_csd_highways.R      (or: npm run data:highways, from web/)
#
# Geometry: routes are dissolved by signed number, then intersected with the
# simplified CSD polygons the app already ships (web/public/data/geo/
# mb_csd.geojson, reprojected to 26914) — "through" = the route crosses the
# municipality; "nearby" = closest approach within NEARBY_KM, with distance and
# compass direction from the municipality's centroid. Winnipeg distance is
# boundary-to-boundary (0 = adjoins the city) plus the centroid bearing.
#
# Output: web/public/data/geo/mb_csd_highways.json
#   { source, sourceUrl, licence, generatedAt, nearbyKm,
#     csd: { "<CSDUID>": { through:["PTH 12", …], nearby:[{route, km, dir}],
#                          wpgKm, wpgDir } } }
# ---------------------------------------------------------------------------

suppressMessages({ library(sf); library(jsonlite) })

this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
geo_dir   <- file.path(repo_root, "web", "public", "data", "geo")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)

ROADS_URL  <- "https://geoportal.gov.mb.ca/api/download/v1/items/cb0d37e639ff4382be1033dfdfa962a8/geojson?layers=0"
ROADS_FILE <- file.path(cache_dir, "mb_road_network_2023.geojson")
NEARBY_KM  <- 15
WPG_CSD    <- "4611040"
CRS_M      <- 26914          # NAD83 / UTM 14N — metres, the source CRS

# --- Download (cached) ------------------------------------------------------
if (!file.exists(ROADS_FILE) || file.size(ROADS_FILE) < 1e6) {
  message("[27] Downloading Manitoba Road Network 2023…")
  ok <- tryCatch({ download.file(ROADS_URL, ROADS_FILE, mode = "wb", quiet = TRUE); TRUE },
                 error = function(e) { message("  download failed: ", conditionMessage(e)); FALSE })
  if (!ok || !file.exists(ROADS_FILE)) stop("[27] Could not download the road network", call. = FALSE)
}

# --- Routes: PTH + PR, dissolved by signed number ---------------------------
roads <- st_read(ROADS_FILE, quiet = TRUE)
roads <- st_transform(roads, CRS_M)
roads <- roads[roads$RteType %in% c("-PTH", "-PR"), ]
num <- roads$CommonRoadName_004
# One PTH 1A segment has no signed number — take the leading token of RteName.
num[is.na(num) | !nzchar(num)] <- sub("_.*$", "", roads$RteName[is.na(num) | !nzchar(num)])
roads$route <- paste(ifelse(roads$RteType == "-PTH", "PTH", "PR"), num)
routes <- aggregate(roads[, "route"], by = list(route = roads$route), FUN = function(x) x[1])
routes <- routes[, "route"]
routes <- st_zm(routes)
message(sprintf("[27] %d provincial routes (%d PTH, %d PR)", nrow(routes),
                sum(grepl("^PTH", routes$route)), sum(grepl("^PR", routes$route))))

# Sort key: PTH before PR, then numeric with the letter suffix after ("1" < "1A" < "2").
route_key <- function(r) {
  typ <- ifelse(grepl("^PTH", r), 0, 1)
  n   <- as.numeric(sub("^(PTH|PR) (\\d+).*$", "\\2", r))
  sfx <- sub("^(PTH|PR) \\d+", "", r)
  order(typ, n, sfx)
}

# --- Municipalities ---------------------------------------------------------
csd <- st_read(file.path(geo_dir, "mb_csd.geojson"), quiet = TRUE)
csd <- st_transform(st_make_valid(csd), CRS_M)
wpg <- csd[csd$id == WPG_CSD, ]
cent <- st_centroid(st_geometry(csd))
wpg_cent <- st_centroid(st_geometry(wpg))

compass <- function(from, to) {
  dx <- to[1] - from[1]; dy <- to[2] - from[2]
  ang <- (atan2(dx, dy) * 180 / pi + 360) %% 360      # bearing clockwise from north
  c("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest")[
    floor(((ang + 22.5) %% 360) / 45) + 1]
}

# --- Per-CSD relations ------------------------------------------------------
hits  <- st_intersects(csd, routes)
dists <- st_distance(csd, routes)                     # metres, polygon → line
wpg_d <- as.numeric(st_distance(csd, wpg)[, 1])

out <- list()
for (i in seq_len(nrow(csd))) {
  through <- routes$route[hits[[i]]]
  through <- through[route_key(through)]
  near_i <- setdiff(which(as.numeric(dists[i, ]) <= NEARBY_KM * 1000), hits[[i]])
  nearby <- list()
  if (length(near_i)) {
    near_i <- near_i[order(as.numeric(dists[i, near_i]))]
    for (j in near_i) {
      np <- st_nearest_points(cent[i], routes[j, ])        # centroid → closest point on route
      pt <- st_coordinates(st_cast(np, "POINT"))[2, 1:2]
      nearby[[length(nearby) + 1]] <- list(
        route = routes$route[j],
        km    = round(as.numeric(dists[i, j]) / 1000, 1),
        dir   = compass(st_coordinates(cent[i])[1, 1:2], pt))
    }
  }
  rec <- list(through = as.list(through), nearby = nearby)
  if (csd$id[i] != WPG_CSD) {
    rec$wpgKm  <- round(wpg_d[i] / 1000)
    rec$wpgDir <- compass(st_coordinates(wpg_cent)[1, 1:2], st_coordinates(cent[i])[1, 1:2])
  }
  out[[as.character(csd$id[i])]] <- rec
}

payload <- list(
  source      = "Manitoba Road Network 2023 (Manitoba Transportation and Infrastructure) via Manitoba GeoPortal",
  sourceUrl   = "https://geoportal.gov.mb.ca/datasets/cb0d37e639ff4382be1033dfdfa962a8",
  licence     = "Manitoba Open Data Licence",
  generatedBy = "r/27_build_csd_highways.R",
  generatedAt = format(Sys.Date()),
  nearbyKm    = NEARBY_KM,
  csd         = out
)
dest <- file.path(geo_dir, "mb_csd_highways.json")
writeLines(toJSON(payload, auto_unbox = TRUE, null = "null", digits = 6), dest, useBytes = TRUE)
message(sprintf("[27] Wrote %s (%d municipalities)", dest, length(out)))
