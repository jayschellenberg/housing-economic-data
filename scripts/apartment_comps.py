"""Apartment Comps tab: Winnipeg apartment income & expense comparables.

Two workbooks feed the tab, both kept by the appraiser:

  * "Apartment Income-Expenses DB.xlsx" — the hand-kept comps database (closed
    MLS sales, listings, appraised properties). READ ONLY here: this script
    never writes to it. Cells that are the appraiser's own formula of units,
    gross income or EGI (=700*N3, =Y3*0.07, =V3*0.03) are tagged "assumed" so
    the tab can keep them out of reported-expense averages.
  * "Apartment Docs Extract.xlsx" — one row per listing / pro forma / CIM /
    income statement in the Apartments-Multi-family folder (sheet Docs) and
    one row per income or expense line as the document printed it (sheet
    Lines). Claude reads the PDFs and appends to it; the appraiser reviews it
    (the "checked" column) and may edit any cell. It is the source of truth
    for the documents: `build` only reads it.

Commands:

    python scripts/apartment_comps.py build
        Both workbooks → AppMarketData\\ApartmentComps\\apartment_comps.json.
    python scripts/apartment_comps.py scan
        List documents in the folder not yet in the extract workbook, or
        changed since they were read (JSON on stdout, for the weekly task).
    python scripts/apartment_comps.py add <dir-of-json>
        Append extracted documents (one JSON per document, the shape in
        docs/apartment-comps-extraction.md) to the extract workbook as
        unchecked rows. A file already in the workbook is replaced only when
        its row is not yet checked.

The JSON is written to the shared AppMarketData folder and never committed:
the documents include brokers' confidential CIMs. Files named with "CIM" are
flagged confidential.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

COMPARABLES = pathlib.Path(r"D:\Dropbox\Appraisal\Comparables")
DB_BOOK = COMPARABLES / "Apartment Income-Expenses DB.xlsx"
EXTRACT_BOOK = COMPARABLES / "Apartment Docs Extract.xlsx"
DOC_ROOT = COMPARABLES / "Winnipeg" / "Apartments-Multi-family"
OUT_DIR = pathlib.Path(r"D:\Dropbox\SharedInfo\AppMarketData\ApartmentComps")
OUT_FILE = "apartment_comps.json"

# Sheets of the DB workbook read for Winnipeg, with the property type of
# their rows. REVIEW COMPS and the Eastman / Westman / Thompson sheets are
# left out for now.
DB_SHEETS = {
    "Wpg MF Comps": "apartment",
    "Income-Expense Comps-Appraised": "apartment",
    "Wpg Rooming Houses": "rooming",
    "Mixed Res-Comm": "mixed",
}

# Folders under DOC_ROOT that hold no comparable documents.
SKIP_DIRS = {"proptaxestimater", "vacant land", "air bnb-vrb proformas"}
DOC_EXTS = {".pdf", ".doc", ".docx", ".xlsx", ".xls"}

INCOME_CATS = ["rent", "parking", "laundry", "other_income", "vacancy"]
EXPENSE_CATS = [
    "tax", "insurance", "hydro", "water", "gas_heat", "heat_hydro", "elec_water",
    "utilities", "rm", "payroll", "mgmt", "snow_yard", "elevator", "fire_life",
    "garbage", "admin", "garb_admin", "reserve", "other",
]
STATED_CATS = ["stated_gross", "stated_egi", "stated_total_exp", "stated_noi", "stated_cap"]
OTHER_CATS = ["debt", "ignore"]
ALL_CATS = INCOME_CATS + EXPENSE_CATS + STATED_CATS + OTHER_CATS

# DB column header → field. First match wins; a header seen twice (the
# Address column repeats for geocoding) keeps its first column.
DB_FIELDS = {
    "address": "address", "city": "city", "location": "city", "ctiy": "city",
    "rm/city": "city", "mls #": "mls", "area": "area", "mls area": "area",
    "dom": "dom", "trx type": "trx", "date": "date", "sale date": "date",
    "date appraised": "date", "orig list": "list_orig", "curr list": "list_curr",
    "sale price": "sale_price", "yr built": "yr_built", "year built": "yr_built",
    "gba": "gba", "area (above grade)": "gba", "# of units": "suites",
    "units": "suites", "# of res units": "suites", "# of comm units": "commercial_units",
    "bach": "bach", "1-bed": "b1", "1-br": "b1", "2-bed": "b2", "2-br": "b2",
    "3-bed": "b3", "3-br": "b3", "total rms": "rooms", "rooms": "rooms",
    "gross income": "inc:rent", "other income": "inc:other_income", "oth inc": "inc:other_income",
    "vacancy loss": "inc:vacancy", "vacancy": "inc:vacancy", "egi": "egi",
    "prop tax": "exp:tax", "insurance": "exp:insurance", "heat": "exp:gas_heat",
    "gas": "exp:gas_heat", "heat/hydro": "exp:heat_hydro", "elec/water": "exp:elec_water",
    "electricity": "exp:hydro", "hydro": "exp:hydro", "water": "exp:water",
    "garb/prof": "exp:garb_admin", "rep/main": "exp:rm", "mgmt-x%": "exp:mgmt",
    "mgmt": "exp:mgmt",
    # "Total Exp*" holds the part of a stated total not split into the
    # columns before it (=13474-SUM(Z90:AG90)), so it is an "other" line.
    "total exp*": "exp:other", "total exp": "total_exp", "net inc": "noi",
    "cap rate": "cap", "notes/comments": "notes", "notes": "notes",
    "tenants pay": "tenants_pay", "heat type": "heat_type",
    "hot water type": "hot_water", "roll num": "roll", "lat": "lat", "lon": "lon",
    "style": "style",
}

# Columns where a formula of other cells is the appraiser's own allowance.
ASSUMED_COLUMNS = {"exp:rm", "exp:mgmt", "inc:vacancy"}
CELL_REF = re.compile(r"\$?[A-Z]{1,3}\$?\d+")
# ref*number or number*ref, optionally bracketed sums of refs: =Y3*0.07, =700*N3,
# =(V340+W340)*0.02 — an allowance computed from the row, wherever it sits.
ALLOWANCE = re.compile(
    r"^=\s*(\(?\s*\$?[A-Z]{1,3}\$?\d+(\s*\+\s*\$?[A-Z]{1,3}\$?\d+)*\s*\)?\s*\*\s*[\d.]+"
    r"|[\d.]+\s*\*\s*\(?\s*\$?[A-Z]{1,3}\$?\d+(\s*\+\s*\$?[A-Z]{1,3}\$?\d+)*\s*\)?)\s*$")


def is_assumed(field, formula):
    if not isinstance(formula, str) or not formula.startswith("="):
        return False
    if ALLOWANCE.match(formula):
        return True
    return field in ASSUMED_COLUMNS and bool(CELL_REF.search(formula))


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if v != v else v
    s = str(v).strip().replace(",", "").replace("$", "")
    try:
        return float(s)
    except ValueError:
        return None


def year_num(v):
    """'Est 1910', '1910/1914', '1960s?', 1964 → 1910, 1910, 1960, 1964."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if 1800 < v < 2100 else None
    m = re.search(r"(18|19|20)\d\d", str(v))
    return int(m.group(0)) if m else None


