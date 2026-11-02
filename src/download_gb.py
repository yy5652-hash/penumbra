"""Fetch PV_Live regional outturn for three GB regions, half-hourly, 2025-11 onward, plus 48 h old weather at their centres."""
import time
from pathlib import Path

import pandas as pd
import requests

from download_weather import fetch

GB = {"Eastern": (10, 52.3, 0.6), "Southern": (20, 51.1, -1.4), "South-Western": (22, 50.7, -3.7)}
URL = "https://api.solar.sheffield.ac.uk/pvlive/api/v4/pes/{}"


def outturn():
    out = Path("data/raw/gb_pvlive.parquet")
    if out.exists():
        return
    rows = []
    for name, (pes, _, _) in GB.items():
        for start in pd.date_range("2025-08-01", "2026-10-01", freq="MS"):
            end = start + pd.offsets.MonthBegin(1)
            r = requests.get(URL.format(pes), params=dict(start=start.strftime("%Y-%m-%dT00:30:00"),
                             end=end.strftime("%Y-%m-%dT00:00:00"), extra_fields="installedcapacity_mwp"), timeout=120)
            r.raise_for_status()
            j = r.json()
            df = pd.DataFrame(j["data"], columns=j["meta"]).assign(region=name)
            rows.append(df)
            time.sleep(1)
    pd.concat(rows).to_parquet(out)


def weather():
    root = Path("data/weather_gb")
    root.mkdir(exist_ok=True)
    for name, (_, lat, lon) in GB.items():
        for s in pd.date_range("2025-07-01", "2026-10-26", freq="QS"):
            out = root / f"{name}_{s:%Y%m%d}.parquet"
            if not out.exists():
                e = min(s + pd.offsets.QuarterEnd(0), pd.Timestamp("2026-10-26"))
                fetch(name, lat, lon, f"{s:%Y-%m-%d}", f"{e:%Y-%m-%d}", out)
                time.sleep(4)


if __name__ == "__main__":
    outturn()
    weather()
