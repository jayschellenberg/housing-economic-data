#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 29_build_wpg_nbhd_context.R — where each Winnipeg neighbourhood / cluster /
# community area sits, for the Census Profile tab's community-profile
# narrative (Phase 3, Winnipeg mode):
#
#   "Daniel McIntyre lies about 3 km west of downtown. It is bounded by
#    Notre Dame Avenue to the north, Arlington Street to the east, …
#    Ellice Avenue runs through the neighbourhood."
#
# Sources:
#   * City of Winnipeg Open Data (Open Government Licence – Winnipeg):
#       Neighbourhoods (Socrata 8k6x-xxsy) — 237 polygons, current;
#       Census Boundaries (re9d-6c9j, year 2016) — 23 clusters, 12 community areas;
#       Road Network (ngsx-caav) — ~17.8k named street segments.
#   * OpenStreetMap (© OpenStreetMap contributors, ODbL) via Overpass —
#     river centrelines and rail lines (the City publishes neither).
#   * r/lib/wpg_arterials.csv — the CURATED list of major thoroughfares
#     (the City's road network carries no functional class). Edit freely.
#
# Method (all in metres, EPSG:26914):
#   Boundary streets — each polygon's boundary is sampled every SAMPLE_M; each
#     sample takes the nearest street within STREET_M, else rail within RAIL_M,
#     else river within RIVER_M. Samples are binned into four sides by their
#     position in the bounding box (normalised); a side is named after the feature holding at
#     least SIDE_SHARE of its samples (else left unnamed).
#   Arterials — "through" when more than THROUGH_M of the arterial lies inside
#     the polygon shrunk by STREET_M (so boundary streets don't count);
#     "near" when within NEAR_M, with the side of the arterial the area lies on.
#   Rivers — within RIVER_NEAR_M of the polygon.
#   Downtown — centroid distance (km) and direction from Portage & Main.
#
# RUN-ONCE / MANUAL (needs sf; downloads cached under r/lib/cache/geo/):
#   Rscript r/29_build_wpg_nbhd_context.R
#
# Output: web/public/data/geo/wpg_nbhd_context.json
#   { source, licence, generatedAt,
#     areas: { "<uid>": { sides:{north,east,south,west}: {name,kind}|null,
#                         through:[name], near:[{name, dir, m}],
#                         rivers:[{name, m}], downtown:{km, dir} } } }
#   uids match census_profile.json: WPG_NB:<name>, WPG_CL:<name>, WPG_CA:<name>.
# ---------------------------------------------------------------------------

suppressMessages({ library(sf); library(jsonlite) })
sf_use_s2(FALSE)

this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
geo_dir   <- file.path(repo_root, "web", "public", "data", "geo")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)

CRS_M        <- 26914
SAMPLE_M     <- 25
STREET_M     <- 40
RAIL_M       <- 60
RIVER_M      <- 150
SIDE_SHARE   <- 0.35
THROUGH_M    <- 300
NEAR_M       <- 1200
RIVER_NEAR_M <- 1000
DOWNTOWN     <- c(-97.1384, 49.8955)     # Portage & Main
BBOX         <- "49.70,-97.40,50.03,-96.93"

cached <- function(name, url, min_bytes = 1e4, post = NULL) {
  f <- file.path(cache_dir, name)
  if (!file.exists(f) || file.size(f) < min_bytes) {
    message("[29] Downloading ", name, "…")
    if (is.null(post)) download.file(url, f, mode = "wb", quiet = TRUE)
    else {
      # Overpass: try each public endpoint in turn (mirrors 502/406 at times;
      # the main instance rejects requests without a user agent).
      ok <- FALSE
      for (u in url) {
        # URL-encoded body (a multipart form post hangs Overpass) + time limit.
        h <- curl::new_handle(useragent = "housing-economic-data r/29", timeout = 300,
                              postfields = paste0("data=", URLencode(post, reserved = TRUE)))
        ok <- tryCatch({ curl::curl_download(u, f, handle = h); TRUE },
                       error = function(e) { message("  ", u, ": ", conditionMessage(e)); FALSE })
        if (ok && file.size(f) >= min_bytes) break
      }
      if (!ok) { unlink(f); stop("[29] Overpass download failed", call. = FALSE) }
    }
  }
  f
}

# --- Polygons -------------------------------------------------------------
nb <- st_read(cached("wpg_neighbourhoods.geojson",
  "https://data.winnipeg.ca/resource/8k6x-xxsy.geojson?$limit=1000"), quiet = TRUE)