def iso_date(v):
    """A cell date or text like 'Listing-201905' / '2019-07' → 'YYYY-MM[-DD]'."""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if v is None:
        return None
    s = str(v)
    m = re.search(r"((?:19|20)\d\d)[-/]?(0[1-9]|1[0-2])(?:[-/]?([0-3]\d))?", s)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{mo}-{d}" if d and 1 <= int(d) <= 31 else f"{y}-{mo}"
    m = re.search(r"(19|20)\d\d", s)
    return m.group(0) if m else None


STREET_TYPES = r"(street|st|avenue|ave|av|road|rd|boulevard|blvd|crescent|cres|cr|drive|dr|place|pl|bay|court|ct|lane|ln|way|terrace|trail|tr|parkway|pkwy|row)"


def address_key(address):
    """'240 Jamison Ave' / 'Jamison Ave 240' / '1165-1167-1169 Alexander' → '240 jamison'."""
    if not address:
        return None
    s = str(address).lower().replace("’", "").replace("'", "").replace(".", " ")
    s = re.sub(r",.*$", "", s)
    m = re.search(r"\d+", s)
    if not m:
        return re.sub(r"\s+", " ", s).strip() or None
    number = m.group(0)
    words = re.sub(r"[\d\-/&]+", " ", s)
    words = re.sub(rf"\b{STREET_TYPES}\b", " ", words)
    words = re.sub(r"\b(n|s|e|w|north|south|east|west|unit|suite|et al|and)\b", " ", words)
    words = re.sub(r"[^a-z ]", " ", words)
    words = re.sub(r"\s+", " ", words).strip()
    return f"{number} {words}".strip()


