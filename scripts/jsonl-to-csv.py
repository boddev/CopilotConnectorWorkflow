#!/usr/bin/env python3
"""Flatten an HLS-style JSONL file to a CSV the data-enhancer can ingest.

The data-enhancer (sibling repo ..\\data-enhancer) only consumes tabular files
via csv.DictReader. HLS datasets ship as JSONL with a nested `customProperties`
object. This script flattens each record into a row whose columns are:

    recordId, title, summary, recordType, lastModified,
    <every key found in any customProperties object>

For HLS records, customProperties is a flat object of scalar values per dataset,
so a single pass to collect the column union is sufficient. Nested values, if
any, are JSON-serialised to a string cell.

Optionally caps the number of rows (--max-rows) so the resulting CSV stays
under Node's ~512 MB single-string limit that eval-gen runs into for the
multi-million-record HLS datasets. Sampling is deterministic: every Nth row
is kept (stride = ceil(total / max_rows)) so the cap also spreads the sample
across the file.

Usage:
    python jsonl-to-csv.py <input.jsonl> <output.csv> [--max-rows N]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path


def stringify(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def count_lines(path: Path) -> int:
    n = 0
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                n += 1
    return n


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="Cap output rows. 0 = no cap. When set, every Nth record is kept so the sample spans the file.",
    )
    args = parser.parse_args(argv[1:])

    src = Path(args.input)
    dst = Path(args.output)
    if not src.is_file():
        print(f"error: input not found: {src}", file=sys.stderr)
        return 2
    dst.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    stride = 1
    if args.max_rows and args.max_rows > 0:
        total = count_lines(src)
        if total > args.max_rows:
            stride = math.ceil(total / args.max_rows)
            print(
                f"sampling {args.max_rows} of {total} rows (stride={stride}) from {src}",
                file=sys.stderr,
            )

    base_columns = ["recordId", "title", "summary", "recordType", "lastModified"]
    cp_columns: list[str] = []
    cp_columns_seen: set[str] = set()

    # First pass (using same stride if sampling): collect customProperties keys.
    with src.open("r", encoding="utf-8") as fh:
        record_idx = -1
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record_idx += 1
            if stride > 1 and record_idx % stride != 0:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            cp = rec.get("customProperties") or {}
            if isinstance(cp, dict):
                for k in cp.keys():
                    if k and k not in cp_columns_seen:
                        cp_columns_seen.add(k)
                        cp_columns.append(k)

    final_cp_columns = []
    for k in cp_columns:
        out = k if k not in base_columns else f"cp_{k}"
        final_cp_columns.append((k, out))
    fieldnames = base_columns + [out for _, out in final_cp_columns]

    written = 0
    with src.open("r", encoding="utf-8") as fh, dst.open(
        "w", encoding="utf-8", newline=""
    ) as out:
        writer = csv.DictWriter(out, fieldnames=fieldnames)
        writer.writeheader()
        record_idx = -1
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record_idx += 1
            if stride > 1 and record_idx % stride != 0:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            row: dict[str, str] = {col: "" for col in fieldnames}
            for c in base_columns:
                row[c] = stringify(rec.get(c))
            cp = rec.get("customProperties") or {}
            if isinstance(cp, dict):
                for orig_key, out_key in final_cp_columns:
                    if orig_key in cp:
                        row[out_key] = stringify(cp[orig_key])
            writer.writerow(row)
            written += 1

    print(f"wrote {written} rows to {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
