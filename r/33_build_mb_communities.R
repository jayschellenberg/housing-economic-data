#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 33_build_mb_communities.R — facts for the smaller Manitoba communities
# (towns, villages, hamlets inside a municipality), for the Neighbourhood
# (Experimental) tab's community write-ups:
#
#   "Kleefeld is an unincorporated community in the RM of Hanover, about 10 km
#    west of Mitchell and roughly 30 km south of Winnipeg. It lies on PTH 59.
#    Local facilities include a school, a community centre and churches."
#
# Community list: Jason's town and village map sheets (one PDF per sheet,
#   e.g. Blumenort_S1.pdf, Dunnottar_S2_(Matlock).pdf) in COMMUNITY_MAPS_DIR —
#   every distinct name becomes a community.
#
# Sources (all cached under r/lib/cache/geo/, gitignored — delete to refresh):
#   - Canadian Geographical Names Database (NRCan geonames API): location of
#     each community (populated-place records only); OpenStreetMap places as
#     the fallback. Open Government Licence – Canada.
#   - Municipal boundaries: web/public/data/geo/mb_csd.geojson (as r/27).
#   - Municipality main town + highways: web/public/data/geo/mb_csd_highways.json
#     (r/27) and the Manitoba Road Network 2023 cache r/27 downloads.
#   - Facilities: OpenStreetMap via Overpass (© OpenStreetMap contributors,
#     ODbL) — schools, churches, halls, rinks, stores, fuel, health care, etc.
#   - Health care: Statistics Canada Open Database of Healthcare Facilities
#     (ODHF v2, Open Government Licence – Canada) alongside OSM.
#   - Schools to Grade 12: Manitoba Education's "Schools in Manitoba"
#     directory (r/lib/mb_schools.R), matched on the school's mailing town.
#   - Statistics Canada 2021 Census population and dwelling counts for
#     designated places (98-10-0012) and population centres (98-10-0011).
#
# RUN-ONCE / MANUAL (needs sf; run r/27 first):
#   Rscript r/33_build_mb_communities.R
#
# Output: web/scripts/data/mb_communities.json (NOT shipped with the site — the
# input to web/scripts/build-neighbourhood.mjs, which pre-writes the narratives
# into the AppMarketData folder)
#   { generatedAt, communities: [ { id, name, csd, lon, lat, source, ambiguous,
#       isCentre, centre:{name,km,dir}, wpg:{km,dir}, service:{name,km,dir},
#       roads:{on:[…], near:{route,km,dir}}, census:{pop21,pop16,dwell,occ,kind},
#       facilities:{ <group>: [names…] | count, school_hs: [names…] } } ] }
# ---------------------------------------------------------------------------

suppressMessages({ library(sf); library(jsonlite) })
sf_use_s2(FALSE)
options(timeout = 900)   # the province-wide Overpass query takes minutes

