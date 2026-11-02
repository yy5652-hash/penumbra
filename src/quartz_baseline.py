"""Run the open-source Quartz Solar Forecast model (MIT, Open Climate Fix) on the same 48 h old ICON weather.

Quartz normally reads reanalysis for old dates, which would hand it perfect weather. Feeding archived
forecasts keeps the comparison fair. Runs inside .venv-quartz. Reruns skip finished provinces.
"""
import logging
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from quartz_solar_forecast.data import format_nwp_data, make_pv_data
from quartz_solar_forecast.forecasts import forecast_v1_tilt_orientation
from quartz_solar_forecast.pydantic_models import PVSite
from psp.serialization import load_model
import quartz_solar_forecast

sys.path.insert(0, "src")
from download_weather import PLACES

warnings.filterwarnings("ignore")
logging.disable(logging.WARNING)
OUT = Path("data/quartz")
URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
NAMES = {"temperature_2m": "t", "precipitation": "prate", "cloud_cover_low": "lcc", "cloud_cover_mid": "mcc",
         "cloud_cover_high": "hcc", "wind_speed_10m": "si10", "shortwave_radiation": "dswrf", "direct_radiation": "dlwrf"}
START, END = "2025-05-01", "2026-10-25"


def weather(place, lat, lon):
    path = OUT / f"nwp_{place}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    params = dict(latitude=lat, longitude=lon, start_date=START, end_date="2026-10-26", timezone="UTC",
                  models="icon_seamless", hourly=",".join(f"{v}_previous_day2" for v in NAMES))
    for attempt in range(8):
        try:
            r = requests.get(URL, params=params, timeout=180)
            r.raise_for_status()
            hourly = r.json()["hourly"]
            break
        except (requests.RequestException, ValueError, KeyError) as e:
            print(place, "retry", attempt, str(e)[:100], flush=True)
            if attempt == 7:
                raise
            time.sleep(70 * (attempt + 1))
    df = pd.DataFrame(hourly)
    df["time"] = pd.to_datetime(df["time"])
    df = df.set_index("time").rename(columns={f"{k}_previous_day2": v for k, v in NAMES.items()}).astype(float)
    df["vis"] = 24000.0
    df.to_parquet(path)
    return df


def main():
    OUT.mkdir(exist_ok=True)
    pkg = Path(quartz_solar_forecast.__file__).parent
    model = load_model(str(pkg / "models/model-0.4.0.pkl"))
    # The first day's cutoff falls before the archive starts, so scoring begins one day later.
    days = pd.date_range(pd.Timestamp(START) + pd.Timedelta(days=1), END, freq="D")
    for place, (lat, lon) in PLACES.items():
        path = OUT / f"pred_{place}.parquet"
        if path.exists():
            continue
        df = weather(place, lat, lon)
        site = PVSite(latitude=lat, longitude=lon, capacity_kwp=4, tilt=35, orientation=180)
        rows = []
        for day in days:
            ts = day - pd.Timedelta(hours=15)  # 09:00 UTC on D-1, the TSO cutoff
            part = df[df.index >= ts.floor("D")].iloc[:96]
            if len(part) < 72 or part["dswrf"].isna().mean() > 0.2:
                continue
            nwp = format_nwp_data(part, "icon", site)
            pv = make_pv_data(site=site, ts=ts)
            pred = forecast_v1_tilt_orientation("icon", nwp, pv, ts, model=model)
            pred = pred[(pred.index >= day) & (pred.index < day + pd.Timedelta(days=1))]
            rows.append(pd.DataFrame({"datetime": pred.index, "region": place, "quartz": pred.power_kw.values / 4}))
        if rows:
            out = pd.concat(rows)
            out.to_parquet(path)
            print(place, len(out), round(out.quartz.mean(), 4), flush=True)


if __name__ == "__main__":
    main()
