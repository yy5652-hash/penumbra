"""Daily public ledger. Issues tomorrow's forecast after Elia's 11:00 forecast appears, then scores past days.

Forecast files in ledger/ are written once and never changed. Each carries the hash of the previous file.
Days before LIVE_FROM were computed afterwards from data available at their cutoff, and say so.

Usage: live.py run        fetch, rebuild, issue what is missing, rescore
       live.py train M    fit the models of month M (YYYY-MM) on rows ending two days before it
"""
import hashlib
import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import requests

from backtest import FROZEN, QUANTILES, TSO, conformalize, pinball
from download_weather import PLACES, fetch
from features import build

ELIA = "https://opendata.elia.be/api/explore/v2.1/catalog/datasets/{}/exports/json"
NAMES = {"Antwerpen": "Antwerp", "BrabantWallon": "Walloon-Brabant", "Brussel": "Brussels", "Hainaut": "Hainaut",
         "Liege": "Liège", "Limburg": "Limburg", "Luxembourg": "Luxembourg", "Namur": "Namur",
         "OostVlaanderen": "East-Flanders", "VlaamsBrabant": "Flemish-Brabant", "WestVlaanderen": "West-Flanders",
         "Belgium": "Belgium"}
FIELDS = ["dayahead11hforecast", "dayahead11hconfidence10", "dayahead11hconfidence90", "monitoredcapacity"]
FIRST = pd.Timestamp("2026-10-26", tz="UTC")
LIVE_FROM = pd.Timestamp("2026-11-04", tz="UTC")
TABLE = Path("data/live_table.parquet")
LEDGER = Path("ledger")
MODELS = Path("data/models")


def fetch_elia():
    """ods209 holds history, ods210 the recent days and the coming ones. The newer publication wins."""
    frames = []
    for ds, measured in (("ods209", "measured_upscaled"), ("ods210", "measured")):
        r = requests.get(ELIA.format(ds), params={"where": 'gridconnectiontype="Total"',
                         "select": ",".join(["datetime", "region", measured] + FIELDS)}, timeout=180)
        r.raise_for_status()
        df = pd.DataFrame(r.json()).rename(columns={measured: "measured"})
        df["measured"] = pd.to_numeric(df["measured"].astype(str).str.replace(",", "."), errors="coerce")
        frames.append(df)
    # ods209 may lag on measured values, so ods210 only fills what it lacks.
    a, b = frames
    key = ["datetime", "region"]
    df = pd.concat([b, a]).sort_values(key + ["measured"], na_position="last").drop_duplicates(key, keep="first")
    df["region"] = df.region.map(NAMES)
    df["datetime"] = pd.to_datetime(df.datetime, utc=True)
    if df.region.isna().any():
        raise RuntimeError("unknown Elia region")
    df.to_parquet("data/raw/elia_live.parquet")


def fetch_weather(tomorrow):
    root = Path("data/weather_live")
    root.mkdir(exist_ok=True)
    for place, (lat, lon) in PLACES.items():
        for attempt in range(5):
            try:
                fetch(place, lat, lon, "2026-10-20", f"{tomorrow:%Y-%m-%d}", root / f"{place}.parquet")
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(60)


def train(month):
    start = pd.Timestamp(month + "-01", tz="UTC")
    table = pd.read_parquet(TABLE).dropna(subset=TSO + ["cf"])
    table = table[table.datetime < start - pd.Timedelta(days=2)]
    out = MODELS / month
    out.mkdir(parents=True, exist_ok=True)
    for name, spec in FROZEN.items():
        y = table["cf"] - (table[spec["base"]] if spec.get("base") else 0)
        for a in QUANTILES:
            m = lgb.LGBMRegressor(objective="quantile", alpha=a, **spec["params"]).fit(table[spec["feats"]], y)
            m.booster_.save_model(str(out / f"{name}_{int(a * 100)}.txt"))
    print("trained", month, len(table), flush=True)


def models(month):
    if not (MODELS / month / "grid_50.txt").exists():
        train(month)
    return {(n, a): lgb.Booster(model_file=str(MODELS / month / f"{n}_{int(a * 100)}.txt"))
            for n in FROZEN for a in QUANTILES}


def predict(rows, name, boosters):
    spec = FROZEN[name]
    pr = np.column_stack([boosters[name, a].predict(rows[spec["feats"]]) + (rows[spec["base"]].values if spec.get("base") else 0)
                          for a in QUANTILES])
    pr = np.sort(np.clip(pr, 0, None), axis=1)
    return rows[["datetime", "date", "region", "cf", "elevation", "tso_p10", "tso_p50", "tso_p90"]].assign(
        p10=pr[:, 0], p50=pr[:, 1], p90=pr[:, 2])


def read_ledger():
    """Raw out-of-sample predictions of every issued day, for later calibration."""
    rows = {"grid": [], "weather": []}
    for path in sorted(LEDGER.glob("20*.json")):
        doc = json.loads(path.read_text())
        for name in rows:
            df = pd.DataFrame(doc["rows"])[["datetime", "region", "elevation", "tso_p10", "tso_p50", "tso_p90",
                                            f"{name}_raw_p10", f"{name}_p50", f"{name}_raw_p90"]]
            rows[name].append(df.rename(columns={f"{name}_raw_p10": "p10", f"{name}_p50": "p50", f"{name}_raw_p90": "p90"}))
    out = {}
    for name, parts in rows.items():
        if parts:
            df = pd.concat(parts, ignore_index=True)
            df["datetime"] = pd.to_datetime(df.datetime, utc=True)
            df["date"] = df.datetime.dt.floor("D")
            out[name] = df
    return out