nb <- data.frame(uid = paste0("WPG_NB:", nb$name), name = nb$name, geometry = st_geometry(nb)) |> st_as_sf()

cb <- st_read(cached("wpg_census_boundaries_2016.geojson",
  paste0("https://data.winnipeg.ca/resource/re9d-6c9j.geojson?$limit=1000&$where=",
         URLencode("year=2016 AND boundary_type in('Neighbourhood Cluster','CCA')", reserved = TRUE))), quiet = TRUE)
cb$name <- gsub(" - ", "-", cb$boundary_name)
cb <- data.frame(uid = paste0(ifelse(cb$boundary_type == "CCA", "WPG_CA:", "WPG_CL:"), cb$name),
                 name = cb$name, geometry = st_geometry(cb)) |> st_as_sf()
areas <- rbind(nb, cb)
areas <- st_transform(st_make_valid(areas), CRS_M)
message("[29] ", nrow(areas), " areas")

# --- Streets --------------------------------------------------------------
TYPE_WORD <- c(AVE = "Avenue", ST = "Street", RD = "Road", BLVD = "Boulevard", DR = "Drive",
  HWY = "Highway", CRES = "Crescent", PL = "Place", BAY = "Bay", COVE = "Cove", LANE = "Lane",
  WAY = "Way", TRAIL = "Trail", PKY = "Parkway", FWY = "Freeway", CRT = "Court", GATE = "Gate",
  CLOSE = "Close", PK = "Park", PT = "Point", CIR = "Circle", WALK = "Walk", GROVE = "Grove",
  PATH = "Path", ROW = "Row", SQ = "Square", TERR = "Terrace", PROM = "Promenade", LINK = "Link",
  BEND = "Bend", KEY = "Key", GDN = "Garden", GDNS = "Gardens", RIDGE = "Ridge", CROSS = "Cross")
DIR_WORD <- c(N = "North", S = "South", E = "East", W = "West", NW = "Northwest", SW = "Southwest")
pretty_street <- function(name, type, dir, full) {
  n <- ifelse(is.na(name), NA, sub("^St ", "St. ", name))
  t <- ifelse(is.na(type), "", TYPE_WORD[type]); t[is.na(t)] <- ""
  d <- ifelse(is.na(dir), "", DIR_WORD[dir]);    d[is.na(d)] <- ""
  out <- trimws(paste(n, t, d))
  out[grepl("^Perimeter", full)] <- "the Perimeter Highway"
  ifelse(is.na(n), NA, out)
}
rd <- st_read(cached("wpg_road_network.geojson",
  "https://data.winnipeg.ca/resource/ngsx-caav.geojson?$limit=50000", 1e6), quiet = TRUE)
rd <- rd[!is.na(rd$st_name) & rd$type == "STREET", ]
rd$label <- pretty_street(rd$st_name, rd$st_type, rd$st_dir, rd$full_name)
rd <- st_transform(rd[, c("full_name", "label")], CRS_M)
message("[29] ", nrow(rd), " street segments")

# --- OSM rivers + rail ----------------------------------------------------
osm_q <- sprintf('[out:json][timeout:120];(way["waterway"="river"](%s);way["railway"="rail"](%s););out tags geom;', BBOX, BBOX)
osm_f <- cached("wpg_osm_rivers_rail.json",
  c("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"), 1e5, post = osm_q)
osm <- fromJSON(osm_f, simplifyVector = FALSE)$elements
rail_label <- function(t) {
  op <- t$operator %||% ""
  who <- if (grepl("Canadian Pacific", op)) "CPKC " else if (grepl("Canadian National", op)) "CN " else ""
  if (identical(t$service, "yard")) paste0("the ", who, "rail yards") else paste0("the ", who, "rail line")
}
`%||%` <- function(a, b) if (is.null(a)) b else a
lines <- list(); lab <- character(); kind <- character()
for (e in osm) {
  if (length(e$geometry) < 2) next
  t <- e$tags
  if (!is.null(t$waterway)) {
    if (is.null(t$name)) next
    nm <- sub("^Rivière Seine River$", "Seine River", t$name)
    if (grepl("River$", nm)) nm <- paste0("the ", nm)
    k <- "river"
  } else {
    if (!is.null(t$service) && t$service %in% c("spur", "siding", "crossover")) next
    if (identical(t$usage, "tourism")) next
    nm <- rail_label(t); k <- "rail"
  }
  xy <- do.call(rbind, lapply(e$geometry, function(p) c(p$lon, p$lat)))
  lines[[length(lines) + 1]] <- st_linestring(xy); lab <- c(lab, nm); kind <- c(kind, k)
}
osm_sf <- st_transform(st_sf(label = lab, kind = kind, geometry = st_sfc(lines, crs = 4326)), CRS_M)
rivers <- osm_sf[osm_sf$kind == "river", ]; rail <- osm_sf[osm_sf$kind == "rail", ]
major_rivers <- st_union(st_geometry(rivers[rivers$label %in% c("the Red River", "the Assiniboine River"), ]))
message("[29] OSM: ", nrow(rivers), " river ways, ", nrow(rail), " rail ways")

