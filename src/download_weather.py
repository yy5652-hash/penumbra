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


def request_weather(params):
    """Shared bounded retry policy for archives and real-response parity fixtures."""
    for attempt in range(6):
        try:
            r = requests.get(URL, params=params, timeout=120)
        except (requests.Timeout, requests.ConnectionError):
            if attempt == 5:
                raise
            time.sleep(4 * (attempt + 1))
            continue
        if r.status_code == 429:
            print("rate limited, sleeping", flush=True)
            time.sleep(70 * (attempt + 1))
            continue
        r.raise_for_status()
        try:
            body = r.json()
        except requests.exceptions.JSONDecodeError:
            if attempt == 5:
                raise
            print("invalid JSON, retrying", params.get('start_date'), flush=True)
            time.sleep(4 * (attempt + 1))
            continue
        return body
    raise RuntimeError(f"gave up on weather request starting {params.get('start_date')}")


def fetch(place, lat, lon, start, end, out, previous_days=(1, 2)):
    hourly = [f"{v}_previous_day{d}" for v in VARS for d in previous_days]
    params = dict(latitude=lat, longitude=lon, start_date=start, end_date=end,
                  hourly=",".join(hourly), models=",".join(MODELS), timezone="UTC")
    df = pd.DataFrame(request_weather(params)["hourly"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["region"] = place
    tmp = out.with_suffix(".tmp")
    df.to_parquet(tmp)
    tmp.rename(out)


def main(places=PLACES, end="2026-10-26", folder="data/weather", previous_days=(1, 2)):
    root = Path(folder)
    root.mkdir(parents=True, exist_ok=True)
    starts = pd.date_range("2024-01-01", end, freq="QS")
    for place, (lat, lon) in places.items():
        for s in starts:
            e = min(s + pd.offsets.QuarterEnd(0), pd.Timestamp(end))
            out = root / f"{place}_{s:%Y%m%d}.parquet"
            if out.exists():
                latest = pd.read_parquet(out, columns=['time']).time.max()
                if pd.notna(latest) and latest.date() >= e.date():
                    continue
            fetch(place, lat, lon, f"{s:%Y-%m-%d}", f"{e:%Y-%m-%d}", out, previous_days)
            print("ok", out.name, flush=True)
            time.sleep(4)


if __name__ == "__main__":
    if sys.argv[1:]:
        day = int(sys.argv[1])
        if day not in (3, 4):
            raise SystemExit("Use 3 or 4 for the additional horizon archives")
        main(end=f"{pd.Timestamp.now(tz='UTC'):%Y-%m-%d}", folder=f"data/weather_h{day}", previous_days=(day,))
    else:
        main()
