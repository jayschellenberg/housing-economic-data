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
# straight-line from the municipality's main town to the city limits, with
# the bearing from Winnipeg; `adjoins` = the municipality touches the city.
#
# Main town: the most populous OpenStreetMap place (city / town / village /
# hamlet) inside the municipality (not on a reserve within it) or inside a
# town, village or city it surrounds —
# so a rural municipality measures from the service town it encloses (RM of
# Dauphin → Dauphin). "Surrounds" = the town lies inside the municipality's
# outer ring or shares at least half its boundary with it (simplified
# boundaries turn some holes into notches: Town of Morris). Population is the
# 2021 Census count — the enclosed municipality's own, else a designated place
# or population centre of that name (r/lib/statcan_places.R) — falling back to
# OSM's population tag, then its place type. No place → polygon centroid.
# Places come from Overpass (© OpenStreetMap contributors, ODbL), cached as
# r/lib/cache/geo/mb_places.json — delete it to refresh.
#
# Output: web/public/data/geo/mb_csd_highways.json
#   { source, sourceUrl, licence, generatedAt, nearbyKm,
#     csd: { "<CSDUID>": { through:["PTH 12", …], nearby:[{route, km, dir}],
#                          wpgKm, wpgDir, adjoins, centre } } }
# ---------------------------------------------------------------------------

suppressMessages({ library(sf); library(jsonlite) })

this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
geo_dir   <- file.path(repo_root, "web", "public", "data", "geo")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
source(file.path(repo_root, "r", "lib", "statcan_places.R"))

ROADS_URL  <- "https://geoportal.gov.mb.ca/api/download/v1/items/cb0d37e639ff4382be1033dfdfa962a8/geojson?layers=0"
ROADS_FILE <- file.path(cache_dir, "mb_road_network_2023.geojson")
NEARBY_KM  <- 15
WPG_CSD    <- "4611040"
CRS_M      <- 26914          # NAD83 / UTM 14N — metres, the source CRS
PLACES_FILE <- file.path(cache_dir, "mb_places.json")
PLACE_RANK  <- c(city = 4, town = 3, village = 2, hamlet = 1)
# Stand-in population by OSM place type when no count is known.
PLACE_POP   <- c(city = 5000, town = 800, village = 150, hamlet = 30)
SHARED_EDGE <- 0.75    # share of a town's boundary on the municipality = surrounded by it
# Hand corrections where the simplified boundaries put a town in the wrong
# municipality: CSD id -> main town name (must be an OpenStreetMap place).
CENTRE_OVERRIDE <- c("4608032" = "Treherne",    # Notre-Dame-de-Lourdes is in Lorne
                     "4621064" = "Flin Flon")    # Channing (a Flin Flon district) outranked the city

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

# --- Main town per municipality (OpenStreetMap places) -----------------------
if (!file.exists(PLACES_FILE) || file.size(PLACES_FILE) < 1e4) {
  message("[27] Downloading OpenStreetMap places (Overpass)…")
  q <- paste0('[out:json][timeout:120];area["ISO3166-2"="CA-MB"]->.mb;',
              'node["place"~"^(city|town|village|hamlet)$"](area.mb);out;')
  download.file(paste0("https://overpass-api.de/api/interpreter?data=", URLencode(q, reserved = TRUE)),
                PLACES_FILE, mode = "wb", quiet = TRUE,
                headers = c("User-Agent" = "housing-economic-data r/27"))
}
el <- fromJSON(PLACES_FILE)$elements
places <- data.frame(name = el$tags$name, place = el$tags$place,
                     pop = suppressWarnings(as.numeric(gsub("[^0-9]", "", el$tags$population))),
                     lon = el$lon, lat = el$lat)
places <- places[!is.na(places$name) & nzchar(places$name), ]
places$rank <- PLACE_RANK[places$place]
places <- st_transform(st_as_sf(places, coords = c("lon", "lat"), crs = 4326), CRS_M)
message(sprintf("[27] %d OpenStreetMap places", nrow(places)))

# Enclaves: other CSDs inside this one's outer ring, or sharing at least
# SHARED_EDGE of their boundary with it (a town an RM surrounds).
filled <- st_sfc(lapply(st_geometry(csd), function(g)
  st_union(st_sfc(lapply(st_cast(st_sfc(g), "POLYGON"), function(p) st_polygon(p[1]))))[[1]]), crs = CRS_M)
