"""Market Discount Rates tab: Canada figures from Pablo Fernandez's annual
survey of the market risk premium (MRP), risk-free rate (RF) and required
return to equity (Km) used by analysts and companies.

Source of truth is the appraiser's workbook, "Market Risk Premium Survey
Chart.xlsx" (sheet "Pablo Fernandez Rates"), which sits beside the study PDFs.
The PDFs themselves are not parsed into the data: their text layout shifts the
country rows between columns from year to year (the 2019 study's own RF table
reads 4.2% for Canada, while its year-over-year table, and the workbook, give
2.5%). Instead the newest PDF's Canada rows are printed beside the workbook's
figures as a check before the JSON is written.

Writes web/public/data/economy/market_discount_rates.json (percent units).

    python scripts/market_discount_rates.py [--folder <study folder>]
"""
import argparse
import datetime as dt
import json
import pathlib
import re
import shutil
import subprocess
import sys

import openpyxl

DEFAULT_FOLDER = pathlib.Path(
    r"D:\Dropbox\Appraisal\GeneralData\Industry Reports"
    r"\Market Risk Free Discount Rate Studies-Pablo Fernandez")
WORKBOOK = "Market Risk Premium Survey Chart.xlsx"
SHEET = "Pablo Fernandez Rates"
OUT = pathlib.Path(__file__).resolve().parent.parent / "web/public/data/economy/market_discount_rates.json"
COUNTRY = "Canada"


def pct(v):
    """Workbook fraction (0.038) → percent (3.8); blanks stay None."""
    if v is None or v == "":
        return None
    return round(float(v) * 100, 2)


def read_workbook(folder):
    wb = openpyxl.load_workbook(folder / WORKBOOK, data_only=True, read_only=True)
    ws = wb[SHEET]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h or "").strip().lower() for h in rows[0]]
    col = {name: head.index(name) for name in
           ("country", "year", "risk free rate", "market risk premium", "required return to equity")}
    out = []
    for r in rows[1:]:
        if not r or r[col["country"]] != COUNTRY or r[col["year"]] is None:
            continue
        out.append({
            "year": int(r[col["year"]]),
            "rf": pct(r[col["risk free rate"]]),
            "mrp": pct(r[col["market risk premium"]]),
            "ke": pct(r[col["required return to equity"]]),
        })
    return sorted(out, key=lambda x: x["year"])


def pdf_check(folder):
    """The newest study's Canada average from its Tables 2 (MRP), 3 (RF) and
    4 (Km), or None when pdftotext is missing or the layout isn't recognised."""
    pdfs = sorted(folder.glob("Market Discount Rate * Study*.pdf"),
                  key=lambda p: int(re.search(r"(\d{4})", p.name).group(1)))
    if not pdfs or not shutil.which("pdftotext"):
        return None
    pdf = pdfs[-1]
    year = int(re.search(r"(\d{4})", pdf.name).group(1))
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    found, table = {}, None
    for line in text.splitlines():
        m = re.match(r"\s*Table (\d+)\.", line)
        if m:
            table = {"2": "mrp", "3": "rf", "4": "ke"}.get(m.group(1))
            continue
        if table and table not in found and re.match(rf"\s*{COUNTRY}\b", line):
            # Respondents, then the average: "Canada   62 4.8% 4.9% 7.0% 3.0%"
            m = re.search(r"\b\d+\s+(\d+[.,]\d)%", line)
            if m:
                found[table] = float(m.group(1).replace(",", "."))
    return year, pdf.name, found


MONTHS = ("January|February|March|April|May|June|July|August|September|"
          "October|November|December")