def clean_comment(text):
    return re.sub(r"^[^:\n]{2,40}:\s*", "", (text or "").strip()).strip()


# --- DB workbook ---------------------------------------------------------------

def read_db(path):
    wb_f = openpyxl.load_workbook(path)                  # formulas + comments
    wb_v = openpyxl.load_workbook(path, data_only=True)  # Excel's cached values
    records = []
    for sheet, ptype in DB_SHEETS.items():
        if sheet not in wb_f.sheetnames:
            print(f"  ! sheet {sheet!r} missing from the DB workbook", file=sys.stderr)
            continue
        wf, wv = wb_f[sheet], wb_v[sheet]
        cols, section = None, None
        for r in range(1, wf.max_row + 1):
            first = wv.cell(r, 1).value
            if isinstance(first, str) and first.strip().lower() == "address":
                cols = {}
                for c in range(1, wf.max_column + 1):
                    h = wv.cell(r, c).value
                    key = DB_FIELDS.get(str(h).strip().lower()) if h is not None else None
                    if key and key not in cols:
                        cols[key] = c
                continue
            if cols is None:
                continue
            values = {k: wv.cell(r, c).value for k, c in cols.items()}
            address = values.get("address")
            if not isinstance(address, str) or not re.search(r"[A-Za-z]", address):
                continue
            has_data = any(num(values.get(k)) for k in ("sale_price", "list_orig", "list_curr", "suites")) \
                or values.get("date") is not None
            if not has_data:
                section = address.strip()     # a section heading such as "Old - 2018 or earlier"
                continue
            records.append(db_record(sheet, ptype, r, cols, values, wf, section))
    return dedupe(records)


def db_record(sheet, ptype, r, cols, values, wf, section):
    inc, exp, comments = {}, {}, []
    for key, c in cols.items():
        cell = wf.cell(r, c)
        if cell.comment:
            comments.append({"col": key.split(":")[-1], "text": clean_comment(cell.comment.text)})
        if not key.startswith(("inc:", "exp:")):
            continue
        v = num(values.get(key))
        if v is None or v == 0:
            continue
        entry = {"v": round(v, 2)}
        if is_assumed(key, cell.value):
            entry["a"] = 1
        (inc if key.startswith("inc:") else exp)[key.split(":", 1)[1]] = entry
    sale = num(values.get("sale_price"))
    list_curr = num(values.get("list_curr")) or num(values.get("list_orig"))
    trx = (values.get("trx") or "").strip() if isinstance(values.get("trx"), str) else None
    if sheet == "Income-Expense Comps-Appraised":
        trx = "Appraised"
    price = sale or list_curr
    price_kind = "sale" if sale and (trx or "").lower().startswith("closed") else ("list" if price else None)
    if sale and trx and not trx.lower().startswith("closed"):
        price_kind = "list"
    mls = values.get("mls")
    rec = {
        "id": f"db:{sheet}:{r}", "src": "db", "sheet": sheet, "row": r,
        "ptype": ptype, "kind": trx or ("Closed Sale" if sale else None),
        "section": section, "date": iso_date(values.get("date")),
        "address": values["address"].strip(), "key": address_key(values["address"]),
        "city": (values.get("city") or "Winnipeg") if isinstance(values.get("city"), str) else "Winnipeg",
        "mls": str(int(mls)) if isinstance(mls, (int, float)) else (str(mls).strip() if mls else None),
        "area": values.get("area") if isinstance(values.get("area"), str) else None,
        "price": price, "price_kind": price_kind,
        "list_price": list_curr,
        "suites": num(values.get("suites")),
        "mix": {k: num(values.get(k)) for k in ("bach", "b1", "b2", "b3") if num(values.get(k))},
        "commercial_units": num(values.get("commercial_units")),
        "rooms": num(values.get("rooms")),
        "yr": year_num(values.get("yr_built")),
        "yr_text": str(values.get("yr_built")) if values.get("yr_built") is not None else None,
        "gba": num(values.get("gba")),
        "tenants_pay": values.get("tenants_pay") if isinstance(values.get("tenants_pay"), str) else None,
        "heat": values.get("heat_type") if isinstance(values.get("heat_type"), str) else None,
        "hot_water": values.get("hot_water") if isinstance(values.get("hot_water"), str) else None,
        "inc": inc, "exp": exp,
        "egi": num(values.get("egi")),
        "total_exp": num(values.get("total_exp")),
        "noi": num(values.get("noi")),
        "cap": num(values.get("cap")),
        "notes": values.get("notes") if isinstance(values.get("notes"), str) else None,
        "comments": comments,
        "lat": num(values.get("lat")), "lon": num(values.get("lon")),
    }
    rec["pays"] = pays_from_text(rec["tenants_pay"])
    return {k: v for k, v in rec.items() if v not in (None, {}, [])}


