# 2021 Census population and dwelling counts for Manitoba's designated places
# (98-10-0012) and population centres (98-10-0011), from the www150 table
# downloads (not behind the www12 bot check). Used by r/27 (ranking a
# municipality's main town) and r/33 (community growth + seasonal dwellings).
# Cached under <cache_dir>/sc_<pid>/; delete to refresh.
#
# Designated-place DGUIDs carry the province code (2021A000646…); population
# centre codes do not, so those are kept by their place in the table's member
# list, which nests them under the Manitoba member.

mb_place_populations <- function(cache_dir, user_agent = "housing-economic-data") {
  fetch <- function(pid) {
    d <- file.path(cache_dir, paste0("sc_", pid))
    f <- file.path(d, paste0(pid, ".csv"))
    if (!file.exists(f)) {
      z <- file.path(cache_dir, paste0(pid, ".zip"))
      download.file(paste0("https://www150.statcan.gc.ca/n1/tbl/csv/", pid, "-eng.zip"), z,
                    mode = "wb", quiet = TRUE, headers = c("User-Agent" = user_agent))
      unzip(z, exdir = d)
    }
    list(data = f, meta = file.path(d, paste0(pid, "_MetaData.csv")))
  }
  # Member IDs strictly between Manitoba and the next province in the GEO list.
  mb_members <- function(meta) {
    l <- readLines(meta, encoding = "UTF-8", warn = FALSE)
    h <- grep('^"Dimension ID","Member Name"', l)[1]
    e <- h + which(!nzchar(trimws(l[(h + 1):length(l)])))[1] - 1
    m <- read.csv(text = l[h:e], check.names = FALSE, stringsAsFactors = FALSE)
    m <- m[m[["Dimension ID"]] == 1, ]
    prov <- m[m[["Classification Code"]] %in% sprintf("[%d]", c(10, 11, 12, 13, 24, 35, 46, 47, 48, 59, 60, 61, 62)), ]
    lo <- prov[["Member ID"]][prov[["Classification Code"]] == "[46]"]
    hi <- min(prov[["Member ID"]][prov[["Member ID"]] > lo])
    m[["Member ID"]][m[["Member ID"]] > lo & m[["Member ID"]] < hi]
  }
  one <- function(pid) {
    src <- fetch(pid)
    x <- read.csv(src$data, check.names = FALSE, stringsAsFactors = FALSE, encoding = "UTF-8")
    x <- if (pid == "98100012") x[grepl("^2021A\\d{4}46", x$DGUID), ] else x[x$Coordinate %in% mb_members(src$meta), ]
    col <- function(p) suppressWarnings(as.numeric(x[[grep(p, names(x))[1]]]))
    data.frame(geo = sub(" \\((Manitoba part|Saskatchewan part)\\)$", "", x$GEO), pop21 = col("Population, 2021"),
               pop16 = col("Population, 2016"), dwell = col("Total private dwellings"),
               occ = col("occupied by usual residents"), area = col("Land area"),
               kind = if (pid == "98100012") "designated place" else "population centre")
  }
  rbind(one("98100012"), one("98100011"))
}
