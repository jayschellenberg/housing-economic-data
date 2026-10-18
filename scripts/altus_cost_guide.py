"""Altus Construction Cost Guide tab: $/sqft construction cost ranges for
nine Canadian urban centres across residential, commercial, industrial,
institutional and civic buildings, plus a mixed-unit Infrastructure section.

Reads the long-format CSV built by extract_altus.py in Jason's cost-guide
folder and writes web/public/data/economy/altus_cost_guide.json. The two
scripts are decoupled: run extract_altus.py whenever a new year's PDF ships,
then re-run this one to publish the figures.

    python scripts/altus_cost_guide.py [--csv <path>]
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import sys

DEFAULT_CSV = pathlib.Path(
    r"D:\Dropbox\Appraisal\GeneralData\Industry Reports\Altus"
    r"\Cost Guide\altus_cost_guide.csv")
OUT = pathlib.Path(__file__).resolve().parent.parent / "web/public/data/economy/altus_cost_guide.json"

# 9-city order used in the PDFs' Private / Public / Servicing tables.
CITIES = ["Vancouver", "Calgary", "Edmonton", "Winnipeg", "GTA",
          "Ottawa", "Montreal", "Halifax", "St. John's"]
# 4-region order used in the Infrastructure LRT / highway tables.
PROVINCES = ["British Columbia", "Alberta",
             "Ontario (GTA Region)", "Ontario (Ottawa Region)"]


def to_int(s):
    return int(s) if s not in ("", None) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--csv", type=pathlib.Path, default=DEFAULT_CSV)
    args = ap.parse_args()
    if not args.csv.exists():
        sys.exit(f"Missing {args.csv} — run extract_altus.py first.")

    rows = []
    years = set()
    with open(args.csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            year = int(r["year"])
            years.add(year)
            unit = r["unit"]
            # Normalize the three per-sqft spellings (extract_altus.py emits
            # $/sf, $/sqft, $/square-feet depending on how the PDF spelled it).
            if unit in ("$/sf", "$/sqft", "$/square-feet"):
                unit = "$/sqft"
            rows.append({
                "year": year,
                "section": r["section"],
                "category": r["category"],
                "subcategory": r["subcategory"],
                "building_type": r["building_type"],
                "city": r["city"],
                "low": to_int(r["low"]),
                "high": to_int(r["high"]),
                "unit": unit,
            })

    data = {
        "source": "Altus Group Canadian Cost Guide",
        "statistic": "Published low–high construction cost range",
        "cities": CITIES,
        "provinces": PROVINCES,
        "years": sorted(years),
        "built": dt.date.today().isoformat(),
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} rows ({min(years)}–{max(years)}) to {OUT}")


if __name__ == "__main__":
    main()