def calibrate(name, today, table, ledger):
    """Shift today's raw band by trailing out-of-sample errors, using the frozen test run and earlier ledger days."""
    keep = ["datetime", "date", "region", "elevation", "tso_p10", "tso_p50", "tso_p90", "p10", "p50", "p90"]
    past = pd.read_parquet(f"data/results/test_{name}.parquet")[keep]
    parts = [past] + ([ledger[name][keep]] if name in ledger else [])
    for part in parts:  # parquet and JSON give different datetime types
        part["datetime"] = part["datetime"].astype("datetime64[ns, UTC]")
        part["date"] = part["date"].astype("datetime64[ns, UTC]")
    pool = pd.concat(parts, ignore_index=True)
    pool = pool[pool.date >= today.date.min() - pd.Timedelta(days=70)].copy()
    pool = pool.merge(table[["datetime", "region", "cf"]], on=["datetime", "region"], how="left")
    pool["cf"] = pool.cf.where(pool.date < today.date.min() - pd.Timedelta(days=1))
    today = today.drop(columns="cf").assign(cf=np.nan)
    today["datetime"] = today["datetime"].astype("datetime64[ns, UTC]")
    today["date"] = today["date"].astype("datetime64[ns, UTC]")
    done = conformalize(pd.concat([pool, today], ignore_index=True), scoped=True)
    return done[done.date == today.date.iloc[0]]


def issue(day, table, ledger):
    rows = table[table.date == day].dropna(subset=TSO)
    if rows[rows.region == "Belgium"].tso_p50.sum() <= 0 or rows.region.nunique() < 12:
        return False
    month = f"{day:%Y-%m}"
    boosters = models(month)
    merged = None
    for name in FROZEN:
        c = calibrate(name, predict(rows, name, boosters), table, ledger)
        part = c[["datetime", "region", "elevation", "tso_p10", "tso_p50", "tso_p90"]].copy()
        part[f"{name}_raw_p10"], part[f"{name}_p50"], part[f"{name}_raw_p90"] = c.p10, c.p50, c.p90
        part[f"{name}_p10"], part[f"{name}_p90"] = c.p10c, c.p90c
        merged = part if merged is None else merged.merge(part, on=["datetime", "region", "elevation", "tso_p10", "tso_p50", "tso_p90"])
    merged = merged.sort_values(["region", "datetime"])
    merged["datetime"] = merged.datetime.dt.strftime("%Y-%m-%dT%H:%MZ")
    previous = sorted(LEDGER.glob("20*.json"))
    now = pd.Timestamp.now(tz="UTC")
    doc = {"target_date": f"{day:%Y-%m-%d}", "issued_at": now.strftime("%Y-%m-%dT%H:%MZ"),
           "mode": "live" if day >= LIVE_FROM else "backfill", "model_month": month,
           "prev_sha256": hashlib.sha256(previous[-1].read_bytes()).hexdigest() if previous else None,
           "rows": json.loads(merged.round(5).to_json(orient="records"))}
    (LEDGER / f"{day:%Y-%m-%d}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print("issued", doc["target_date"], doc["mode"], flush=True)
    return True


def score(table):
    """One line per finished day. Only rows with a measured value count."""
    days = []
    for path in sorted(LEDGER.glob("20*.json")):
        doc = json.loads(path.read_text())
        df = pd.DataFrame(doc["rows"])
        df["datetime"] = pd.to_datetime(df.datetime, utc=True).astype("datetime64[ns, UTC]")
        df = df.merge(table[["datetime", "region", "cf"]], on=["datetime", "region"], how="left").dropna(subset=["cf"])
        be = df[df.region == "Belgium"]
        if len(be) < 12:
            continue
        line = {"date": doc["target_date"], "mode": doc["mode"], "issued_at": doc["issued_at"], "rows": len(be)}
        for key, (lo, mid, hi) in {"elia": ("tso_p10", "tso_p50", "tso_p90"), "grid": ("grid_p10", "grid_p50", "grid_p90"),
                                   "weather": ("weather_p10", "weather_p50", "weather_p90")}.items():
            y = be.cf.values
            line[key] = {"pinball": float(np.mean([pinball(y, be[c].values, q).mean() for c, q in ((lo, .1), (mid, .5), (hi, .9))])),
                         "mae": float(np.abs(y - be[mid]).mean()), "cover": float(((y >= be[lo]) & (y <= be[hi])).mean()),
                         "width": float((be[hi] - be[lo]).mean())}
        days.append(line)
    (LEDGER / "scores.json").write_text(json.dumps({"updated_at": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%MZ"), "days": days}, indent=0))
    print("scored", len(days), flush=True)


def run():
    LEDGER.mkdir(exist_ok=True)
    tomorrow = (pd.Timestamp.now(tz="UTC") + pd.Timedelta(days=1)).floor("D")
    fetch_elia()
    fetch_weather(tomorrow)
    build(TABLE, live=True)
    table = pd.read_parquet(TABLE)
    table["datetime"] = table["datetime"].astype("datetime64[ns, UTC]")
    for day in pd.date_range(FIRST, tomorrow, freq="D"):
        if not (LEDGER / f"{day:%Y-%m-%d}.json").exists():
            issue(day, table, read_ledger())
    score(table)
    tom = LEDGER / f"{tomorrow:%Y-%m-%d}.json"
    print("tomorrow issued" if tom.exists() else "tomorrow not issued yet", flush=True)


if __name__ == "__main__":
    train(sys.argv[2]) if sys.argv[1] == "train" else run()
