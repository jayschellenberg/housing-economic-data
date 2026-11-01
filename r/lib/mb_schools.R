# Manitoba Education's "Schools in Manitoba" directory (web.gov.mb.ca/school):
# every school by division with its mailing town and grade range. Used by r/33
# for the service-tier rubric's "school to Grade 12" test — OpenStreetMap
# schools carry no grade levels. Cached as <cache_dir>/mb_schools.csv; delete
# to refresh.
#
# The directory's own "offering Grade 12" search misses K-12 schools (Morris,
# Russell, Souris …), so this walks the division lists instead. Kept: public
# school divisions and First Nations schools. Left out: independent, non-funded
# and faith-board schools (a small private K-12 would make Mitchell a "Grade 12"
# community), adult / evening / virtual / home / institutional listings, and
# Hutterite colony schools — those use a nearby town's mailing address (Dominion City)
# and would credit that town with a high school it doesn't have.

SCHOOL_DIR_URL <- "https://web.gov.mb.ca/school/school?action=district"
SCHOOL_SKIP_DIVISIONS <- c("0169", "0163", "0177", "0176", "0125", "0104", "0115",  # adult, virtual, home, institutional …
                           "0107", "0197", "0198", "0165")                         # independent, non-funded, faith boards
SCHOOL_SKIP_NAME <- "colony|adult|alternative|literacy|learning cent|virtual|distance|correspondence"

mb_school_directory <- function(cache_dir, user_agent = "housing-economic-data") {
  f <- file.path(cache_dir, "mb_schools.csv")
  if (file.exists(f)) return(read.csv(f, stringsAsFactors = FALSE, encoding = "UTF-8"))
  get <- function(body, query = "") {
    tmp <- tempfile(fileext = ".html")
    h <- curl::new_handle(useragent = user_agent, postfields = body)
    curl::curl_download(paste0(SCHOOL_DIR_URL, query), tmp, handle = h)
    paste(readLines(tmp, encoding = "latin1", warn = FALSE), collapse = "\n")
  }
  top <- paste(readLines(url("https://web.gov.mb.ca/school/school?action=top_page"), warn = FALSE), collapse = " ")
  sel <- regmatches(top, regexpr('<select name="DivisionSelection".*?</select>', top))
  codes <- regmatches(sel, gregexpr('(?<=<option value=")\\d+', sel, perl = TRUE))[[1]]
  codes <- setdiff(codes, SCHOOL_SKIP_DIVISIONS)
  rows <- list()
  for (code in codes) {
    s <- get(paste0("DivisionSelection=", code, "&SchoolsInDistrict=Submit"))
    n <- suppressWarnings(as.integer(sub(".*<strong>\\d+ - \\d+ of (\\d+)</strong>.*", "\\1", s)))
    # One request for the whole list (the paging links take any High/Low).
    if (!is.na(n) && n > 10) s <- get("", sprintf("&High=%d&Low=1&DivisionSelection=%s", n, code))
    m <- regmatches(s, gregexpr('<div class="sc_name">(.*?)</div><div>(.*?)</div></div>', s))[[1]]
    for (b in m) {
      name <- sub('^<div class="sc_name">(.*?)</div>.*$', "\\1", b)
      g <- regmatches(b, regexpr("Grades:</strong>\\s*[^<]*", b))
      if (!length(g)) next                     # the division office itself
      town <- regmatches(b, regexpr("[^>]*(?=, Manitoba<br)", b, perl = TRUE))
      gr <- trimws(sub("Grades:</strong>", "", g))
      rows[[length(rows) + 1]] <- data.frame(
        name = trimws(sub("\\s*#\\d+$", "", name)), id = sub(".*#(\\d+)$", "\\1", name),
        town = if (length(town)) trimws(town) else NA_character_,
        low = sub("\\s*to.*$", "", gr), high = suppressWarnings(as.integer(sub("^.*to\\s*", "", gr))),
        division = code, stringsAsFactors = FALSE)
    }
    Sys.sleep(0.5)
  }
  d <- do.call(rbind, rows)
  d <- d[!duplicated(d$id) & !grepl(SCHOOL_SKIP_NAME, d$name, ignore.case = TRUE), ]
  write.csv(d, f, row.names = FALSE, fileEncoding = "UTF-8")
  d
}
