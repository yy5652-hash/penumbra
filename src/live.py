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

from backtest import FROZEN_V2, FROZEN, QUANTILES, TSO, conformalize, pinball
import download_gfs
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
V2_FROM = pd.Timestamp("2026-11-08", tz="UTC")
V2_TABLE = Path("data/table_v2.parquet")
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


def train(month, version="v1"):
    start = pd.Timestamp(month + "-01", tz="UTC")
    source = TABLE
    if version == "v2":
        source = V2_TABLE
        if not source.exists() or source.stat().st_mtime < start.timestamp():
            build(source, extended=True)
    table = pd.read_parquet(source).dropna(subset=TSO + ["cf"])
    table = table[table.datetime < start - pd.Timedelta(days=2)]
    out = MODELS / month
    out.mkdir(parents=True, exist_ok=True)
    specs = FROZEN_V2 if version == "v2" else FROZEN
    prefix = "v2_" if version == "v2" else ""
    for name, spec in specs.items():
        y = table["cf"] - (table[spec["base"]] if spec.get("base") else 0)
        for a in QUANTILES:
            m = lgb.LGBMRegressor(objective="quantile", alpha=a, **spec["params"]).fit(table[spec["feats"]], y)
            m.booster_.save_model(str(out / f"{prefix}{name}_{int(a * 100)}.txt"))
    print("trained", month, len(table), flush=True)


def models(month, version="v1"):
    if not all((MODELS / month / f"{n}_{int(a * 100)}.txt").exists() for n in FROZEN for a in QUANTILES):
        train(month)
    specs = dict(FROZEN)
    if version == "v2":
        specs.update(FROZEN_V2)
        if not all((MODELS / month / f"v2_grid_{int(a * 100)}.txt").exists() for a in QUANTILES):
            train(month, "v2")
    return {(n, a): lgb.Booster(model_file=str(MODELS / month /
            f"{'v2_' if version == 'v2' and n == 'grid' else ''}{n}_{int(a * 100)}.txt"))
            for n in specs for a in QUANTILES}


def predict(rows, name, boosters, version="v1"):
    spec = (FROZEN_V2 if version == "v2" and name == "grid" else FROZEN)[name]
    pr = np.column_stack([boosters[name, a].predict(rows[spec["feats"]]) + (rows[spec["base"]].values if spec.get("base") else 0)
                          for a in QUANTILES])
    pr = np.sort(np.clip(pr, 0, None), axis=1)
    return rows[["datetime", "date", "region", "cf", "elevation", "tso_p10", "tso_p50", "tso_p90"]].assign(
        p10=pr[:, 0], p50=pr[:, 1], p90=pr[:, 2])


def chain_order():
    """Ledger files in issue order: a file comes after the file its hash points to. Ties keep issue time, then date."""
    docs = {p: json.loads(p.read_text()) for p in LEDGER.glob("20*.json")}
    hashes = {hashlib.sha256(p.read_bytes()).hexdigest(): p for p in docs}
    order, seen = [], set()
    pending = sorted(docs, key=lambda p: (docs[p]["issued_at"], p.stem))
    while pending:
        nxt = next(p for p in pending if docs[p]["prev_sha256"] is None or hashes.get(docs[p]["prev_sha256"]) in seen)
        order.append(nxt)
        seen.add(nxt)
        pending.remove(nxt)
    return order


def read_ledger(version="v1"):
    """Raw out-of-sample predictions of every issued day, for later calibration."""
    rows = {"grid": [], "weather": []}
    for path in sorted(LEDGER.glob("20*.json")):
        doc = json.loads(path.read_text())
        for name in rows:
            if name == "grid" and doc.get("model", "v1") != version:
                continue
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


