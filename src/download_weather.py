"""Download archived NWP from the Open-Meteo Previous Runs API, one file per place and quarter.

previous_day2 means the value came from a run about 48 h before the valid time, so it is
strictly older than the 11:00 D-1 cutoff of the TSO day-ahead forecast. Reruns skip finished files.
"""
import sys
import time
from pathlib import Path

import pandas as pd
import requests

URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
MODELS = ["ecmwf_ifs025", "icon_seamless", "gfs_seamless", "meteofrance_seamless"]
VARS = ["shortwave_radiation", "direct_radiation", "cloud_cover", "temperature_2m"]
PLACES = {
    "Antwerp": (51.22, 4.60), "Brussels": (50.85, 4.37), "East-Flanders": (51.03, 3.80),
    "Flemish-Brabant": (50.90, 4.70), "Hainaut": (50.47, 3.95), "Limburg": (50.99, 5.35),
    "Liège": (50.55, 5.60), "Luxembourg": (49.95, 5.45), "Namur": (50.35, 4.85),
    "Walloon-Brabant": (50.68, 4.55), "West-Flanders": (51.05, 3.05),
}


def fetch(place, lat, lon, start, end, out):
    hourly = [f"{v}_previous_day{d}" for v in VARS for d in (1, 2)]
    params = dict(latitude=lat, longitude=lon, start_date=start, end_date=end,
                  hourly=",".join(hourly), models=",".join(MODELS), timezone="UTC")
    for attempt in range(6):
        r = requests.get(URL, params=params, timeout=120)
        if r.status_code == 429:
            print("rate limited, sleeping", flush=True)
            time.sleep(70 * (attempt + 1))
            continue
        r.raise_for_status()
        df = pd.DataFrame(r.json()["hourly"])
        df["time"] = pd.to_datetime(df["time"], utc=True)
        df["region"] = place
        tmp = out.with_suffix(".tmp")
        df.to_parquet(tmp)
        tmp.rename(out)
        return
    raise RuntimeError(f"gave up on {place} {start}")


def main(places=PLACES, end="2026-10-26", folder="data/weather"):
    root = Path(folder)
    root.mkdir(parents=True, exist_ok=True)
    starts = pd.date_range("2024-01-01", end, freq="QS")
    for place, (lat, lon) in places.items():
        for s in starts:
            e = min(s + pd.offsets.QuarterEnd(0), pd.Timestamp(end))
            out = root / f"{place}_{s:%Y%m%d}.parquet"
            if out.exists():
                continue
            fetch(place, lat, lon, f"{s:%Y-%m-%d}", f"{e:%Y-%m-%d}", out)
            print("ok", out.name, flush=True)
            time.sleep(4)


if __name__ == "__main__":
    main()