def study_meta(pdf):
    """Title, authors and publication date from a study's first two pages,
    for the tab's narrative ("A study entitled ... by ... (published ...)").
    Any part that can't be read is None."""
    def text(*extra):
        return subprocess.run(["pdftotext", "-enc", "UTF-8", "-l", "2", *extra, str(pdf), "-"], capture_output=True,
                              text=True, encoding="utf-8", errors="replace").stdout
    layout, plain = text("-layout"), text()
    # Running header, left side: "Pablo Fernandez, Amir Habibian and Antonio F. Acin"
    first = next((ln for ln in layout.splitlines() if ln.strip()), "")
    authors = re.split(r"\s{2,}", first.strip())[0] or None
    # The PDFs' fonts drop accented letters to U+FFFD; restore the known ones.
    for bad, good in (("Ac�n", "Acín"), ("Garc�a", "García"), ("Ba�uls", "Bañuls")):
        authors = authors.replace(bad, good) if authors else authors
    if authors and ("�" in authors or not re.search(r"Fernandez", authors)):
        authors = None
    # Title: from "Survey:" (newer studies) or "Discount Rate" (2017-era) to
    # "... in YYYY"; the running header ("Market Risk Premium and ...") last.
    title = None
    for lead in ("Survey:", "Discount Rate", "Market Risk Premium"):
        m = re.search(re.escape(lead) + r"[^\n]*(?:\n[^\n]*){0,2}?\bin (?:19|20)\d{2}(?:: a survey)?", plain)
        if m:
            title = re.sub(r"\s+", " ", m.group(0)).strip()
            break
    # Older studies repeat the title in a running header and run it into the
    # answer count; keep only a clean one-off title.
    if title and (len(title) > 110 or title.count(" in ") > 1 and title.count("countries") > 1):
        title = None
    m = re.search(rf"^\s*((?:{MONTHS}) \d{{1,2}}, (?:19|20)\d{{2}})\s*$", plain, re.M)
    published = dt.datetime.strptime(m.group(1), "%B %d, %Y").date().isoformat() if m else None
    return {"title": title, "authors": authors, "published": published}


def studies(folder):
    out = {}
    if not shutil.which("pdftotext"):
        return out
    for pdf in folder.glob("Market Discount Rate * Study*.pdf"):
        year = int(re.search(r"(\d{4})", pdf.name).group(1))
        out[year] = study_meta(pdf)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--folder", type=pathlib.Path, default=DEFAULT_FOLDER)
    args = ap.parse_args()

    rows = read_workbook(args.folder)
    if not rows:
        sys.exit(f"No {COUNTRY} rows in {WORKBOOK} / {SHEET}")
    by_year = {r["year"]: r for r in rows}

    check = pdf_check(args.folder)
    if check:
        year, name, found = check
        print(f"Cross-check against {name}:")
        wb_row = by_year.get(year)
        if not wb_row:
            print(f"  WARNING: the workbook has no {year} row yet — add it before publishing.")
        for key, label in (("rf", "Risk-free rate"), ("mrp", "Market risk premium"), ("ke", "Required return")):
            pdf_v = found.get(key)
            wb_v = wb_row.get(key) if wb_row else None
            flag = "" if pdf_v is None or wb_v is None or abs(pdf_v - wb_v) < 0.05 else "   <-- differs"
            print(f"  {label:<20} PDF {pdf_v if pdf_v is not None else '?':>5}   workbook {wb_v if wb_v is not None else '?':>5}{flag}")
    else:
        print("(PDF cross-check skipped: no study PDFs or pdftotext not on PATH)")

    meta = studies(args.folder)
    for r in rows:
        r["study"] = meta.get(r["year"])
    newest = meta.get(rows[-1]["year"]) or {}
    print(f"Newest study: {newest.get('title')} | {newest.get('authors')} | {newest.get('published')}")

    data = {
        "country": COUNTRY,
        "source": "Annual Surveys by Pablo Fernandez et al",
        "statistic": "Average of survey responses (percent)",
        "built": dt.date.today().isoformat(),
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} years ({rows[0]['year']}-{rows[-1]['year']}) to {OUT}")


if __name__ == "__main__":
    main()
