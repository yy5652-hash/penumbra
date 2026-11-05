"""Rolling-origin backtest: refit each month on past data only, then conformalize with trailing residuals.

Usage: backtest.py val      tune on 2025-05..2025-10 and never read later data
       backtest.py test     run the frozen pipeline on 2025-11..2026-10
"""
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

QUANTILES = [0.1, 0.5, 0.9]
WEATHER = ["elevation", "azimuth", "clear_sky", "doy_sin", "doy_cos", "k_mean", "k_std", "k_min", "k_max",
           "ghi_mean", "cloud_mean", "cloud_std", "temp", "direct_frac",
           "ghi_ecmwf_ifs025", "ghi_icon_seamless", "ghi_gfs_seamless", "ghi_meteofrance_seamless"]
LAGS = ["cf_d2", "perf7"]
TSO = ["tso_p50", "tso_p10", "tso_p90"]
TSO_HISTORY = ["tso_err7", "tso_abs7"]
PARAMS = dict(n_estimators=300, learning_rate=0.05, num_leaves=63, min_child_samples=200, subsample=0.8,
              subsample_freq=1, colsample_bytree=0.8, verbose=-1, n_jobs=6, random_state=7)
RESIDUAL_PARAMS = {**PARAMS, "n_estimators": 200, "learning_rate": 0.03, "num_leaves": 31, "min_child_samples": 500}
FEATURES = {"weather": WEATHER + LAGS, "grid": WEATHER + LAGS + TSO}
# Frozen after validation on 2025-05..2025-10.
FROZEN = {
    "weather": dict(feats=WEATHER, params=PARAMS),
    "grid": dict(feats=WEATHER + LAGS + TSO + TSO_HISTORY, base="tso_p50", params=RESIDUAL_PARAMS),
}
CAL_DAYS = 60
FIRST_OOS = "2025-01-01"


# v2, frozen 2026-11-05 after validation round 2: training history from 2021, fresh GFS, D-1 morning and gap features.
TUNED_PARAMS = {**RESIDUAL_PARAMS, "n_estimators": 400, "learning_rate": 0.02, "num_leaves": 15, "min_child_samples": 1000,
                "colsample_bytree": 0.6}
V2_FEATS = WEATHER + LAGS + TSO + TSO_HISTORY + ["m_ratio1", "m_err1", "k_gfs", "ghi_gfs", "cloud_gfs",
                                                 "tso_k", "gap_d2", "gap_gfs", "kdiff_gfs"]
FROZEN_V2 = {"grid": dict(feats=V2_FEATS, base="tso_p50", params=TUNED_PARAMS)}


def pinball(y, q, a):
    d = y - q
    return np.maximum(a * d, (a - 1) * d)


def fit_predict(table, feats, start, end, base=None, params=PARAMS, history_days=None):
    """One model per month, fitted only on rows before that month. With base, learn quantiles of the residual."""
    out = []
    for month in pd.date_range(start, end, freq="MS", tz="UTC"):
        nxt = month + pd.offsets.MonthBegin(1)
        tr = table[table.datetime < month - pd.Timedelta(days=2)]
        if history_days:
            tr = tr[tr.datetime >= month - pd.Timedelta(days=history_days)]
        te = table[(table.datetime >= month) & (table.datetime < nxt)]
        if te.empty:
            continue
        preds = {}
        for a in QUANTILES:
            m = lgb.LGBMRegressor(objective="quantile", alpha=a, **params)
            m.fit(tr[feats], tr["cf"] - (tr[base] if base else 0))
            preds[a] = m.predict(te[feats]) + (te[base].values if base else 0)
        arr = np.sort(np.clip(np.column_stack([preds[a] for a in QUANTILES]), 0, None), axis=1)
        out.append(te[["datetime", "date", "region", "cf", "elevation", "tso_p10", "tso_p50", "tso_p90", "cf_d2"]]
                   .assign(p10=arr[:, 0], p50=arr[:, 1], p90=arr[:, 2]))
        print(month.date(), len(tr), len(te), flush=True)
    return pd.concat(out, ignore_index=True)


def conformalize(df, days=CAL_DAYS, scoped=False, season=False):
    """Asymmetric rolling CQR. For each day, shift P10 and P90 by trailing out-of-sample errors in the same
    width and solar-height bucket, using only outcomes known by the end of D-2."""
    df = df.sort_values("datetime").reset_index(drop=True)
    df["w"] = df.p90 - df.p10
    df["bin"] = (df.elevation > 15).astype(int) * 3 + np.digitize(df.w, [0.05, 0.15])
    if scoped:
        df["bin"] += 6 * (df.region == "Belgium").astype(int)
    if season:  # November to February get their own shifts
        df["bin"] += 12 * df.datetime.dt.month.isin([11, 12, 1, 2]).astype(int)
    df["lo_err"] = df.p10 - df.cf
    df["hi_err"] = df.cf - df.p90
    df["p10c"], df["p90c"] = df.p10, df.p90
    dates = np.sort(df.date.unique())
    groups = {d: g for d, g in df.groupby("date")}
    for d in dates:
        lo = d - np.timedelta64(days + 2, "D")
        hi = d - np.timedelta64(2, "D")
        recent = [groups[x] for x in dates[(dates >= lo) & (dates < hi)]]
        if len(recent) < 30:
            continue
        cal = pd.concat(recent)
        today = groups[d]
        shift_lo = cal.groupby("bin").lo_err.quantile(0.9)
        shift_hi = cal.groupby("bin").hi_err.quantile(0.9)
        df.loc[today.index, "p10c"] = np.clip(today.p10 - today.bin.map(shift_lo).fillna(0), 0, None)
        df.loc[today.index, "p90c"] = today.p90 + today.bin.map(shift_hi).fillna(0)
    return df.drop(columns=["lo_err", "hi_err"])


