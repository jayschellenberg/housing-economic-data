#!/usr/bin/env python3
"""Summarize an indicators refresh for the notification email and the run's
Summary tab.

Run by .github/workflows/refresh-indicators.yml after the pipeline and the
sanity check, before the data is committed. Compares the freshly built
web/public/data/indicators-manifest.json against the copy on HEAD (saved to
<tmp>/manifest.prev.json by the workflow), reports the MLS scrape's as-of and
stale state, and pulls out pipeline log lines that signal a soft failure -- a
scrape that fell back to last-good data, a series that could not be computed.

    python3 scripts/refresh_summary.py <tmp-dir> <run-start-epoch-seconds>

Writes <tmp>/summary.txt, appends to $GITHUB_STEP_SUMMARY, and sets two step
outputs: `headline` (one line, for the subject) and `text` (the full block, for
the body). Standalone use: point <tmp-dir> at any folder holding a
manifest.prev.json and, optionally, a pipeline.log; the GitHub files are
skipped when the variables are unset.
"""
import json
import os
import re
import sys
import time

MANIFEST = "web/public/data/indicators-manifest.json"
BENCH = "web/public/data/economy/mls_benchmark.json"
HEADLINE = "web/public/data/economy/mls_winnipeg.json"

# Lines the scrapes emit when they kept last-good data or skipped something.
SOFT_FAIL = re.compile(
    r"FAILED|failed|stale=TRUE|could not|skipp|guessing URLs|embargo|"
    r"no data|not found|keeping last-good|none with a readable",
    re.I,
)


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


SERIES_ID = re.compile(r"\b[a-z]+(?:\.[a-z0-9_]+){1,}\b")


def collapse(lines):
    """Fold lines that differ only in a dotted series id into one line each,
    so eight 'derived.rent.<city>.yoy could not compute' lines (the annual
    rent series, every week) read as one note instead of drowning the rest."""
    groups, order = {}, []
    for line in lines:
        ids = SERIES_ID.findall(line)
        key = SERIES_ID.sub("*", line, count=1) if ids else line
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(ids[0] if ids else None)
    out = []
    for key in order:
        ids = groups[key]
        if len(ids) == 1 or ids[0] is None:
            out.append(key.replace("*", ids[0], 1) if ids[0] else key)
        else:
            out.append(key.replace("*", f"{len(ids)} series", 1) + "  [" + ", ".join(ids) + "]")
    return out


def main(tmp, start):
    prev = load(os.path.join(tmp, "manifest.prev.json"), {})
    curr = load(MANIFEST, {})
    prev_groups = {g["group"]: g for g in prev.get("groups", [])}

    rows, advanced, dates = [], [], []
    for g in curr.get("groups", []):
        p = prev_groups.get(g["group"], {})
        was, now = p.get("latestDate", "-"), g.get("latestDate", "-")
        delta = g.get("recordCount", 0) - p.get("recordCount", 0)
        moved = now != was
        if moved:
            advanced.append(g["group"])
        dates.append(now)
        rows.append((g["group"], was, now, delta, moved))
    total_delta = curr.get("totalRecords", 0) - prev.get("totalRecords", 0)
    headline = f"{len(advanced)} of {len(rows)} groups advanced, {total_delta:+d} records"

    bench = load(BENCH, {})
    head = load(HEADLINE, {})
    zipname = os.path.basename(str(bench.get("source", "")).split(" ")[-1])

    log_path = os.path.join(tmp, "pipeline.log")
    notes = []
    if os.path.exists(log_path):
        with open(log_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("[") and SOFT_FAIL.search(line):
                    notes.append(line)
    notes = collapse(list(dict.fromkeys(notes)))[:25]

    mins = (time.time() - start) / 60 if start else 0
    out = [
        f"{headline}. Latest indicator date {max(dates) if dates else '-'}. Run {mins:.0f} min.",
        "",
        f"{'group':<20}{'was':<12}{'now':<12}{'records':>8}",
    ]
    for group, was, now, delta, moved in rows:
        out.append(f"{group:<20}{was:<12}{now:<12}{delta:>+8d}{'  <- advanced' if moved else ''}")
    out += [
        "",
        f"CREA HPI benchmark: {bench.get('asOf', '-')} (stale={str(bench.get('stale', '?')).lower()}, {zipname or 'no zip'})",
        f"WRREB headline:     {head.get('asOf', '-')} (stale={str(head.get('stale', '?')).lower()})",
        "",
        "Pipeline notes (soft failures / last-good fallbacks):"
        if notes else "Pipeline notes: none - every scrape returned fresh data.",
    ]
    out += ["  " + n for n in notes]
    text = "\n".join(out)

    with open(os.path.join(tmp, "summary.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("## Indicators refresh\n\n```\n" + text + "\n```\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"headline={headline}\n")
            f.write("text<<EOF_SUMMARY\n" + text + "\nEOF_SUMMARY\n")
    print(text)


if __name__ == "__main__":
    tmp = sys.argv[1] if len(sys.argv) > 1 else "."
    start = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].strip() else 0
    main(tmp, start)
