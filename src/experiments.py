"""Paired validation experiments on 2025-05..2025-10. Never reads later rows. Raw predictions are cached."""
import json
import sys
from pathlib import Path

import pandas as pd

from backtest import FEATURES, FIRST_OOS, PARAMS, TSO, WEATHER, conformalize, daily_block_ci, fit_predict, report

END = "2025-10-31"
SCORED = pd.Timestamp("2025-05-01", tz="UTC")
SMALL = {**PARAMS, "n_estimators": 200, "learning_rate": 0.03, "num_leaves": 31, "min_child_samples": 500, "n_jobs": 4}
VARIANTS = {
    "residual": dict(feats=FEATURES["grid"], base="tso_p50", params=SMALL),
    "residual_err": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50", params=SMALL),
    "residual_big": dict(feats=FEATURES["grid"] + ["tso_err7", "tso_abs7"], base="tso_p50",
                         params={**SMALL, "n_estimators": 500}),
    "weather_nolag": dict(feats=WEATHER, params={**PARAMS, "n_jobs": 4}),
}
OUT = Path("data/results/exp")


def raw(name):
    path = OUT / f"{name}.parquet"
    if not path.exists():
        table = pd.read_parquet("data/table.parquet").dropna(subset=TSO)
        table = table[table.datetime < pd.Timestamp(END, tz="UTC") + pd.Timedelta(days=1)]
        fit_predict(table, **{"start": FIRST_OOS, "end": END, **VARIANTS[name]}).to_parquet(path)
    return pd.read_parquet(path)


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
    main(sys.argv[1:])