def calibrate(name, today, table, ledger, version="v1"):
    """Shift today's raw band by trailing out-of-sample errors, using the frozen test run and earlier ledger days."""
    keep = ["datetime", "date", "region", "elevation", "tso_p10", "tso_p50", "tso_p90", "p10", "p50", "p90"]
    stage = "test_v2" if version == "v2" and name == "grid" else "test"
    past = pd.read_parquet(f"data/results/{stage}_{name}.parquet")[keep]
    parts = [past] + ([ledger[name][keep]] if name in ledger else [])
    for part in parts:  # parquet and JSON give different datetime types
        part["datetime"] = part["datetime"].astype("datetime64[ns, UTC]")
        part["date"] = part["date"].astype("datetime64[ns, UTC]")
    pool = pd.concat(parts, ignore_index=True)
    pool = pool[pool.date >= today.date.min() - pd.Timedelta(days=70)].copy()
    if version == "v2" and name == "grid":
        pool = pool[pool.date < today.date.min()].copy()
    pool = pool.merge(table[["datetime", "region", "cf"]], on=["datetime", "region"], how="left")
    pool["cf"] = pool.cf.where(pool.date < today.date.min() - pd.Timedelta(days=1))
    today = today.drop(columns="cf").assign(cf=np.nan)
    today["datetime"] = today["datetime"].astype("datetime64[ns, UTC]")
    today["date"] = today["date"].astype("datetime64[ns, UTC]")
    done = conformalize(pd.concat([pool, today], ignore_index=True), scoped=True)
    return done[done.date == today.date.iloc[0]]


def issue(day, table, ledger):
    if (LEDGER / f"{day:%Y-%m-%d}.json").exists():
        return False
    version = "v2" if day >= V2_FROM else "v1"
    rows = table[table.date == day].dropna(subset=TSO)
    if rows[rows.region == "Belgium"].tso_p50.sum() <= 0 or rows.region.nunique() < 12:
        return False
    month = f"{day:%Y-%m}"
    boosters = models(month, version)
    merged = None
    for name in FROZEN:
        c = calibrate(name, predict(rows, name, boosters, version), table, ledger, version)
        part = c[["datetime", "region", "elevation", "tso_p10", "tso_p50", "tso_p90"]].copy()
        part[f"{name}_raw_p10"], part[f"{name}_p50"], part[f"{name}_raw_p90"] = c.p10, c.p50, c.p90
        part[f"{name}_p10"], part[f"{name}_p90"] = c.p10c, c.p90c
        merged = part if merged is None else merged.merge(part, on=["datetime", "region", "elevation", "tso_p10", "tso_p50", "tso_p90"])
    merged = merged.sort_values(["region", "datetime"])
    merged["datetime"] = merged.datetime.dt.strftime("%Y-%m-%dT%H:%MZ")
    previous = chain_order()  # the newest issued file is the head of the chain
    now = pd.Timestamp.now(tz="UTC")
    doc = {"target_date": f"{day:%Y-%m-%d}", "issued_at": now.strftime("%Y-%m-%dT%H:%MZ"),
           "mode": "live" if day >= LIVE_FROM else "backfill", "model_month": month, "model": version,
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
        line = {"date": doc["target_date"], "mode": doc["mode"], "issued_at": doc["issued_at"], "rows": len(be), "model": doc.get("model", "v1")}
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
    today = tomorrow - pd.Timedelta(days=1)
    for run in (today - pd.Timedelta(days=1), today):
        date = f"{run:%Y-%m-%d}"
        download_gfs.main(date, date)
    build(TABLE, live=True)
    table = pd.read_parquet(TABLE)
    table["datetime"] = table["datetime"].astype("datetime64[ns, UTC]")
    for day in pd.date_range(FIRST, tomorrow, freq="D"):
        if not (LEDGER / f"{day:%Y-%m-%d}.json").exists():
            issue(day, table, read_ledger("v2" if day >= V2_FROM else "v1"))
    score(table)
    tom = LEDGER / f"{tomorrow:%Y-%m-%d}.json"
    print("tomorrow issued" if tom.exists() else "tomorrow not issued yet", flush=True)


if __name__ == "__main__":
    train(sys.argv[2]) if sys.argv[1] == "train" else run()