inner <- st_within(st_point_on_surface(st_geometry(csd)), filled)
rings <- st_cast(st_geometry(csd), "MULTILINESTRING")
touch <- st_touches(csd)
shared <- function(j, i) {     # share of CSD j's boundary that lies on CSD i
  b <- st_intersection(rings[j], st_buffer(rings[i], 50))
  if (!length(b)) return(0)
  sum(as.numeric(st_length(b))) / as.numeric(st_length(rings[j]))
}
# 2021 Census populations: municipalities (census profile) and named places.
fold <- function(x) gsub("[^a-z]", "", tolower(iconv(x, "UTF-8", "ASCII//TRANSLIT")))
prof <- fromJSON(file.path(repo_root, "web", "public", "data", "housing", "census_profile.json"), simplifyVector = FALSE)$regions
csd_pop <- unlist(lapply(prof, function(r) {
  if (!identical(r$level, "CSD")) return(NULL)
  p <- r$trends[["2021"]]$population
  if (is.null(p)) NULL else setNames(as.numeric(p), r$uid)
}))
ctype <- setNames(vapply(prof, function(r) sub("^.*\\(([^)]+)\\)\\s*$", "\\1", r$name), ""),
                  vapply(prof, function(r) r$uid, ""))[csd$id]
urban <- which(ctype %in% c("T", "VL", "CY"))
# Each place belongs to one municipality: a town / village / city polygon it
# falls in, else the one it sits deepest inside (simplified neighbours overlap
# a little at the line — Notre-Dame-de-Lourdes).
hits_p <- st_intersects(places, csd)
place_csd <- vapply(seq_len(nrow(places)), function(k) {
  h <- hits_p[[k]]
  if (length(h) <= 1) return(if (length(h)) h else NA_integer_)
  u <- intersect(h, urban)
  if (length(u)) return(u[1])
  h[which.max(as.numeric(st_distance(places[k, ], rings[h])))]
}, 1L)
in_csd <- lapply(seq_len(nrow(csd)), function(i) which(place_csd == i))
on_reserve <- unique(unlist(in_csd[which(ctype == "IRI")]))
named <- mb_place_populations(cache_dir, "housing-economic-data r/27")
named <- named[!is.na(named$pop21), ]
named_pop <- tapply(named$pop21, fold(named$geo), max)
centre_of <- function(i) {
  ov <- CENTRE_OVERRIDE[csd$id[i]]
  if (!is.na(ov)) return(places[places$name == ov, ][which.min(as.numeric(st_distance(places[places$name == ov, ], csd[i, ]))), ])
  own <- if (identical(ctype[[i]], "IRI")) in_csd[[i]] else setdiff(in_csd[[i]], on_reserve)
  # Unorganized territory serves no town, whatever lies inside it.
  encl <- if (identical(ctype[[i]], "NO")) integer(0) else intersect(setdiff(which(vapply(inner, function(w) i %in% w, TRUE)), i), urban)
  if (!identical(ctype[[i]], "NO"))
    encl <- union(encl, Filter(function(j) shared(j, i) >= SHARED_EDGE, setdiff(intersect(touch[[i]], urban), encl)))
  cand <- unique(c(own, unlist(in_csd[encl])))
  if (!length(cand)) return(NULL)
  p <- places[cand, ]
  # The enclosed municipality's own count for its namesake place.
  home <- vapply(cand, function(k) {
    j <- encl[vapply(encl, function(j) k %in% in_csd[[j]], TRUE)]
    if (length(j) && fold(csd$name[j[1]]) == fold(places$name[k])) as.numeric(csd_pop[csd$id[j[1]]]) else NA_real_
  }, 0)
  pop <- ifelse(!is.na(home), home, named_pop[fold(p$name)])
  pop <- ifelse(is.na(pop), p$pop, pop)
  # A counted population always outranks a stand-in (OSM tags some hamlets "town").
  known <- !is.na(pop)
  pop <- ifelse(known, pop, PLACE_POP[p$place])
  p[order(-known, -pop, -p$rank, as.numeric(st_distance(p, cent[i]))), ][1, ]
}

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
    town <- centre_of(i)
    from <- if (is.null(town)) cent[i] else st_geometry(town)
    rec$wpgKm   <- round(as.numeric(st_distance(from, wpg)[1, 1]) / 1000)
    rec$wpgDir  <- compass(st_coordinates(wpg_cent)[1, 1:2], st_coordinates(from)[1, 1:2])
    rec$adjoins <- wpg_d[i] < 1
    if (!is.null(town)) rec$centre <- town$name
  }
  out[[as.character(csd$id[i])]] <- rec
}

payload <- list(
  source      = "Manitoba Road Network 2023 (Manitoba Transportation and Infrastructure) via Manitoba GeoPortal; main towns from OpenStreetMap (© OpenStreetMap contributors, ODbL)",
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