def pays_from_text(text):
    """DB 'Tenants Pay' (None / Hydro / Heat/Hydro / Mixed) → Y/N per utility."""
    if not text:
        return None
    t = text.lower()
    if t.strip() == "mixed":
        return None
    if t.strip() == "none":
        return {"hydro": "N", "heat": "N", "water": "N"}
    return {"hydro": "Y" if "hydro" in t or "elec" in t else "N",
            "heat": "Y" if "heat" in t or "gas" in t else "N",
            "water": "Y" if "water" in t else "N"}


def dedupe(records):
    """The sheet's top block repeats rows from 'Recent Sales'; keep the first."""
    seen, out = set(), []
    for rec in records:
        sig = (rec.get("sheet"), rec.get("key"), rec.get("date"), rec.get("price"))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(rec)
    return out


# --- Extract workbook ------------------------------------------------------------

DOC_COLUMNS = [
    ("doc_id", 8), ("checked", 9), ("confidential", 12), ("file", 60), ("file_mtime", 18),
    ("doc_type", 14), ("doc_date", 11), ("address", 26), ("other_addresses", 18), ("city", 11),
    ("mls", 11), ("property_type", 14), ("price", 12), ("price_type", 10), ("suites", 7),
    ("bach", 6), ("b1", 6), ("b2", 6), ("b3", 6), ("b4", 6), ("commercial_units", 9),
    ("yr_built", 10), ("gba_sf", 10), ("land_sf", 10), ("heat_source", 16), ("hot_water", 14),
    ("hydro_metering", 12), ("tenant_pays_hydro", 9), ("tenant_pays_heat", 9),
    ("tenant_pays_water", 9), ("parking", 16), ("laundry", 16), ("property_tax_assessment", 12),
    ("pages", 10), ("confidence", 10), ("review_note", 60),
]
LINE_COLUMNS = [
    ("doc_id", 8), ("scenario_no", 8), ("scenario", 12), ("period", 22), ("label", 34),
    ("amount", 12), ("category", 16), ("basis", 14), ("note", 40),
]
HEAD_FONT = Font(bold=True, color="FFFFFF")
HEAD_FILL = PatternFill("solid", fgColor="1F4E79")


