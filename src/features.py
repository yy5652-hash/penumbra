"""Build the 15-minute modelling table from Elia PV data and archived NWP.

Every feature is available at the 11:00 D-1 cutoff of the TSO day-ahead forecast:
weather comes from runs at least 48 h old and lags stop at the end of D-2.
"""
from pathlib import Path

import numpy as np
import pandas as pd

from download_weather import MODELS, PLACES

PROVINCES = list(PLACES)
OUT = Path("data/table.parquet")


def solar_position(times, lat, lon):
    """Return solar elevation (deg) and azimuth (deg from north) with the NOAA low-accuracy formulas."""
    t = pd.DatetimeIndex(times)
    doy = t.dayofyear.values
    hour = t.hour.values + t.minute.values / 60
    g = 2 * np.pi / 365 * (doy - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                       - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    ha = np.radians((hour * 60 + eqtime + 4 * lon) / 4 - 180)
    phi = np.radians(lat)
    sin_el = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
    el = np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))
    az = np.degrees(np.arctan2(-np.sin(ha), np.tan(decl) * np.cos(phi) - np.sin(phi) * np.cos(ha))) % 360
    return el, az


def clear_sky_ghi(elevation):
    """Haurwitz clear-sky GHI in W/m2."""
    s = np.clip(np.sin(np.radians(elevation)), 0, None)
    out = np.zeros_like(s)
    up = s > 0.01
    out[up] = 1098 * s[up] * np.exp(-0.057 / s[up])
    return out


def load_weather(live=False):
    folders = ["data/weather", "data/weather_live"] if live else ["data/weather"]
    files = [p for f in folders for p in sorted(Path(f).glob("*.parquet"))]
    df = pd.concat([pd.read_parquet(p) for p in files], ignore_index=True)
    return df.drop_duplicates(["region", "time"], keep="last")


