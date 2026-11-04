"""Fetch ECMWF IFS open-data 00z runs from the public archive (Google Cloud copy of the AWS bucket), keeping only the grid points around each place.

The 00z run of D-1 is on the archive by about 07:34 UTC in winter and 08:34 UTC in summer, before Elia's 11:00
Brussels cutoff (09:00 or 10:00 UTC). Steps 24 to 45 cover the daylight of day D. Only the byte ranges of the needed fields are read,
and every run is saved as one small file, so reruns skip finished days.

Usage: download_ecmwf.py [first_run_date] [last_run_date] [places]   places: be (default) or gb
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import eccodes
import numpy as np
import pandas as pd
import requests

from download_weather import PLACES

BASE = "https://storage.googleapis.com/ecmwf-open-data"  # same files as the AWS archive, without its request cap
STEPS = list(range(24, 46, 3))  # 00 to 21 UTC on day D
PARAMS = ["ssrd"]


LAST = [0.0]
PACE = 0.05


def get(url, headers=None):
    """The AWS copy caps one client near 1.5 requests a second and answers SlowDown, sometimes inside a 200 reply,
    so a reply that is XML is retried, and requests keep a small gap."""
    for attempt in range(20):
        wait = LAST[0] + PACE - time.time()
        if wait > 0:
            time.sleep(wait)
        LAST[0] = time.time()
        try:
            r = requests.get(url, headers=headers, timeout=60)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            if r.content[:5] == b"<?xml":
                raise requests.RequestException(r.content[:120])
            return r.content
        except requests.RequestException:
            time.sleep(5)
    raise RuntimeError(url)


def steps_for(run):
    """Only the steps that bracket daylight in Belgium on day D: shorter days need fewer fields."""
    month = (run + pd.Timedelta(days=1)).month
    if month in (11, 12, 1, 2):
        return list(range(30, 43, 3))
    if month in (3, 4, 9, 10):
        return list(range(27, 43, 3))
    return STEPS


def points(places):
    """Nearest point plus the 3x3 box around it on the 0.25 degree grid (lat 90..-90, lon -180..179.75)."""
    out = {}
    for name, (lat, lon) in places.items():
        i = int(round((90 - lat) / 0.25))
        j = int(round((lon + 180) / 0.25)) % 1440
        out[name] = [(i + di) * 1440 + (j + dj) % 1440 for di in (-1, 0, 1) for dj in (-1, 0, 1)]
    return out


def one_step(run, step, pts):
    stem = f"{BASE}/{run:%Y%m%d}/00z/ifs/0p25/oper/{run:%Y%m%d}000000-{step}h-oper-fc"
    index = get(stem + ".index")
    if index is None:
        return []
    rows = []
    for line in index.decode().splitlines():
        meta = json.loads(line)
        if meta["param"] not in PARAMS or meta.get("levtype") != "sfc":
            continue
        start, length = meta["_offset"], meta["_length"]
        data = get(stem + ".grib2", {"Range": f"bytes={start}-{start + length - 1}"})
        h = eccodes.codes_new_from_message(data)
        try:
            if (eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")) != (1440, 721):
                raise ValueError("unexpected grid")
            lon0 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
            if abs(eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees") - 90) > 1e-6 or abs((lon0 + 180) % 360) > 1e-6:
                raise ValueError(f"unexpected grid origin {lon0}")
            values = eccodes.codes_get_values(h)
        finally:
            eccodes.codes_release(h)
        for name, idx in pts.items():
            box = values[idx]
            rows.append({"run": run, "step": step, "param": meta["param"], "place": name,
                         "centre": float(box[4]), "box": float(np.mean(box))})
    return rows


def fetch_run(run, pts, root):
    out = root / f"{run:%Y%m%d}.parquet"
    if out.exists():
        return "skip"
    parts = [one_step(run, s, pts) for s in steps_for(run)]
    rows = [r for p in parts for r in p]
    df = pd.DataFrame(rows, columns=["run", "step", "param", "place", "centre", "box"])
    tmp = out.with_suffix(".tmp")
    df.to_parquet(tmp)
    tmp.rename(out)
    return f"{len(df)} rows, steps {df.step.nunique() if len(df) else 0}"


def main(first="2024-06-01", last=None, which="be"):
    last = last or f"{pd.Timestamp.now(tz='UTC'):%Y-%m-%d}"
    if which == "gb":
        from download_gb import GB
        places, root = {n: (lat, lon) for n, (_, lat, lon) in GB.items()}, Path("data/ecmwf_gb")
    else:
        places, root = PLACES, Path("data/ecmwf")
    root.mkdir(parents=True, exist_ok=True)
    pts = points(places)
    runs = pd.date_range(first, last, freq="D")
    with ThreadPoolExecutor(4) as pool:
        for run, msg in zip(runs, pool.map(lambda r: fetch_run(r, pts, root), runs)):
            if msg != "skip":
                print(f"{run:%Y-%m-%d} {msg}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