# --- Arterials ------------------------------------------------------------
art_csv <- read.csv(file.path(repo_root, "r", "lib", "wpg_arterials.csv"), stringsAsFactors = FALSE)
arts <- do.call(rbind, lapply(seq_len(nrow(art_csv)), function(i) {
  fn <- strsplit(art_csv$full_names[i], ";", fixed = TRUE)[[1]]
  seg <- rd[rd$full_name %in% fn, ]
  if (!nrow(seg)) { message("  arterial not found: ", art_csv$label[i]); return(NULL) }
  st_sf(label = art_csv$label[i], geometry = st_union(st_geometry(seg)))
}))
# Boundary sides are labelled with the street's own name; map them back to the
# arterial label so a boundary arterial isn't also reported as "near".
art_of_street <- setNames(rep(art_csv$label, lengths(strsplit(art_csv$full_names, ";"))),
                          unlist(strsplit(art_csv$full_names, ";")))

# --- Helpers --------------------------------------------------------------
compass4 <- function(from, to) {
  ang <- (atan2(to[1] - from[1], to[2] - from[2]) * 180 / pi + 360) %% 360
  c("north", "east", "south", "west")[(floor((ang + 45) / 90) %% 4) + 1]
}
compass8 <- function(from, to) {
  ang <- (atan2(to[1] - from[1], to[2] - from[2]) * 180 / pi + 360) %% 360
  c("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest")[(floor((ang + 22.5) / 45) %% 8) + 1]
}
nearest_within <- function(pts, layer, max_m, labcol = "label") {
  i <- st_nearest_feature(pts, layer)
  d <- as.numeric(st_distance(pts, layer[i, ], by_element = TRUE))
  ifelse(d <= max_m, layer[[labcol]][i], NA)
}
street_full <- setNames(rd$full_name, rd$label)
dt <- st_transform(st_sfc(st_point(DOWNTOWN), crs = 4326), CRS_M)
dt_xy <- st_coordinates(dt)[1, 1:2]