def weather_features(raw, lat, lon):
    """Turn one place's hourly NWP into 15-minute features. Hourly radiation is the mean of the preceding hour."""
    raw = raw.sort_values("time").set_index("time")
    idx = pd.date_range(raw.index.min() - pd.Timedelta(hours=1), raw.index.max(), freq="15min", tz="UTC")
    el, az = solar_position(idx, lat, lon)
    cs = clear_sky_ghi(el)
    out = pd.DataFrame({"elevation": el, "azimuth": az, "clear_sky": cs}, index=idx)
    label = idx.floor("h") + pd.Timedelta(hours=1)
    cs_hour = pd.Series(cs, index=idx).groupby(label).mean()
    ks, clouds, temps, directs = [], [], [], []
    for m in MODELS:
        ghi = raw[f"shortwave_radiation_previous_day2_{m}"].reindex(label).values.astype(float)
        direct = raw[f"direct_radiation_previous_day2_{m}"].reindex(label).values.astype(float)
        c_hour = cs_hour.reindex(label).values
        with np.errstate(divide="ignore", invalid="ignore"):
            k = np.where(c_hour > 20, ghi / c_hour, np.nan)
            d = np.where(ghi > 20, direct / ghi, np.nan)
        k = np.clip(k, 0, 1.5)
        out[f"k_{m}"] = k
        out[f"ghi_{m}"] = k * cs
        ks.append(k)
        directs.append(d)
        cloud = raw[f"cloud_cover_previous_day2_{m}"].astype(float)
        temp = raw[f"temperature_2m_previous_day2_{m}"].astype(float)
        clouds.append(cloud.reindex(idx).interpolate(limit=4).values)
        temps.append(temp.reindex(idx).interpolate(limit=4).values)
    ks, clouds, temps, directs = map(np.array, (ks, clouds, temps, directs))
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            out["k_mean"] = np.nanmean(ks, axis=0)
            out["k_std"] = np.nanstd(ks, axis=0)
            out["k_min"] = np.nanmin(ks, axis=0)
            out["k_max"] = np.nanmax(ks, axis=0)
            out["cloud_mean"] = np.nanmean(clouds, axis=0)
            out["cloud_std"] = np.nanstd(clouds, axis=0)
            out["temp"] = np.nanmean(temps, axis=0)
            out["direct_frac"] = np.nanmean(directs, axis=0)
    out["ghi_mean"] = out["k_mean"] * cs
    doy = idx.dayofyear.values
    out["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    out["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return out


def load_ecmwf(folder="data/ecmwf"):
    files = sorted(Path(folder).glob("*.parquet"))
    if not files:
        return None
    df = pd.concat([pd.read_parquet(p) for p in files], ignore_index=True)
    return df[df.param == "ssrd"]


def ecmwf_features(ec, place, feats):
    """Fresh ECMWF radiation from the 00z run of D-1: 3-hour mean GHI as a clear-sky index, spread over 15 minutes.

    A 15-minute row starting at t belongs to the 3-hour interval ending at floor(t, 3h) + 3h, as hourly values do above.
    """
    e = ec[ec.place == place].copy()
    e["run"] = pd.to_datetime(e["run"], utc=True)
    e = e.pivot_table(index="run", columns="step", values="box")
    rows = []
    for step in range(27, 46, 3):
        if step in e.columns and step - 3 in e.columns:
            ghi = (e[step] - e[step - 3]) / 10800
            rows.append(pd.DataFrame({"end": e.index + pd.Timedelta(hours=step), "ghi3": ghi.values}))
    if not rows:
        return pd.DataFrame(index=feats.index, data={"k_ec": np.nan, "ghi_ec": np.nan})
    g = pd.concat(rows).dropna().set_index("end").ghi3
    g = g[~g.index.duplicated()]
    label = feats.index.floor("3h") + pd.Timedelta(hours=3)
    cs3 = feats["clear_sky"].groupby(label).transform("mean").values
    ghi = g.reindex(label).values
    with np.errstate(divide="ignore", invalid="ignore"):
        k = np.clip(np.where(cs3 > 20, ghi / cs3, np.nan), 0, 1.5)
    return pd.DataFrame(index=feats.index, data={"k_ec": k, "ghi_ec": k * feats["clear_sky"].values})


def load_gfs(folder="data/gfs"):
    files = sorted(Path(folder).glob("*.parquet"))
    return pd.concat([pd.read_parquet(p) for p in files], ignore_index=True) if files else None


def gfs_features(gf, place, feats):
    """Fresh GFS from the 00z run of D-1. GFS averages restart every 6 hours, so the second 3 hours of each
    6-hour window are 2 * mean(0-6) - mean(0-3)."""
    out = {}
    for param, col in (("DSWRF", "ghi3"), ("TCDC", "cloud3")):
        e = gf[(gf.place == place) & (gf.param == param)].copy()
        e["run"] = pd.to_datetime(e["run"], utc=True)
        e = e.pivot_table(index="run", columns="window", values="box")
        parts = []
        for a in (24, 30, 36, 42):
            first, whole = f"{a}-{a + 3}", f"{a}-{a + 6}"
            if first in e.columns:
                parts.append(pd.Series(e[first].values, index=e.index + pd.Timedelta(hours=a + 3)))
                if whole in e.columns:
                    parts.append(pd.Series((2 * e[whole] - e[first]).values, index=e.index + pd.Timedelta(hours=a + 6)))
        v = pd.concat(parts).dropna() if parts else pd.Series(dtype=float)
        out[col] = v[~v.index.duplicated()]
    label = feats.index.floor("3h") + pd.Timedelta(hours=3)
    cs3 = feats["clear_sky"].groupby(label).transform("mean").values
    ghi = out["ghi3"].reindex(label).values
    with np.errstate(divide="ignore", invalid="ignore"):
        k = np.clip(np.where(cs3 > 20, ghi / cs3, np.nan), 0, 1.5)
    return pd.DataFrame(index=feats.index, data={"k_gfs": k, "ghi_gfs": k * feats["clear_sky"].values,
                                                 "cloud_gfs": out["cloud3"].reindex(label).values})


def add_lags(g):
    """Lags that exist at 11:00 D-1. D-2 is the last complete day, 192 quarter-hours back."""
    g = g.sort_values("datetime").set_index("datetime")
    g = g.asfreq("15min")
    g["cf_d2"] = g["cf"].shift(192)
    daily_cf = g["cf"].where(g["clear_sky"] > 20).resample("D").sum(min_count=8)
    daily_cs = g["clear_sky"].where(g["clear_sky"] > 20).resample("D").sum(min_count=8)
    ratio = (daily_cf.rolling(7, min_periods=4).sum() / daily_cs.rolling(7, min_periods=4).sum()).shift(2) * 1000
    g["perf7"] = ratio.reindex(g.index.floor("D")).values
    # Trailing TSO error at the same quarter-hour, from D-2 back to D-8.
    err = g["cf"] - g["tso_p50"]
    g["tso_err7"] = pd.concat([err.shift(96 * k) for k in range(2, 9)], axis=1).mean(axis=1)
    g["tso_abs7"] = pd.concat([err.abs().shift(96 * k) for k in range(2, 9)], axis=1).mean(axis=1)
    # D-1 morning, 06:00 to 08:00 UTC: measured before the cutoff (09:00 UTC in summer, 10:00 in winter).
    morning = (g.index.hour >= 6) & (g.index.hour < 8)
    day_cf = g["cf"].where(morning).resample("D").sum(min_count=4)
    day_tso = g["tso_p50"].where(morning).resample("D").sum(min_count=4)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = (day_cf / day_tso.where(day_tso > 0.02)).shift(1)
    g["m_ratio1"] = ratio.reindex(g.index.floor("D")).values
    g["m_err1"] = ((day_cf - day_tso) / 8).shift(1).reindex(g.index.floor("D")).values
    return g.reset_index()


def build(out=OUT, live=False):
    """With live, append the datasets Elia started on 2026-10-26 and keep rows whose outcome is not known yet."""
    elia = pd.read_parquet("data/raw/elia_ods032.parquet")
    elia["datetime"] = pd.to_datetime(elia["datetime"], utc=True).astype("datetime64[ns, UTC]")
    if live:
        new = pd.read_parquet("data/raw/elia_live.parquet")
        new["datetime"] = new["datetime"].astype("datetime64[ns, UTC]")
        elia = pd.concat([elia[elia.datetime < new.datetime.min()], new], ignore_index=True)
    elia = elia[elia.region.isin(PROVINCES + ["Belgium"])].drop_duplicates(["datetime", "region"])
    weather = load_weather(live)
    ec, gf = load_ecmwf(), load_gfs()
    parts = {}
    for name, (lat, lon) in PLACES.items():
        parts[name] = weather_features(weather[weather.region == name], lat, lon)
        if ec is not None:
            parts[name] = parts[name].join(ecmwf_features(ec, name, parts[name]))
        if gf is not None:
            parts[name] = parts[name].join(gfs_features(gf, name, parts[name]))
    caps = elia[elia.region.isin(PROVINCES)].groupby("region").monitoredcapacity.last()
    weights = caps / caps.sum()
    frames = [parts[n].mul(weights[n]) for n in PROVINCES]
    nat = sum(frames)
    parts["Belgium"] = nat
    tables = []
    for name, feats in parts.items():
        e = elia[elia.region == name].set_index("datetime").sort_index()
        t = feats.join(e, how="inner").reset_index(names="datetime")
        t["region"] = name
        t["cf"] = t["measured"] / t["monitoredcapacity"]
        for src, dst in [("dayahead11hforecast", "tso_p50"), ("dayahead11hconfidence10", "tso_p10"),
                         ("dayahead11hconfidence90", "tso_p90")]:
            t[dst] = t[src] / t["monitoredcapacity"]
        tables.append(add_lags(t).assign(region=name))
    table = pd.concat(tables, ignore_index=True)
    table = table[(table.elevation > 0) & table.k_mean.notna() & (live | table.cf.notna())]
    table["date"] = table.datetime.dt.floor("D")
    table.to_parquet(out)
    print(table.shape, table.datetime.min(), table.datetime.max())
    print(table.groupby("region").cf.agg(["count", "mean", "max"]).round(3))
    return table


if __name__ == "__main__":
    build()