def new_extract_book(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Docs"
    ws2 = wb.create_sheet("Lines")
    ws3 = wb.create_sheet("Categories")
    for sheet, columns in ((ws, DOC_COLUMNS), (ws2, LINE_COLUMNS)):
        for i, (name, width) in enumerate(columns, 1):
            c = sheet.cell(1, i, name)
            c.font, c.fill = HEAD_FONT, HEAD_FILL
            sheet.column_dimensions[openpyxl.utils.get_column_letter(i)].width = width
        sheet.freeze_panes = "B2"
    ws3.append(["category", "group", "meaning"])
    meaning = {
        "rent": "gross potential rent", "other_income": "other income", "vacancy": "vacancy & bad debt (positive)",
        "tax": "property tax", "hydro": "electricity", "water": "water & sewer", "gas_heat": "gas / heat",
        "heat_hydro": "heat + hydro in one line", "elec_water": "hydro + water in one line",
        "utilities": "all utilities in one line", "rm": "repairs & maintenance", "payroll": "caretaker / wages",
        "mgmt": "management", "snow_yard": "snow & yard", "fire_life": "fire / life safety",
        "admin": "admin / professional", "garb_admin": "garbage + admin in one line",
        "reserve": "replacement reserve", "debt": "financing (not an expense)", "ignore": "subtotal / not used",
    }
    for cat in ALL_CATS:
        group = ("income" if cat in INCOME_CATS else "expense" if cat in EXPENSE_CATS
                 else "stated total" if cat in STATED_CATS else "not used")
        ws3.append([cat, group, meaning.get(cat, cat.replace("_", " "))])
    dv = DataValidation(type="list", formula1=f"=Categories!$A$2:$A${len(ALL_CATS) + 1}", allow_blank=True)
    ws2.add_data_validation(dv)
    dv.add("G2:G20000")
    yn = DataValidation(type="list", formula1='"Y,N"', allow_blank=True)
    ws.add_data_validation(yn)
    yn.add("B2:C5000")
    wb.save(path)


def read_extract(path):
    if not path.exists():
        return [], []
    wb = openpyxl.load_workbook(path, data_only=True)
    def rows(ws):
        it = ws.iter_rows(values_only=True)
        head = [str(h).strip() if h is not None else "" for h in next(it)]
        return [dict(zip(head, r)) for r in it if any(v is not None for v in r)]
    return rows(wb["Docs"]), rows(wb["Lines"])


def yn(v):
    s = str(v).strip().upper() if v is not None else ""
    return "Y" if s in ("Y", "YES", "TRUE", "1") else "N" if s in ("N", "NO", "FALSE", "0") else None


def doc_records(docs, lines):
    by_doc = {}
    for ln in lines:
        by_doc.setdefault(str(ln.get("doc_id")), []).append(ln)
    out = []
    for d in docs:
        doc_id = str(d.get("doc_id"))
        file = d.get("file") or ""
        confidential = yn(d.get("confidential")) == "Y" or bool(re.search(r"\bCIM\b|_CIM", file, re.I))
        base = {
            "src": "doc", "file": file, "conf": 1 if confidential else None,
            "checked": 1 if yn(d.get("checked")) == "Y" else None,
            "review": d.get("review_note"), "confidence": d.get("confidence"),
            "ptype": d.get("property_type") or "apartment", "kind": d.get("doc_type"),
            "date": iso_date(d.get("doc_date")), "address": d.get("address"),
            "key": address_key(d.get("address")), "other_addresses": d.get("other_addresses"),
            "city": d.get("city") or "Winnipeg", "mls": str(d["mls"]) if d.get("mls") else None,
            "price": num(d.get("price")), "price_kind": d.get("price_type"),
            "suites": num(d.get("suites")),
            "mix": {k: num(d.get(k)) for k in ("bach", "b1", "b2", "b3", "b4") if num(d.get(k))},
            "commercial_units": num(d.get("commercial_units")),
            "yr": year_num(d.get("yr_built")),
            "yr_text": str(d["yr_built"]) if d.get("yr_built") is not None else None,
            "gba": num(d.get("gba_sf")), "land": num(d.get("land_sf")),
            "heat": d.get("heat_source"), "hot_water": d.get("hot_water"),
            "metering": d.get("hydro_metering"),
            "pays": {u: yn(d.get(f"tenant_pays_{u}")) for u in ("hydro", "heat", "water")
                     if yn(d.get(f"tenant_pays_{u}"))},
            "parking": d.get("parking"), "laundry": d.get("laundry"),
            "pages": d.get("pages"),
        }
        scen = {}
        for ln in by_doc.get(doc_id, []):
            scen.setdefault(int(num(ln.get("scenario_no")) or 1), []).append(ln)
        if not scen:
            rec = dict(base, id=f"doc:{doc_id}")
            out.append({k: v for k, v in rec.items() if v not in (None, {}, [], "")})
            continue
        for no, lns in sorted(scen.items()):
            rec = dict(base, id=f"doc:{doc_id}:{no}", scenario=lns[0].get("scenario"),
                       period=lns[0].get("period"), scenario_count=len(scen))
            inc, exp, stated, raw = {}, {}, {}, []
            for ln in lns:
                cat = (ln.get("category") or "other").strip()
                amt = num(ln.get("amount"))
                raw.append([ln.get("label"), amt, cat, ln.get("basis"), ln.get("note")])
                if amt is None:
                    continue
                if cat in INCOME_CATS:
                    inc[cat] = {"v": round(inc.get(cat, {}).get("v", 0) + amt, 2)}
                elif cat in EXPENSE_CATS:
                    exp[cat] = {"v": round(exp.get(cat, {}).get("v", 0) + amt, 2)}
                elif cat in STATED_CATS:
                    stated[cat[len("stated_"):]] = amt
            rec.update(inc=inc, exp=exp, lines=raw,
                       egi=stated.get("egi"), total_exp=stated.get("total_exp"),
                       noi=stated.get("noi"), cap=stated.get("cap"),
                       gross_stated=stated.get("gross"))
            out.append({k: v for k, v in rec.items() if v not in (None, {}, [], "")})
    return out


# --- Commands ----------------------------------------------------------------------

def build(args):
    db = read_db(DB_BOOK)
    docs, lines = read_extract(EXTRACT_BOOK)
    recs = db + doc_records(docs, lines)
    stamp = lambda p: dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds") if p.exists() else None
    out = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "sources": {
            "db": {"file": DB_BOOK.name, "modified": stamp(DB_BOOK), "records": len(db)},
            "docs": {"file": EXTRACT_BOOK.name, "modified": stamp(EXTRACT_BOOK),
                     "documents": len(docs), "records": len(recs) - len(db),
                     "checked": sum(1 for d in docs if yn(d.get("checked")) == "Y")},
        },
        "income_cats": INCOME_CATS, "expense_cats": EXPENSE_CATS,
        "records": recs,
    }
    target = pathlib.Path(args.out) if args.out else OUT_DIR / OUT_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":"), default=str), encoding="utf-8")
    os.replace(tmp, target)
    print(f"Wrote {target}: {len(db)} DB rows, {len(docs)} documents "
          f"({out['sources']['docs']['checked']} checked) -> {len(recs)} records")


