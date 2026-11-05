"""Fetch GFS 0.25 degree 00z runs from the NOAA AWS archive, keeping only the grid points around each place.

The 00z run of D-1 is complete on the archive by about 04:00 UTC, well before Elia's 11:00 Brussels cutoff.
DSWRF is a running average that restarts every 6 hours: f027 holds hours 24-27, f030 holds 24-30, and so on.

Usage: download_gfs.py [first_run_date] [last_run_date] [places]   places: be (default) or gb
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import eccodes
import numpy as np
import pandas as pd
import requests

from download_weather import PLACES

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
STEPS = list(range(27, 46, 3))
FIELDS = ("DSWRF:surface", "TCDC:entire atmosphere")


def get(url, headers=None):
    for attempt in range(20):
        try:
            r = requests.get(url, headers=headers, timeout=60)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            if r.content[:5] == b"<?xml":
                raise requests.RequestException(r.content[:120])
            return r.content
        except requests.RequestException:
            time.sleep(1 + attempt)
    raise RuntimeError(url)


def points(places):
    """Nearest point plus the 3x3 box around it on the 0.25 degree grid (lat 90..-90, lon 0..359.75)."""
    out = {}
    for name, (lat, lon) in places.items():
        i = int(round((90 - lat) / 0.25))
        j = int(round((lon % 360) / 0.25))
        out[name] = [(i + di) * 1440 + (j + dj) % 1440 for di in (-1, 0, 1) for dj in (-1, 0, 1)]
    return out


def one_step(run, step, pts):
    stem = f"{BASE}/gfs.{run:%Y%m%d}/00/atmos/gfs.t00z.pgrb2.0p25.f{step:03d}"
    index = get(stem + ".idx")
    if index is None:
        return []
    lines = index.decode().splitlines()
    rows = []
    for n, line in enumerate(lines):
        parts = line.split(":")
        field = f"{parts[3]}:{parts[4]}"
        if field not in FIELDS or "ave fcst" not in parts[5]:
            continue
        start = int(parts[1])
        end = int(lines[n + 1].split(":")[1]) - 1
        message = get(stem, {"Range": f"bytes={start}-{end}"})
        h = None
        try:
            if message is None:
                raise ValueError("missing GRIB message")
            h = eccodes.codes_new_from_message(message)
            if (eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")) != (1440, 721):
                raise ValueError("unexpected grid")
            values = eccodes.codes_get_values(h)
            if values.size != 1440 * 721:
                raise ValueError("unexpected grid size")
        except (eccodes.CodesInternalError, ValueError) as exc:
            print(f"WARNING {run:%Y-%m-%d} f{step:03d} {field}: skipped ({exc})", flush=True)
            continue
        finally:
            if h is not None:
                eccodes.codes_release(h)
        window = parts[5].split(" ")[0]  # e.g. 24-30
        for name, idx in pts.items():
            box = values[idx]
            rows.append({"run": run, "step": step, "window": window, "param": parts[3], "place": name,
                         "centre": float(box[4]), "box": float(np.mean(box))})
    return rows


def fetch_run(run, pts, root):
    out = root / f"{run:%Y%m%d}.parquet"
    if out.exists():
        return "skip"
    rows = [r for s in STEPS for r in one_step(run, s, pts)]
    df = pd.DataFrame(rows, columns=["run", "step", "window", "param", "place", "centre", "box"])
    tmp = out.with_suffix(".tmp")
    df.to_parquet(tmp)
    tmp.rename(out)
    return f"{len(df)} rows"


def main(first="2024-06-01", last=None, which="be"):
    last = last or f"{pd.Timestamp.now(tz='UTC'):%Y-%m-%d}"
    if which == "gb":
        from download_gb import GB
        places, root = {n: (lat, lon) for n, (_, lat, lon) in GB.items()}, Path("data/gfs_gb")
    else:
        places, root = PLACES, Path("data/gfs")
    root.mkdir(parents=True, exist_ok=True)
    pts = points(places)
    runs = pd.date_range(first, last, freq="D")
    with ThreadPoolExecutor(4) as pool:
        for run, msg in zip(runs, pool.map(lambda r: fetch_run(r, pts, root), runs)):
            if msg != "skip":
                print(f"{run:%Y-%m-%d} {msg}", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
