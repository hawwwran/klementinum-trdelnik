#!/usr/bin/env python3
"""Convert the raw CHMI daily CSVs into compact binaries for the webapp.

Inputs (data/raw/):
    dly-0-203-0-11514-TMA.csv  daily maximum
    dly-0-203-0-11514-T.csv    fixed-hour readings + AVG rows (daily mean)
    dly-0-203-0-11514-TMI.csv  daily minimum

Outputs:
    data/<key>.i16   little-endian int16, temperature * 10, -32768 = missing,
                     one value per day on a shared continuous day grid
    data/meta.json   shared grid + per-element extremes the app needs

The CSVs stop at the end of the last full year; the running year is appended by
the tail update (api/update.php, or `php tools/refresh.php` after a rebuild).
"""

import csv
import json
import struct
import sys
from datetime import date, timedelta
from pathlib import Path

SENTINEL = -32768

# (raw file, TIMEFUNC filter or None, output key, panel label)
ELEMENTS = [
    ("dly-0-203-0-11514-TMA.csv", None, "tma", "Max"),
    ("dly-0-203-0-11514-T.csv", "AVG", "tavg", "Mean"),
    ("dly-0-203-0-11514-TMI.csv", None, "tmi", "Min"),
]

root = Path(__file__).resolve().parent.parent


def read_series(filename, timefunc):
    values = {}
    dupes = 0
    with (root / "data" / "raw" / filename).open() as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            if len(row) < 5 or not row[4]:
                continue
            if timefunc and row[2] != timefunc:
                continue
            d = date.fromisoformat(row[3][:10])
            if d in values:
                dupes += 1
            values[d] = float(row[4])
    if not values:
        sys.exit(f"no data parsed from {filename}")
    return values, dupes


series = {key: read_series(fn, tf) for fn, tf, key, _ in ELEMENTS}

start = min(min(v) for v, _ in series.values())
end = max(max(v) for v, _ in series.values())
# The last day EVERY element covers, which is not always the last day the grid
# spans: CHMI publishes the three CSVs separately, so TMI can lag TMA by days.
# api/update.php only patches days after hist_end, so taking the max here would
# leave the lagging element's tail as sentinels that no refresh can ever fill.
hist_end = min(max(v) for v, _ in series.values())
n_days = (end - start).days + 1

meta_elements = {}
g_min, g_max = None, None
for fn, tf, key, label in ELEMENTS:
    values, dupes = series[key]
    out = []
    missing = 0
    tmin = tmax = None
    tmin_d = tmax_d = None
    for i in range(n_days):
        d = start + timedelta(days=i)
        v = values.get(d)
        if v is None:
            out.append(SENTINEL)
            missing += 1
        else:
            out.append(round(v * 10))
            if tmin is None or v < tmin:
                tmin, tmin_d = v, d
            if tmax is None or v > tmax:
                tmax, tmax_d = v, d
    (root / "data" / f"{key}.i16").write_bytes(struct.pack(f"<{n_days}h", *out))
    meta_elements[key] = {
        "label": label,
        "file": f"data/{key}.i16",
        "missing": missing,
        "tmin": tmin,
        "tmin_date": tmin_d.isoformat(),
        "tmax": tmax,
        "tmax_date": tmax_d.isoformat(),
    }
    g_min = tmin if g_min is None else min(g_min, tmin)
    g_max = tmax if g_max is None else max(g_max, tmax)
    print(f"{key}: missing={missing} dupes={dupes} min={tmin} ({tmin_d}) max={tmax} ({tmax_d})")

meta = {
    "station": "0-203-0-11514",
    "name": "Praha-Klementinum",
    "start": start.isoformat(),
    "end": end.isoformat(),
    # last day the historical CSVs cover; everything after it is feed-owned and
    # may be appended or revised by the tail update (api/update.php)
    "hist_end": hist_end.isoformat(),
    "days": n_days,
    "tmin": g_min,
    "tmax": g_max,
    "elements": meta_elements,
}
(root / "data" / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
print(f"grid {start} .. {end}, {n_days} days; wrote {len(ELEMENTS)} binaries + meta.json")
print("run `php tools/refresh.php` to append the running year from the CHMI feed")