def iter_docs(root):
    for dirpath, dirnames, filenames in os.walk(root):
        rel = pathlib.Path(dirpath).relative_to(root)
        dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_DIRS
                       and not d.startswith(".") and "photos" not in d.lower()]
        for name in filenames:
            p = pathlib.Path(dirpath) / name
            if p.suffix.lower() in DOC_EXTS and not name.startswith("~$"):
                yield (rel / name).as_posix(), p


def scan(args):
    docs, _ = read_extract(EXTRACT_BOOK)
    known = {str(d.get("file")): d for d in docs}
    new, changed = [], []
    for rel, p in iter_docs(DOC_ROOT):
        mtime = dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")
        d = known.get(rel)
        if d is None:
            new.append({"file": rel, "modified": mtime})
        elif d.get("file_mtime") and str(d["file_mtime"]) < mtime:
            changed.append({"file": rel, "modified": mtime, "doc_id": d.get("doc_id"),
                            "checked": yn(d.get("checked")) == "Y"})
    if args.limit:
        new = sorted(new, key=lambda x: x["modified"], reverse=True)[: args.limit]
    json.dump({"root": str(DOC_ROOT), "new": new, "changed": changed}, sys.stdout, indent=1)
    print()


def add(args):
    if not EXTRACT_BOOK.exists():
        new_extract_book(EXTRACT_BOOK)
    try:
        wb = openpyxl.load_workbook(EXTRACT_BOOK)
    except PermissionError:
        sys.exit(f"{EXTRACT_BOOK.name} is open in Excel; close it and run again.")
    ws_d, ws_l = wb["Docs"], wb["Lines"]
    dcol = {c.value: c.column for c in ws_d[1]}
    lcol = {c.value: c.column for c in ws_l[1]}
    existing = {}
    for r in range(2, ws_d.max_row + 1):
        f = ws_d.cell(r, dcol["file"]).value
        if f:
            existing[str(f)] = r
    next_id = max([int(num(ws_d.cell(r, 1).value) or 0) for r in range(2, ws_d.max_row + 1)] + [0]) + 1
    added = replaced = skipped = 0
    for jp in sorted(pathlib.Path(args.dir).glob("*.json")):
        doc = json.loads(jp.read_text(encoding="utf-8"))
        rel = doc["file"].replace("\\", "/")
        src = DOC_ROOT / rel
        mtime = dt.datetime.fromtimestamp(src.stat().st_mtime).isoformat(timespec="seconds") if src.exists() else None
        if rel in existing:
            r = existing[rel]
            if yn(ws_d.cell(r, dcol["checked"]).value) == "Y":
                print(f"  skip (already checked): {rel}")
                skipped += 1
                continue
            doc_id = ws_d.cell(r, dcol["doc_id"]).value
            for lr in range(ws_l.max_row, 1, -1):
                if str(ws_l.cell(lr, lcol["doc_id"]).value) == str(doc_id):
                    ws_l.delete_rows(lr)
            replaced += 1
        else:
            r = ws_d.max_row + 1
            doc_id = next_id
            next_id += 1
            added += 1
        pays = doc.get("tenant_pays") or {}
        row = dict(doc, doc_id=doc_id, file=rel, file_mtime=mtime, checked=None,
                   confidential="Y" if re.search(r"\bCIM\b|_CIM", rel, re.I) else None,
                   other_addresses=", ".join(doc.get("other_addresses") or []) or None,
                   tenant_pays_hydro=pays.get("hydro"), tenant_pays_heat=pays.get("heat"),
                   tenant_pays_water=pays.get("water"))
        for name, _ in DOC_COLUMNS:
            v = row.get(name)
            ws_d.cell(r, dcol[name], v if not isinstance(v, (dict, list)) else json.dumps(v))
        for i, sc in enumerate(doc.get("scenarios") or [], 1):
            items = list(sc.get("lines") or [])
            stated = sc.get("stated") or {}
            for k in ("gross_income", "egi", "total_expenses", "noi", "cap_rate"):
                if stated.get(k) is not None:
                    cat = {"gross_income": "stated_gross", "total_expenses": "stated_total_exp",
                           "cap_rate": "stated_cap"}.get(k, f"stated_{k}")
                    items.append({"label": f"(stated {k.replace('_', ' ')})", "amount": stated[k], "category": cat})
            for ln in items:
                lr = ws_l.max_row + 1
                vals = {"doc_id": doc_id, "scenario_no": i, "scenario": sc.get("scenario"),
                        "period": sc.get("period"), **ln}
                for name, _ in LINE_COLUMNS:
                    ws_l.cell(lr, lcol[name], vals.get(name))
    try:
        wb.save(EXTRACT_BOOK)
    except PermissionError:
        sys.exit(f"{EXTRACT_BOOK.name} is open in Excel; close it and run again.")
    print(f"{EXTRACT_BOOK.name}: {added} added, {replaced} replaced, {skipped} skipped (checked)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--out", help="write here instead of AppMarketData\\ApartmentComps")
    s = sub.add_parser("scan")
    s.add_argument("--limit", type=int, default=0, help="newest N new files only")
    a = sub.add_parser("add")
    a.add_argument("dir")
    args = ap.parse_args()
    {"build": build, "scan": scan, "add": add}[args.cmd](args)


if __name__ == "__main__":
    main()
