"""Paired validation experiments on 2025-05..2025-10. Never reads later rows. Raw predictions are cached."""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from backtest import FEATURES, FIRST_OOS, PARAMS, TSO, WEATHER, conformalize, daily_block_ci, fit_predict, report

END = "2025-10-31"
SCORED = pd.Timestamp("2025-05-01", tz="UTC")
SMALL = {**PARAMS, "n_estimators": 200, "learning_rate": 0.03, "num_leaves": 31, "min_child_samples": 500, "n_jobs": 4}
TUNED = {**SMALL, "n_estimators": 400, "learning_rate": 0.02, "num_leaves": 15, "min_child_samples": 1000, "colsample_bytree": 0.6}
VARIANTS = {
    "residual": dict(feats=FEATURES["grid"], base="tso_p50", params=SMALL),
    "residual_err": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50", params=SMALL),
    "residual_big": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50",
                         params={**SMALL, "n_estimators": 500}),
    "weather_nolag": dict(feats=WEATHER, params={**PARAMS, "n_jobs": 4}),
    "res_tuned": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50",
                      params={**SMALL, "n_estimators": 400, "learning_rate": 0.02, "num_leaves": 15,
                              "min_child_samples": 1000, "colsample_bytree": 0.6}),
    "res_morning": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1"], base="tso_p50", params=SMALL),
    "res_tm": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1"], base="tso_p50", params=TUNED),
    "res_gfs": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1", "k_gfs", "ghi_gfs", "cloud_gfs"],
                    base="tso_p50", params=TUNED),
    "res_gap": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1", "k_gfs", "ghi_gfs", "cloud_gfs",
                                               "tso_k", "gap_d2", "gap_gfs", "kdiff_gfs"], base="tso_p50", params=TUNED),
    "res_gap_240d": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1", "k_gfs", "ghi_gfs", "cloud_gfs",
                                                    "tso_k", "gap_d2", "gap_gfs", "kdiff_gfs"], base="tso_p50", params=TUNED, history_days=240),
    "res_fresh": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7", "m_ratio1", "m_err1", "k_ec", "ghi_ec", "k_gfs", "ghi_gfs", "cloud_gfs"],
                      base="tso_p50", params=TUNED),
    "res_bag": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50", params=SMALL, seeds=[1, 2, 3, 4, 5]),
}
VARIANTS["res_ec"] = dict(feats=VARIANTS["res_gap"]["feats"] + ["k_ec", "ghi_ec", "gap_ec", "kdiff_ec"],
                          base="tso_p50", params=TUNED)
VARIANTS["res_ext"] = {**VARIANTS["res_gap"], "table": "data/table_v2.parquet"}
VARIANTS["res_ext_ec"] = {**VARIANTS["res_ec"], "table": "data/table_v2.parquet"}
VARIANTS["res_ext_big"] = {**VARIANTS["res_ext"], "params": {**TUNED, "n_estimators": 800, "num_leaves": 31}}
VARIANTS["res_ext_slow"] = {**VARIANTS["res_ext"], "params": {**TUNED, "n_estimators": 1200, "learning_rate": 0.01}}
OUT = Path("data/results/exp")


def raw(name):
    path = OUT / f"{name}.parquet"
    if not path.exists():
        spec = dict(VARIANTS[name])
        table = pd.read_parquet(spec.pop("table", "data/table.parquet")).dropna(subset=TSO)
        table = table[table.datetime < pd.Timestamp(END, tz="UTC") + pd.Timedelta(days=1)]
        seeds = spec.pop("seeds", None)
        if seeds:  # average the raw quantiles of several seeds, then re-sort
            runs = [fit_predict(table, start=FIRST_OOS, end=END, **{**spec, "params": {**spec["params"], "random_state": s}}) for s in seeds]
            out = runs[0].copy()
            for q in ("p10", "p50", "p90"):
                out[q] = sum(r[q].values for r in runs) / len(runs)
            out[["p10", "p50", "p90"]] = np.sort(out[["p10", "p50", "p90"]].values, axis=1)
            out.to_parquet(path)
        else:
            fit_predict(table, start=FIRST_OOS, end=END, **spec).to_parquet(path)
    return pd.read_parquet(path)


def calib(name):
    """Calibration choices on one cached raw run: no refit needed."""
    df = raw(name)
    cols = {}
    frames = {}
    for label, kw in {"scoped": dict(scoped=True), "scoped+season": dict(scoped=True, season=True),
                      "scoped 30d": dict(scoped=True, days=30), "scoped 90d": dict(scoped=True, days=90),
                      "scoped+season 90d": dict(scoped=True, season=True, days=90)}.items():
        c = conformalize(df, **kw)
        frames[label] = c[c.datetime >= SCORED].sort_values(["region", "datetime"]).reset_index(drop=True)
    base = frames["scoped"].copy()
    for label, c in frames.items():
        base[f"lo {label}"], base[f"hi {label}"] = c.p10c.values, c.p90c.values
        cols[label] = (f"lo {label}", "p50", f"hi {label}")
    cols["TSO"] = ("tso_p10", "tso_p50", "tso_p90")
    report(base, f"calibration on {name}", cols)
    winter = base[base.datetime.dt.month.isin([11, 12, 1, 2])]
    if len(winter):
        report(winter, "winter rows only", cols)


def main(names):
    OUT.mkdir(parents=True, exist_ok=True)
    for name in names:
        df = raw(name)
        for scoped in (False, True):
            c = conformalize(df, scoped=scoped)
            c = c[c.datetime >= SCORED].sort_values(["region", "datetime"]).reset_index(drop=True)
            cols = {"TSO": ("tso_p10", "tso_p50", "tso_p90"), f"{name} raw": ("p10", "p50", "p90"),
                    f"{name} conformal scoped={scoped}": ("p10c", "p50", "p90c")}
            report(c, f"{name} scoped={scoped}", cols)
            for scope, part in (("Belgium", c[c.region == "Belgium"]), ("Provinces", c[c.region != "Belgium"])):
                print(scope, json.dumps(daily_block_ci(part, ("p10c", "p50", "p90c"), ("tso_p10", "tso_p50", "tso_p90"))), flush=True)


if __name__ == "__main__":
    calib(sys.argv[2]) if sys.argv[1] == "calib" else main(sys.argv[1:])