def score(df, lo, mid, hi):
    y = df.cf.values
    pb = np.mean([pinball(y, df[c].values, a).mean() for c, a in ((lo, .1), (mid, .5), (hi, .9))])
    inside = (y >= df[lo]) & (y <= df[hi])
    return dict(pinball=pb, mae=np.abs(y - df[mid]).mean(), rmse=np.sqrt(((y - df[mid]) ** 2).mean()),
                cover80=inside.mean(), below10=(y < df[lo]).mean(), above90=(y > df[hi]).mean(),
                width=(df[hi] - df[lo]).mean())


def daily_block_ci(df, a, b, n=2000, seed=11):
    """Bootstrap the paired daily pinball difference, a minus b. Negative means a is better."""
    y = df.cf.values
    def loss(cols):
        return np.mean([pinball(y, df[c].values, q) for c, q in zip(cols, (.1, .5, .9))], axis=0)
    daily = pd.Series(loss(a) - loss(b)).groupby(df.date.values).mean().values
    rng = np.random.default_rng(seed)
    boots = daily[rng.integers(0, len(daily), (n, len(daily)))].mean(axis=1)
    return dict(diff=float(daily.mean()), lo=float(np.quantile(boots, .025)), hi=float(np.quantile(boots, .975)), days=len(daily))


def report(df, label, columns):
    rows = []
    for scope, part in (("Belgium", df[df.region == "Belgium"]), ("Provinces", df[df.region != "Belgium"])):
        for name, cols in columns.items():
            rows.append(dict(scope=scope, method=name, **score(part.dropna(subset=list(cols)), *cols)))
    res = pd.DataFrame(rows)
    print(f"\n== {label}\n", res.round(4).to_string(index=False), flush=True)
    return res


def main_v2():
    """The single v2 run on the test window: same scoring as v1, on the extended table."""
    table = pd.read_parquet("data/table_v2.parquet").dropna(subset=TSO)
    end = "2026-10-31"
    table = table[table.datetime < pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)]
    oos = conformalize(fit_predict(table, start=FIRST_OOS, end=end, **FROZEN_V2["grid"]), scoped=True)
    oos = oos[oos.datetime >= pd.Timestamp("2025-11-01", tz="UTC")].sort_values(["region", "datetime"]).reset_index(drop=True)
    oos.to_parquet("data/results/test_v2_grid.parquet")
    cols = {"TSO (Elia day-ahead 11h)": ("tso_p10", "tso_p50", "tso_p90"), "Penumbra v2": ("p10c", "p50", "p90c")}
    report(oos, "test v2", cols).to_csv("data/results/test_v2_scores.csv", index=False)
    cis = {scope: daily_block_ci(part, cols["Penumbra v2"], cols["TSO (Elia day-ahead 11h)"])
           for scope, part in (("Belgium", oos[oos.region == "Belgium"]), ("Provinces", oos[oos.region != "Belgium"]))}
    print(json.dumps(cis, indent=1))
    Path("data/results/test_v2_ci.json").write_text(json.dumps(cis, indent=1))


def main(stage):
    if stage == "test_v2":
        return main_v2()
    table = pd.read_parquet("data/table.parquet")
    table = table.dropna(subset=["tso_p50", "tso_p10", "tso_p90"])
    if stage == "val":
        scored_from, end = "2025-05-01", "2025-10-31"
    else:
        scored_from, end = "2025-11-01", "2026-10-31"
    out = Path("data/results")
    out.mkdir(exist_ok=True)
    all_res, frames = [], {}
    for name, spec in FROZEN.items():
        table_v = table[table.datetime < pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)]
        oos = conformalize(fit_predict(table_v, start=FIRST_OOS, end=end, **spec), scoped=True)
        frames[name] = oos[oos.datetime >= pd.Timestamp(scored_from, tz="UTC")].sort_values(["region", "datetime"]).reset_index(drop=True)
        frames[name].to_parquet(out / f"{stage}_{name}.parquet")
    base = frames["grid"].copy()
    base = base.assign(w_p10=frames["weather"].p10, w_p50=frames["weather"].p50, w_p90=frames["weather"].p90,
                       w_p10c=frames["weather"].p10c, w_p90c=frames["weather"].p90c)
    cols = {
        "TSO (Elia day-ahead 11h)": ("tso_p10", "tso_p50", "tso_p90"),
        "Weather only, raw": ("w_p10", "w_p50", "w_p90"),
        "Weather only, conformal": ("w_p10c", "w_p50", "w_p90c"),
        "Grid stack, raw": ("p10", "p50", "p90"),
        "Grid stack, conformal": ("p10c", "p50", "p90c"),
    }
    res = report(base, stage, cols)
    res.to_csv(out / f"{stage}_scores.csv", index=False)
    cis = {}
    for scope, part in (("Belgium", base[base.region == "Belgium"]), ("Provinces", base[base.region != "Belgium"])):
        for k in ("Grid stack, conformal", "Weather only, conformal"):
            cis[f"{scope}: {k} vs TSO"] = daily_block_ci(part, cols[k], cols["TSO (Elia day-ahead 11h)"])
    print(json.dumps(cis, indent=1))
    (out / f"{stage}_ci.json").write_text(json.dumps(cis, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