# --- Per-area context ------------------------------------------------------
out <- list()
for (a in seq_len(nrow(areas))) {
  poly <- areas[a, ]
  cen  <- st_coordinates(st_centroid(st_geometry(poly)))[1, 1:2]
  ring <- st_cast(st_boundary(st_geometry(poly)), "LINESTRING")
  pts  <- st_cast(st_line_sample(ring, density = 1 / SAMPLE_M), "POINT")
  pts  <- st_sf(geometry = pts)
  # Only the features near this area — keeps the nearest-feature search small.
  win  <- st_buffer(st_geometry(poly), RIVER_M + 50)
  near_rd <- rd[lengths(st_intersects(rd, win)) > 0, ]
  near_rl <- rail[lengths(st_intersects(rail, win)) > 0, ]
  near_rv <- rivers[lengths(st_intersects(rivers, win)) > 0, ]
  lab <- rep(NA_character_, nrow(pts)); knd <- rep(NA_character_, nrow(pts))
  if (nrow(near_rd)) { l <- nearest_within(pts, near_rd, STREET_M); lab <- l; knd[!is.na(l)] <- "street" }
  if (nrow(near_rl)) { l <- nearest_within(pts, near_rl, RAIL_M);  m <- is.na(lab) & !is.na(l); lab[m] <- l[m]; knd[m] <- "rail" }
  if (nrow(near_rv)) { l <- nearest_within(pts, near_rv, RIVER_M); m <- is.na(lab) & !is.na(l); lab[m] <- l[m]; knd[m] <- "river" }
  # Side by position within the bounding box, normalised by its half-width
  # and half-height — a centroid bearing mislabels long, thin areas (the long
  # north edge of an east-west strip would spill into "west").
  pxy  <- st_coordinates(pts)[, 1:2, drop = FALSE]
  bb   <- st_bbox(poly)
  u <- (pxy[, 1] - (bb[["xmin"]] + bb[["xmax"]]) / 2) / max((bb[["xmax"]] - bb[["xmin"]]) / 2, 1)
  v <- (pxy[, 2] - (bb[["ymin"]] + bb[["ymax"]]) / 2) / max((bb[["ymax"]] - bb[["ymin"]]) / 2, 1)
  side <- ifelse(abs(u) >= abs(v), ifelse(u >= 0, "east", "west"), ifelse(v >= 0, "north", "south"))
  sides <- list()
  for (s in c("north", "east", "south", "west")) {
    sel <- side == s
    if (!any(sel)) { sides[s] <- list(NULL); next }
    tb <- sort(table(lab[sel]), decreasing = TRUE)
    if (length(tb) && tb[1] / sum(sel) >= SIDE_SHARE) {
      nm <- names(tb)[1]
      sides[[s]] <- list(name = nm, kind = knd[sel & lab == nm & !is.na(lab)][1])
    } else sides[s] <- list(NULL)
  }
  side_arts <- unique(na.omit(unname(art_of_street[street_full[vapply(sides, function(x) x$name %||% NA_character_, "")]])))

  # Arterials through / near.
  inner <- st_buffer(st_geometry(poly), -STREET_M)
  through <- character(); near <- list()
  cand <- which(lengths(st_intersects(arts, st_buffer(st_geometry(poly), NEAR_M))) > 0)
  for (k in cand) {
    al <- arts$label[k]; if (al %in% side_arts) next
    g <- st_geometry(arts[k, ])
    d <- as.numeric(st_distance(st_geometry(poly), g))
    if (d > NEAR_M) next
    inside <- if (length(inner) && !st_is_empty(inner)) sum(as.numeric(st_length(st_intersection(g, inner)))) else 0
    if (inside > THROUGH_M) { through <- c(through, al); next }
    if (d < STREET_M) next    # only clips a corner or briefly crosses — not a useful "near"
    if (!grepl("^WPG_NB:", poly$uid)) next   # clusters / community areas: too big for "near"
    npt <- st_coordinates(st_cast(st_nearest_points(st_centroid(st_geometry(poly)), g), "POINT"))[2, 1:2]
    dir <- compass4(npt, cen)
    # "East of X" only makes sense across the street, not off its end: read the
    # arterial's local orientation within 500 m of the nearest point.
    loc <- st_bbox(st_intersection(g, st_buffer(st_sfc(st_point(npt), crs = CRS_M), 500)))
    runs_ns <- (loc[["ymax"]] - loc[["ymin"]]) >= (loc[["xmax"]] - loc[["xmin"]])
    if (runs_ns != (dir %in% c("east", "west"))) next
    # Not across a major river ("west of Provencher" from downtown).
    gap <- st_nearest_points(st_geometry(poly), g)
    if (any(lengths(st_intersects(gap, major_rivers)) > 0)) next
    near[[length(near) + 1]] <- list(name = al, dir = dir, m = round(d / 50) * 50)
  }
  if (length(near)) near <- near[order(vapply(near, `[[`, 0, "m"))][seq_len(min(3, length(near)))]

  rv <- list()
  for (rn in unique(rivers$label)) {
    d <- as.numeric(min(st_distance(st_geometry(poly), st_geometry(rivers[rivers$label == rn, ]))))
    if (d <= RIVER_NEAR_M) rv[[length(rv) + 1]] <- list(name = rn, m = round(d / 50) * 50)
  }
  out[[poly$uid]] <- list(
    sides = sides, through = as.list(through), near = near, rivers = rv,
    downtown = list(km = round(sqrt(sum((cen - dt_xy)^2)) / 1000, 1), dir = compass8(dt_xy, cen)))
  if (a %% 25 == 0) message("  ", a, "/", nrow(areas))
}

res <- list(
  source = "City of Winnipeg Open Data (Neighbourhoods 8k6x-xxsy, Census Boundaries re9d-6c9j, Road Network ngsx-caav); OpenStreetMap (rivers, rail); curated arterial list r/lib/wpg_arterials.csv",
  licence = "Open Government Licence – Winnipeg; OpenStreetMap data © OpenStreetMap contributors (ODbL)",
  generatedAt = format(Sys.Date()),
  areas = out[order(names(out), method = "radix")])
f <- file.path(geo_dir, "wpg_nbhd_context.json")
writeLines(toJSON(res, auto_unbox = TRUE, null = "null", digits = NA), f, useBytes = TRUE)
message("[29] wrote ", f, " (", round(file.size(f) / 1024), " KB, ", length(out), " areas)")
