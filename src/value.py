"""What the sharper band is worth to a Belgian operator, per stage: firm power and settlement."""
import json
import sys

import numpy as np
import pandas as pd


def main(stage):
    df = pd.read_parquet(f"data/results/{stage}_grid.parquet")
    be = df[df.region == "Belgium"].copy()
    elia = pd.read_parquet("data/raw/elia_ods032.parquet")
    elia["datetime"] = pd.to_datetime(elia.datetime, utc=True)
    cap = elia[(elia.region == "Belgium") & (elia.datetime >= be.datetime.min())].monitoredcapacity.median()
    imb = pd.read_parquet("data/raw/imbalance.parquet")[["datetime", "imbalanceprice"]]
    imb["datetime"] = pd.to_datetime(imb.datetime, utc=True).astype("datetime64[ns, UTC]")
    da = pd.read_parquet("data/raw/dayahead.parquet").sort_values("datetime")
    da["datetime"] = pd.to_datetime(da.datetime, utc=True).astype("datetime64[ns, UTC]")
    be["datetime"] = be.datetime.astype("datetime64[ns, UTC]")
    be = be.sort_values("datetime").merge(imb.drop_duplicates("datetime"), on="datetime", how="left")
    be = pd.merge_asof(be, da, on="datetime").dropna(subset=["imbalanceprice", "price"])
    days = be.date.nunique()
    out = {"stage": stage, "days": days, "capacity_mw": float(cap),
           "firm_p10_mw": {"tso": float(be.tso_p10.mean() * cap), "ours": float(be.p10c.mean() * cap)},
           "reliability_p10": {"tso": float((be.cf >= be.tso_p10).mean()), "ours": float((be.cf >= be.p10c).mean())},
           "band_mw": {"tso": float((be.tso_p90 - be.tso_p10).mean() * cap), "ours": float((be.p90c - be.p10c).mean() * cap)}}
    daily = {}
    for name, nom in (("tso", be.tso_p50), ("ours", be.p50)):
        daily[name] = (((be.imbalanceprice - be.price) * (be.cf - nom) * 0.25)).groupby(be.date).sum()
        out[f"settlement_eur_per_mwp_year_{name}"] = float(daily[name].mean() * 365)
        out[f"deviation_mwh_per_mwp_year_{name}"] = float(((be.cf - nom).abs() * 0.25).groupby(be.date).sum().mean() * 365)
    d = (daily["ours"] - daily["tso"]).values
    rng = np.random.default_rng(11)
    boots = d[rng.integers(0, len(d), (2000, len(d)))].mean(axis=1) * 365
    out["settlement_delta_ci"] = [float(d.mean() * 365), float(np.quantile(boots, .025)), float(np.quantile(boots, .975))]
    print(json.dumps(out, indent=1))
    with open(f"data/results/{stage}_value.json", "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
