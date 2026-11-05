"""Export what the static site needs: the any-location model, its calibration shifts, the ledger, and parity fixtures.

The fixtures hold a real Open-Meteo response plus the features and forecast Python computes from it. The browser code
must reproduce them, so what users see is the same model the backtest scored.
"""
import json
import shutil
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from backtest import FROZEN, QUANTILES, TSO
from download_weather import MODELS as NWP, VARS, request_weather
from features import weather_features
from live import MODELS, chain_order, read_ledger

SITE = Path("site")
FIXTURE_PLACES = {"cambridge": (52.2, 0.12), "brussels": (50.85, 4.37), "lisbon": (38.72, -9.14)}


def flatten(tree):
    """Write one tree as parallel arrays. Internal nodes come first in index order; leaves use negative child ids."""
    split, thresh, left, right, default_left, miss, leaves = [], [], [], [], [], [], []

    def walk(node):
        if "leaf_value" in node:
            leaves.append(round(node["leaf_value"], 7))
            return -len(leaves)
        i = len(split)
        split.append(node["split_feature"])
        thresh.append(float(f'{node["threshold"]:.10g}'))
        left.append(0), right.append(0)
        default_left.append(1 if node["default_left"] else 0)
        miss.append({"None": 0, "Zero": 1, "NaN": 2}[node["missing_type"]])
        if node["decision_type"] != "<=":
            raise ValueError(node["decision_type"])
        left[i] = walk(node["left_child"])
        right[i] = walk(node["right_child"])
        return i

    root = walk(tree["tree_structure"])
    return {"r": root, "f": split, "t": thresh, "a": left, "b": right, "d": default_left, "m": miss, "v": leaves}


def export_model(month, horizon=1):
    from horizons import site_boosters
    (SITE / "model").mkdir(parents=True, exist_ok=True)
    out = {"features": FROZEN["weather"]["feats"], "month": month, "horizon": horizon, "quantiles": {}}
    for a, b in zip(QUANTILES, site_boosters(horizon, month)):
        dump = b.dump_model()
        if dump["feature_names"] != out["features"]:
            raise ValueError("feature order changed")
        out["quantiles"][str(int(a * 100))] = {"trees": [flatten(t) for t in dump["tree_info"]]}
    path = SITE / "model" / f"weather_h{horizon}.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    if horizon == 1:
        shutil.copy(path, SITE / "model" / "weather.json")
    print("model bytes", path.stat().st_size)


def shifts():
    """Latest shifts per bin for sites without history, from Belgian provinces over the trailing 60 days."""
    table = pd.read_parquet("data/live_table.parquet")[["datetime", "region", "cf"]]
    keep = ["datetime", "date", "region", "elevation", "p10", "p50", "p90"]
    pool = pd.read_parquet("data/results/test_weather.parquet")[keep]
    led = read_ledger()
    if "weather" in led:
        pool["datetime"] = pool["datetime"].astype("datetime64[ns, UTC]")
        pool["date"] = pool["date"].astype("datetime64[ns, UTC]")
        extra = led["weather"][keep].copy()
        extra["datetime"] = extra["datetime"].astype("datetime64[ns, UTC]")
        extra["date"] = extra["date"].astype("datetime64[ns, UTC]")
        pool = pd.concat([pool, extra], ignore_index=True)
    for frame, cols in ((pool, ["datetime", "date"]), (table, ["datetime"])):
        for col in cols:  # parquet and JSON give different datetime types
            frame[col] = frame[col].astype("datetime64[ns, UTC]")
    pool = pool[pool.region != "Belgium"].merge(table, on=["datetime", "region"]).dropna(subset=["cf"])
    last = pool.date.max()
    cal = pool[pool.date > last - pd.Timedelta(days=60)]
    bins = (cal.elevation > 15).astype(int) * 3 + np.digitize(cal.p90 - cal.p10, [0.05, 0.15])
    lo = (cal.p10 - cal.cf).groupby(bins).quantile(0.9)
    hi = (cal.cf - cal.p90).groupby(bins).quantile(0.9)
    out = {"through": f"{last:%Y-%m-%d}", "days": 60, "lo": [round(float(lo.get(i, 0)), 5) for i in range(6)],
           "hi": [round(float(hi.get(i, 0)), 5) for i in range(6)]}
    (SITE / "data").mkdir(parents=True, exist_ok=True)
    path = SITE / "data" / "shifts.json"
    if path.exists():
        old = json.loads(path.read_text())
        out.update({k: old[k] for k in ('h2', 'h3') if k in old})
    path.write_text(json.dumps(out))
    return out


