"""Run the Belgium-trained weather model, frozen as validated, on three GB regions it has never seen.

Training and calibration use Belgian rows only. GB outcomes are used only to score.
"""
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from backtest import FROZEN, QUANTILES, TSO, WEATHER, conformalize, score
from download_gb import GB
from features import weather_features

START, END = "2025-09-01", "2026-10-31"
SCORED = pd.Timestamp("2025-11-01", tz="UTC")


def gb_table():
    out = pd.read_parquet("data/raw/gb_pvlive.parquet")
    out["end"] = pd.to_datetime(out.datetime_gmt, utc=True)
    out = out.drop_duplicates(["region", "end"])
    tables = []
    for name, (_, lat, lon) in GB.items():
        raw = pd.concat(pd.read_parquet(p) for p in sorted(Path("data/weather_gb").glob(f"{name}_*.parquet")))
        f = weather_features(raw, lat, lon).reset_index(names="datetime")
        g = out[out.region == name]
        cf = (g.generation_mw / g.installedcapacity_mwp).values
        # PV_Live stamps the end of each half hour: both quarter-hours inside it take its mean.
        late = pd.DataFrame({"datetime": g.end - pd.Timedelta(minutes=15), "actual": cf})
        early = pd.DataFrame({"datetime": g.end - pd.Timedelta(minutes=30), "actual": cf})
        t = f.merge(pd.concat([late, early]), on="datetime").assign(region=name)
        tables.append(t.sort_values("datetime"))
    t = pd.concat(tables, ignore_index=True)
    t = t[(t.elevation > 0) & t.k_mean.notna() & t.actual.notna()]
    t["date"] = t.datetime.dt.floor("D")
    return t


def main():
    be = pd.read_parquet("data/table.parquet").dropna(subset=TSO)
    be = be[be.region != "Belgium"]
    gb = gb_table()
    feats, params = FROZEN["weather"]["feats"], FROZEN["weather"]["params"]
    parts = []
    for month in pd.date_range(START, END, freq="MS", tz="UTC"):
        nxt = month + pd.offsets.MonthBegin(1)
        tr = be[be.datetime < month - pd.Timedelta(days=2)]
        te = pd.concat([d[(d.datetime >= month) & (d.datetime < nxt)] for d in (be, gb)], ignore_index=True)
        if te.empty:
            continue
        pr = np.column_stack([lgb.LGBMRegressor(objective="quantile", alpha=a, **params).fit(tr[feats], tr.cf).predict(te[feats])
                              for a in QUANTILES])
        pr = np.sort(np.clip(pr, 0, None), axis=1)
        parts.append(te.assign(p10=pr[:, 0], p50=pr[:, 1], p90=pr[:, 2])[
            ["datetime", "date", "region", "cf", "actual", "elevation", "p10", "p50", "p90"]])
    all_rows = pd.concat(parts, ignore_index=True)
    # GB rows have no cf, so they receive Belgian shifts and never add to the calibration set.
    done = conformalize(all_rows)
    done = done[(done.datetime >= SCORED) & done.actual.notna()]
    done = done.assign(cf=done.actual)
    rows = {r: score(g, "p10c", "p50", "p90c") for r, g in done.groupby("region")}
    rows["All GB"] = score(done, "p10c", "p50", "p90c")
    res = pd.DataFrame(rows).T
    print(res.round(4).to_string())
    res.to_csv("data/results/gb_scores.csv")
    done.to_parquet("data/results/gb.parquet")


if __name__ == "__main__":
    main()