this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
geo_dir   <- file.path(repo_root, "web", "public", "data", "geo")
out_dir   <- file.path(repo_root, "web", "scripts", "data")
dir.create(file.path(cache_dir, "cgndb"), recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
source(file.path(repo_root, "r", "lib", "statcan_places.R"))
source(file.path(repo_root, "r", "lib", "mb_schools.R"))

COMMUNITY_MAPS_DIR <- Sys.getenv("COMMUNITY_MAPS_DIR", "D:/Dropbox/Appraisal/Maps/$Town and Village Maps 2026")
CRS_M     <- 26914
WPG_CSD   <- "4611040"
UA        <- c("User-Agent" = "housing-economic-data r/33")
# CGNDB populated-place generic codes, best first.
PLACE_CODES <- c("CITY", "TOWN", "VILG", "UNP", "HAM", "SETL", "MUN1", "MUN2", "IR")
PLACE_RANK  <- c(city = 4, town = 3, village = 2, hamlet = 1)
ROAD_ON_KM  <- 1        # a route this close counts as running through the community
ROAD_NEAR_KM <- 10      # nearest PTH reported within this distance

compass <- function(from, to) {
  dx <- to[1] - from[1]; dy <- to[2] - from[2]
  ang <- (atan2(dx, dy) * 180 / pi + 360) %% 360
  c("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest")[
    floor(((ang + 22.5) %% 360) / 45) + 1]
}
fold <- function(x) {             # accent / case / punctuation-insensitive key
  x <- tolower(iconv(x, "UTF-8", "ASCII//TRANSLIT"))
  x <- gsub("\\bste\\.?[ -]+", "sainte ", x); x <- gsub("\\bst\\.?[ -]+", "saint ", x)
  gsub("[^a-z]", "", x)
}

# --- Community list from the map sheets ---------------------------------------
files <- list.files(COMMUNITY_MAPS_DIR, pattern = "\\.pdf$", ignore.case = TRUE)
if (!length(files)) stop("[33] No map PDFs in ", COMMUNITY_MAPS_DIR, call. = FALSE)
base <- sub("\\.pdf$", "", files, ignore.case = TRUE)
subs <- regmatches(base, regexpr("(?<=_\\().*(?=\\)$)", base, perl = TRUE))
base <- sub("_\\(.*\\)$", "", base)
base <- sub("_(S|Sheet_)\\d+$", "", base)
base <- sub("_(Index_Sheet|\\d{4})$", "", base)
names_raw <- unique(c(gsub("_", " ", base), subs))
names_raw <- unique(trimws(unlist(strsplit(gsub("&amp;", "&", names_raw), " & "))))
ALIAS <- c("Portage" = "Portage la Prairie", "St Laurent" = "St. Laurent",
           "Ste Rose Du Lac" = "Ste. Rose du Lac", "Ile Des Chenes" = "Île-des-Chênes",
           "Grande-Clairiere" = "Grande-Clairière", "Tyndall-Garson" = "Tyndall")
lookup <- ifelse(names_raw %in% names(ALIAS), ALIAS[names_raw], names_raw)
message(sprintf("[33] %d communities from %d map sheets", length(names_raw), length(files)))

# --- Geocode: CGNDB, then OpenStreetMap places --------------------------------
cgndb <- function(q) {
  f <- file.path(cache_dir, "cgndb", paste0(fold(q), ".json"))
  if (!file.exists(f)) {
    url <- paste0("https://geogratis.gc.ca/services/geoname/en/geonames.json?province=46&q=",
                  URLencode(q, reserved = TRUE))
    ok <- tryCatch({ download.file(url, f, mode = "wb", quiet = TRUE, headers = UA); TRUE },
                   error = function(e) FALSE)
    if (!ok) return(NULL)
    Sys.sleep(0.2)
  }
  it <- fromJSON(f)$items
  if (!length(it) || !nrow(it)) return(NULL)
  it <- it[it$concise$code %in% PLACE_CODES & fold(it$name) == fold(q), ]
  if (!nrow(it)) return(NULL)
  it[order(match(it$concise$code, PLACE_CODES)), ]
}
pl <- fromJSON(file.path(cache_dir, "mb_places.json"))$elements
places <- data.frame(name = pl$tags$name, place = pl$tags$place, lon = pl$lon, lat = pl$lat)
places <- places[!is.na(places$name), ]
places$rank <- PLACE_RANK[places$place]

# Candidates per name: settlement records first (a CGNDB name often also has a
# municipality or reserve record — Dauphin the city vs the RM). A name is
# ambiguous only when two settlements share it more than AMBIG_KM apart
# (Blumenort in Hanover and in Rhineland); the map sheet then decides.
SETTLE  <- c("CITY", "TOWN", "VILG", "UNP", "HAM", "SETL")
AMBIG_KM <- 10
spread_km <- function(lat, lon) max(dist(cbind(lat * 111, lon * 71)))
cands <- lapply(seq_along(names_raw), function(i) {
  q <- lookup[i]
  g <- cgndb(q)
  if (!is.null(g)) {
    if (any(g$concise$code %in% SETTLE)) g <- g[g$concise$code %in% SETTLE, ]
    return(data.frame(lon = g$longitude, lat = g$latitude, source = "CGNDB"))
  }
  o <- places[fold(places$name) == fold(q), ]
  if (nrow(o)) return(data.frame(lon = o$lon, lat = o$lat, source = "OSM"))
  message("  not found: ", names_raw[i])
  NULL
})
found <- !vapply(cands, is.null, TRUE)

# --- Municipality, its main town and Winnipeg ---------------------------------
csd <- st_transform(st_make_valid(st_read(file.path(geo_dir, "mb_csd.geojson"), quiet = TRUE)), CRS_M)
wpg <- csd[csd$id == WPG_CSD, ]
wpg_cent <- st_coordinates(st_centroid(st_geometry(wpg)))[1, ]
hw <- fromJSON(file.path(geo_dir, "mb_csd_highways.json"), simplifyVector = FALSE)$csd
# Points just outside the simplified boundary snap to the nearest municipality.
csd_of <- function(lon, lat) {
  p <- st_transform(st_as_sf(data.frame(lon = lon, lat = lat), coords = c("lon", "lat"), crs = 4326), CRS_M)
  hit <- st_intersects(p, csd); near <- st_nearest_feature(p, csd)
  csd$id[vapply(seq_len(nrow(p)), function(i) if (length(hit[[i]])) hit[[i]][1] else near[i], 1L)]
}
# First map sheet of a community, and the municipality its title block names.
sheet_of <- function(nm) {
  pat <- gsub(" ", "_", nm)
  f <- sort(files[startsWith(files, paste0(pat, "_")) | grepl(paste0("_(", nm, ")"), files, fixed = TRUE)])
  if (!length(f)) f <- sort(files[grepl(pat, files, fixed = TRUE)])
  if (length(f)) file.path(COMMUNITY_MAPS_DIR, f[1]) else NA_character_
}
MUNI_PREFIX <- "(rmof|municipalityof|townof|villageof|cityof|lgdof|localgovernmentdistrictof)"
sheet_names_muni <- function(sheet, uid) {
  txt <- tryCatch(fold(paste(pdftools::pdf_text(sheet)[1], collapse = " ")), error = function(e) "")
  grepl(paste0(MUNI_PREFIX, fold(csd$name[csd$id == uid])), txt)
}
rows <- lapply(which(found), function(i) {
  cd <- cands[[i]]
  amb <- nrow(cd) > 1 && spread_km(cd$lat, cd$lon) > AMBIG_KM
  pick <- 1; resolved <- FALSE
  if (amb) {
    uids <- csd_of(cd$lon, cd$lat)
    sheet <- sheet_of(names_raw[i])
    ok <- if (is.na(sheet)) rep(FALSE, nrow(cd)) else vapply(uids, function(u) sheet_names_muni(sheet, u), TRUE)
    if (sum(ok) == 1) { pick <- which(ok); resolved <- TRUE }
  }
  data.frame(name = names_raw[i], lon = cd$lon[pick], lat = cd$lat[pick], source = cd$source[pick],
             ambiguous = amb && !resolved, resolved = resolved)
})
com <- do.call(rbind, rows)
com <- st_transform(st_as_sf(com, coords = c("lon", "lat"), crs = 4326, remove = FALSE), CRS_M)
message(sprintf("[33] located %d of %d; %d same-name places settled by the map sheet, %d still ambiguous",
                nrow(com), length(names_raw), sum(com$resolved), sum(com$ambiguous)))
com$csd <- csd_of(com$lon, com$lat)

places_sf <- st_transform(st_as_sf(places, coords = c("lon", "lat"), crs = 4326), CRS_M)
centre_pt <- function(uid) {     # r/27's main town, located again by name
  nm <- hw[[uid]]$centre
  if (is.null(nm)) return(NULL)
  c_i <- which(places_sf$name == nm)
  if (!length(c_i)) return(NULL)
  c_i[which.min(as.numeric(st_distance(places_sf[c_i, ], csd[csd$id == uid, ])))]
}

# --- Highways ------------------------------------------------------------------
roads <- st_transform(st_read(file.path(cache_dir, "mb_road_network_2023.geojson"), quiet = TRUE), CRS_M)
roads <- roads[roads$RteType %in% c("-PTH", "-PR"), ]
num <- roads$CommonRoadName_004
num[is.na(num) | !nzchar(num)] <- sub("_.*$", "", roads$RteName[is.na(num) | !nzchar(num)])
roads$route <- paste(ifelse(roads$RteType == "-PTH", "PTH", "PR"), num)
routes <- st_zm(aggregate(roads[, "route"], by = list(route = roads$route), FUN = function(x) x[1])[, "route"])
rdist <- st_distance(com, routes) / 1000
route_order <- function(r) order(!grepl("^PTH", r), as.numeric(sub("^\\D+(\\d+).*$", "\\1", r)))

# --- Facilities (OpenStreetMap) ----------------------------------------------------
FAC_FILE <- file.path(cache_dir, "mb_facilities.json")
if (!file.exists(FAC_FILE) || file.size(FAC_FILE) < 1e5) {
  message("[33] Downloading OpenStreetMap facilities (Overpass)…")
  q <- paste0('[out:json][timeout:300];area["ISO3166-2"="CA-MB"]->.mb;(',
    'nwr["amenity"~"^(school|place_of_worship|community_centre|townhall|library|post_office|clinic|doctors|hospital|pharmacy|fire_station|police|fuel|restaurant|cafe|fast_food|bank|bar|pub|nursing_home|social_facility|kindergarten|childcare|arena)$"](area.mb);',
    'nwr["shop"~"^(supermarket|convenience|general|hardware|farm|department_store|doityourself)$"](area.mb);',
    'nwr["leisure"~"^(ice_rink|sports_centre|golf_course|marina|stadium|park)$"](area.mb);',
    'nwr["tourism"~"^(campsite|museum)$"](area.mb);',
    ');out center tags;')
  download.file(paste0("https://overpass-api.de/api/interpreter?data=", URLencode(q, reserved = TRUE)),
                FAC_FILE, mode = "wb", quiet = TRUE, headers = UA)
}
fe <- fromJSON(FAC_FILE)$elements
fx <- ifelse(is.na(fe$lon), fe$center$lon, fe$lon); fy <- ifelse(is.na(fe$lat), fe$center$lat, fe$lat)
tg <- fe$tags
gv <- function(k) if (k %in% names(tg)) tg[[k]] else rep(NA_character_, nrow(fe))
amen <- gv("amenity"); shop <- gv("shop"); leis <- gv("leisure"); tour <- gv("tourism"); sport <- gv("sport")
grp <- rep(NA_character_, nrow(fe))
set <- function(cond, g) grp[is.na(grp) & !is.na(cond) & cond] <<- g
set(amen == "school", "school")
set(amen %in% c("hospital"), "hospital")
set(amen %in% c("clinic", "doctors"), "clinic")
set(amen == "pharmacy", "pharmacy")
set(amen %in% c("nursing_home") | (amen == "social_facility" & gv("social_facility") %in% c("nursing_home", "assisted_living")), "care_home")
set(amen == "place_of_worship", "church")
set(amen %in% c("community_centre", "townhall"), "hall")
set(amen == "library", "library")
set(amen == "post_office", "post_office")
set(amen == "fire_station", "fire_hall")
set(amen == "police", "police")
set(leis %in% c("ice_rink", "stadium") | amen == "arena" | (leis == "sports_centre" & sport %in% c("ice_hockey", "curling", "skating")), "rink")
set(leis == "sports_centre", "recreation")
set(leis == "golf_course", "golf")
set(leis == "marina", "marina")
set(tour == "campsite", "campground")
set(tour == "museum", "museum")
set(leis == "park", "park")
set(shop %in% c("supermarket", "department_store"), "grocery")
set(shop %in% c("convenience", "general"), "store")
set(shop %in% c("hardware", "doityourself", "farm"), "hardware")
set(amen == "fuel", "fuel")
set(amen %in% c("restaurant", "cafe", "fast_food", "bar", "pub"), "restaurant")
set(amen == "bank", "bank")
set(amen %in% c("kindergarten", "childcare"), "childcare")
fac <- data.frame(group = grp, name = gv("name"), x = fx, y = fy, src = "osm")
fac <- fac[!is.na(fac$group) & !is.na(fac$x), ]
fac <- st_transform(st_as_sf(fac, coords = c("x", "y"), crs = 4326), CRS_M)
NAMED <- c("school", "hospital", "care_home", "golf", "museum")
message(sprintf("[33] %d facilities", nrow(fac)))
# Health care from Statistics Canada's Open Database of Healthcare Facilities
# (provincial lists; OSM misses many — Thompson General Hospital, most clinics).
# Rural health centres and hospitals → hospital; medical and First Nations
# clinics → clinic; pharmacies; personal care homes. Public-health offices,
# vaccination sites and ambulance stations are left out.
ODHF_URL  <- "https://www150.statcan.gc.ca/n1/pub/13-26-0001/2020001/zip/odhf_v2_geojson.zip"
ODHF_FILE <- file.path(cache_dir, "odhf_v2.geojson")
if (!file.exists(ODHF_FILE)) {
  message("[33] Downloading the Open Database of Healthcare Facilities…")
  zf <- tempfile(fileext = ".zip")
  download.file(ODHF_URL, zf, mode = "wb", quiet = TRUE, headers = UA)
  unzip(zf, files = "odhf_v2.geojson", exdir = cache_dir)
}
oh <- st_read(ODHF_FILE, quiet = TRUE)
oh <- oh[oh$prov_terr == "MB", ]
og <- ifelse(oh$source_class == "Rural Health Care Facility" & oh$type %in% c("Hospital", "Health Centre"), "hospital",
      ifelse(oh$source_class == "Medical Clinic" | grepl("^First Nation Health Clinic", oh$source_class), "clinic",
      ifelse(oh$source_class == "Pharmacy", "pharmacy",
      ifelse(oh$source_class == "Personal Care Home", "care_home", NA_character_))))
oh <- st_transform(st_sf(group = og, name = oh$name, src = "odhf", geometry = st_geometry(oh))[!is.na(og), ], CRS_M)
fac <- rbind(fac, oh)
message(sprintf("[33] %d health facilities from the ODHF", nrow(oh)))
# Public / First Nations schools that teach Grade 12, by mailing town (the
# service-tier rubric's "school to Grade 12"; OSM has no grade levels).
sch <- mb_school_directory(cache_dir, "housing-economic-data r/33")
sch <- sch[sch$high %in% 12 & !is.na(sch$town), ]
message(sprintf("[33] %d schools to Grade 12 in %d towns", nrow(sch), length(unique(sch$town))))

# --- Census: designated places + population centres -----------------------------
cen <- mb_place_populations(cache_dir, "housing-economic-data r/33")
# Service centres — where residents go for groceries and most services: census
# population centres of SERVICE_MIN_POP+, located by their OpenStreetMap place
# (Winnipeg left out; its distance is stated anyway). The one with the lowest
# km / sqrt(population) wins, so Kleefeld reads Steinbach, not a closer village.
SERVICE_MIN_POP <- 1000
pc <- cen[cen$kind == "population centre" & !is.na(cen$pop21) & cen$pop21 >= SERVICE_MIN_POP & cen$geo != "Winnipeg", ]
pc <- pc[!duplicated(fold(pc$geo)), ]
service_places <- places_sf[!is.na(places_sf$rank) & fold(places_sf$name) %in% fold(pc$geo), ]
service_places <- service_places[!duplicated(fold(service_places$name)), ]
service_places$pop21 <- pc$pop21[match(fold(service_places$name), fold(pc$geo))]
message(sprintf("[33] %d of %d population centres located as service centres", nrow(service_places), nrow(pc)))

# --- Assemble ----------------------------------------------------------------------
out <- vector("list", nrow(com))
for (i in seq_len(nrow(com))) {
  p  <- st_geometry(com)[i]; xy <- st_coordinates(p)[1, ]
  uid <- com$csd[i]; rec <- hw[[uid]]
  # Census match: designated place first, then population centre.
  cm <- cen[fold(cen$geo) == fold(com$name[i]) | fold(cen$geo) == fold(lookup[match(com$name[i], names_raw)]), ]
  cm <- cm[order(cm$kind != "designated place"), ][1, ]
  has_c <- !is.na(cm$pop21)
  # Facilities radius: the census footprint when known, else by place size.
  r_km <- if (has_c && !is.na(cm$area) && cm$area > 0) max(1.5, sqrt(cm$area / pi) + 0.7) else 1.5
  fd <- as.numeric(st_distance(p, fac)[1, ]) / 1000
  fi <- fac[fd <= r_km, ]
  facilities <- list()
  for (g in sort(unique(fi$group))) {
    fg <- fi[fi$group == g, ]
    # OSM and the ODHF overlap: count the fuller list, name from the ODHF first.
    nm <- unique(na.omit(fg$name[fg$src == "odhf"]))
    if (!length(nm)) nm <- unique(na.omit(fg$name))
    facilities[[g]] <- if (g %in% NAMED && length(nm)) I(nm) else max(table(fg$src))
  }
  hs <- sch$name[fold(sch$town) %in% fold(c(com$name[i], lookup[match(com$name[i], names_raw)]))]
  if (length(hs)) facilities$school_hs <- I(sort(unique(hs)))
  # Main town of the municipality (from r/27) — distance and direction.
  ci <- centre_pt(uid)
  centre <- NULL; is_centre <- FALSE
  if (!is.null(ci)) {
    cxy <- st_coordinates(places_sf[ci, ])[1, ]
    km  <- sqrt(sum((cxy - xy)^2)) / 1000
    is_centre <- km < 2 && fold(places_sf$name[ci]) == fold(lookup[match(com$name[i], names_raw)])
    if (!is_centre) centre <- list(name = places_sf$name[ci], km = round(km, 1), dir = compass(cxy, xy))
  }
  # Service centre (see SERVICE_MIN_POP).
  big <- service_places[fold(service_places$name) != fold(com$name[i]), ]
  bd  <- as.numeric(st_distance(p, big)[1, ]) / 1000
  bj  <- which.min(bd / sqrt(big$pop21))
  service <- list(name = big$name[bj], km = round(bd[bj], 1), dir = compass(xy, st_coordinates(big[bj, ])[1, ]))
  # Highways.
  d <- as.numeric(rdist[i, ])
  on <- routes$route[d <= ROAD_ON_KM]; on <- on[route_order(on)]
  pth <- which(grepl("^PTH", routes$route) & d > ROAD_ON_KM & d <= ROAD_NEAR_KM)
  nearr <- NULL
  if (length(pth) && !any(grepl("^PTH", on))) {
    j <- pth[which.min(d[pth])]
    np <- st_coordinates(st_cast(st_nearest_points(p, routes[j, ]), "POINT"))[2, 1:2]
    nearr <- list(route = routes$route[j], km = round(d[j], 1), dir = compass(xy, np))
  }
  wkm <- as.numeric(st_distance(p, wpg)) / 1000
  out[[i]] <- list(
    id = paste0("C:", com$name[i]), name = com$name[i], csd = uid,
    lon = round(com$lon[i], 5), lat = round(com$lat[i], 5),
    source = com$source[i], ambiguous = com$ambiguous[i], isCentre = is_centre,
    centre = centre,
    wpg = if (uid == WPG_CSD) NULL else list(km = round(wkm), dir = compass(wpg_cent, xy)),
    service = service,
    roads = list(on = I(on), near = nearr),
    census = if (has_c) list(pop21 = cm$pop21, pop16 = cm$pop16, dwell = cm$dwell, occ = cm$occ, kind = cm$kind) else NULL,
    facilities = facilities)
}
out <- out[order(vapply(out, `[[`, "", "name"))]
f <- file.path(out_dir, "mb_communities.json")
payload <- list(
  source = paste("Community list: town and village map sheets; locations: Canadian Geographical Names Database",
                 "(NRCan), OpenStreetMap; facilities: OpenStreetMap (© OpenStreetMap contributors, ODbL), Statistics Canada Open Database of Healthcare Facilities;",
                 "highways: Manitoba Road Network 2023; Statistics Canada 2021 Census (98-10-0011, 98-10-0012)"),
  generatedBy = "r/33_build_mb_communities.R", generatedAt = format(Sys.Date()),
  communities = out)
writeLines(toJSON(payload, auto_unbox = TRUE, null = "null", digits = NA, pretty = FALSE), f, useBytes = TRUE)
message(sprintf("[33] wrote %s (%d communities; %d with census counts; %d ambiguous names)", f, length(out),
                sum(vapply(out, function(o) !is.null(o$census), TRUE)), sum(com$ambiguous)))