def forecast_python(raw, lat, lon, month, sh, horizon=1):
    from horizons import site_boosters
    feats = weather_features(raw, lat, lon, previous_day=horizon + 1)
    feats = feats[feats.elevation > 0]
    names = FROZEN["weather"]["feats"]
    pr = np.column_stack([b.predict(feats[names]) for b in site_boosters(horizon, month)])
    pr = np.sort(np.clip(pr, 0, None), axis=1)
    w = pr[:, 2] - pr[:, 0]
    b = (feats.elevation.values > 15).astype(int) * 3 + np.digitize(w, [0.05, 0.15])
    p10c = np.clip(pr[:, 0] - np.array(sh["lo"])[b], 0, None)
    p90c = pr[:, 2] + np.array(sh["hi"])[b]
    # Thin bins can shift a band past its median, which a user-facing range must not show.
    p10c, p90c = np.minimum(p10c, pr[:, 1]), np.maximum(p90c, pr[:, 1])
    return feats, pr, p10c, p90c


def fixtures(month, sh, horizon=1):
    root = SITE / "test" / "fixtures"
    root.mkdir(parents=True, exist_ok=True)
    tomorrow = pd.Timestamp.now(tz="UTC").floor("D") + pd.Timedelta(days=horizon)
    start, end = tomorrow - pd.Timedelta(days=1), tomorrow + pd.Timedelta(days=1)
    hourly = [f"{v}_previous_day{horizon + 1}" for v in VARS]
    for name, (lat, lon) in FIXTURE_PLACES.items():
        suffix = '' if horizon == 1 else f'_h{horizon}'
        path = root / f"{name}{suffix}.json"
        if horizon > 1 and path.exists():
            saved = json.loads(path.read_text())
            if saved.get('shifts') == sh and saved.get('modelMonth', month) == month:
                print(name, 'resumed fixture', flush=True)
                continue
        params = dict(latitude=lat, longitude=lon, start_date=f"{start:%Y-%m-%d}", end_date=f"{end:%Y-%m-%d}",
                      hourly=",".join(hourly), models=",".join(NWP), timezone="UTC")
        body = request_weather(params)
        raw = pd.DataFrame(body["hourly"])
        raw["time"] = pd.to_datetime(raw["time"], utc=True)
        feats, pr, p10c, p90c = forecast_python(raw, lat, lon, month, sh, horizon=horizon)
        names = FROZEN["weather"]["feats"]
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps({
            "horizon": horizon,
            "modelMonth": month,
            "lat": lat, "lon": lon, "open_meteo": body, "times": feats.index.strftime("%Y-%m-%dT%H:%MZ").tolist(),
            "features": {n: [None if np.isnan(v) else float(v) for v in feats[n]] for n in names},
            "raw": {"p10": pr[:, 0].tolist(), "p50": pr[:, 1].tolist(), "p90": pr[:, 2].tolist()},
            "p10": p10c.tolist(), "p90": p90c.tolist(), "shifts": sh}, separators=(",", ":")))
        tmp.replace(path)
        print(name, len(feats), "rows")
        time.sleep(4)


def copy_ledger():
    target = SITE / "ledger"
    target.mkdir(parents=True, exist_ok=True)
    for path in Path("ledger").glob("*.json"):
        shutil.copy(path, target / path.name)
    # The hash chain follows issue order: a day Elia published late is issued, and linked, after newer days.
    days = [p.stem for p in chain_order()]
    (target / "index.json").write_text(json.dumps({"days": days}))


def main(args):
    """`export_site.py daily` refreshes shifts and the ledger; `export_site.py YYYY-MM` also exports model and fixtures."""
    if args[0] == 'horizons':
        from horizons import latest_shifts
        month = args[1] if len(args) > 1 else f"{pd.Timestamp.now(tz='UTC'):%Y-%m}"
        path = SITE / 'data' / 'shifts.json'
        sh = json.loads(path.read_text())
        # Preserve the current h1 model, calibration and real parity fixtures.
        shutil.copy(SITE / 'model' / 'weather.json', SITE / 'model' / 'weather_h1.json')
        for horizon in (2, 3):
            sh[f'h{horizon}'] = latest_shifts(horizon, pd.Timestamp.now(tz='UTC'))
            export_model(month, horizon=horizon)
            fixtures(month, sh[f'h{horizon}'], horizon=horizon)
            latest = json.loads(path.read_text())
            latest[f'h{horizon}'] = sh[f'h{horizon}']
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(latest))
            tmp.replace(path)
        return
    sh = shifts()
    print(sh)
    copy_ledger()
    if args != ["daily"]:
        export_model(args[0])
        fixtures(args[0], sh)


if __name__ == "__main__":
    main(sys.argv[1:] or [f"{pd.Timestamp.now(tz='UTC'):%Y-%m}"])
