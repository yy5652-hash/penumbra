"""Verify the frozen v2 headline from public CSVs; pandas/numpy only, no training.

Run from any directory: .venv/bin/python src/verify_headline.py
Scoring and bootstrap mirror backtest.score/daily_block_ci without importing LightGBM.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

EVIDENCE = Path(__file__).resolve().parent.parent / "evidence"
METHODS = {"TSO (Elia day-ahead 11h)": "elia", "Penumbra v2": "penumbra"}
METRICS = ("pinball", "mae", "rmse", "cover80", "below10", "above90", "width")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def interval_losses(frame):
    """All losses are shares of each row's monitored capacity, never MW weighted."""
    capacity = frame.capacity_mw.to_numpy()
    y = frame.actual_mw.to_numpy() / capacity
    result = frame[["date", "scope"]].copy()
    for prefix in METHODS.values():
        lo, mid, hi = (frame[f"{prefix}_p{q}_mw"].to_numpy() / capacity for q in (10, 50, 90))
        losses = []
        for forecast, quantile in ((lo, .1), (mid, .5), (hi, .9)):
            delta = y - forecast
            losses.append(np.maximum(quantile * delta, (quantile - 1) * delta))
        result[f"{prefix}_pinball"] = np.mean(losses, axis=0)
        result[f"{prefix}_mae"] = np.abs(y - mid)
        result[f"{prefix}_mse"] = (y - mid) ** 2
        result[f"{prefix}_cover80"] = (y >= lo) & (y <= hi)
        result[f"{prefix}_below10"] = y < lo
        result[f"{prefix}_above90"] = y > hi
        result[f"{prefix}_width"] = hi - lo
    return result


def daily_summary(losses):
    aggregation = {"rows_scored": ("scope", "size")}
    for prefix in METHODS.values():
        aggregation.update({
            f"{prefix}_pinball_sum": (f"{prefix}_pinball", "sum"),
            f"{prefix}_pinball_mean": (f"{prefix}_pinball", "mean"),
            f"{prefix}_coverage_count": (f"{prefix}_cover80", "sum"),
            f"{prefix}_width_sum": (f"{prefix}_width", "sum"),
        })
    return losses.groupby(["date", "scope"], sort=True).agg(**aggregation).reset_index()


def results(losses):
    scores, cis = [], {}
    for scope, part in (("Belgium", losses[losses.scope == "Belgium"]),
                        ("Provinces", losses[losses.scope != "Belgium"])):
        for method, prefix in METHODS.items():
            means = {metric: float(part[f"{prefix}_{metric}"].mean())
                     for metric in METRICS if metric != "rmse"}
            means["rmse"] = float(np.sqrt(part[f"{prefix}_mse"].mean()))
            scores.append(dict(scope=scope, method=method, **means))
        # Match backtest.daily_block_ci: row-level paired differences, daily means,
        # sorted UTC dates, equal weight per day, fresh RNG for each scope.
        daily = (part.penumbra_pinball - part.elia_pinball).groupby(part.date, sort=True).mean().to_numpy()
        rng = np.random.default_rng(11)
        boots = daily[rng.integers(0, len(daily), (2000, len(daily)))].mean(axis=1)
        cis[scope] = dict(diff=float(daily.mean()), lo=float(np.quantile(boots, .025)),
                          hi=float(np.quantile(boots, .975)), days=len(daily))
    return pd.DataFrame(scores), cis


def check_references(scores, cis, reference, reference_ci):
    keys = ["scope", "method"]
    reference = reference.set_index(keys)
    computed = scores.set_index(keys)
    require(set(computed.index) == set(reference.index), "Reference scope/method mismatch")
    for key, row in computed.iterrows():
        for metric in METRICS:
            # The original scorer prints all seven metrics to four decimal places.
            expected, actual = reference.loc[key, metric], row[metric]
            require(f"{actual:.4f}" == f"{expected:.4f}",
                    f"{key} {metric}: {actual:.4f} != {expected:.4f}")
        # Also check the percentage formatting used by EXPERIMENTS.md.
        for metric, digits in (("mae", 2), ("cover80", 1), ("width", 1)):
            expected, actual = reference.loc[key, metric] * 100, row[metric] * 100
            require(f"{actual:.{digits}f}" == f"{expected:.{digits}f}",
                    f"{key} {metric} differs at published percentage precision")
    require(set(cis) == set(reference_ci), "Reference CI scope mismatch")
    for scope, values in cis.items():
        for metric in ("diff", "lo", "hi"):
            actual, expected = values[metric], reference_ci[scope][metric]
            require(f"{actual:.5f}" == f"{expected:.5f}",
                    f"{scope} CI {metric}: {actual:.5f} != {expected:.5f}")
        require(values["days"] == reference_ci[scope]["days"], f"{scope} CI day count differs")
        for table in (computed, reference):
            ours = table.loc[(scope, "Penumbra v2"), "pinball"]
            elia = table.loc[(scope, "TSO (Elia day-ahead 11h)"), "pinball"]
            if table is computed:
                change = f"{100 * (ours / elia - 1):.1f}"
            else:
                require(change == f"{100 * (ours / elia - 1):.1f}",
                        f"{scope} relative pinball change differs")


def verify(evidence=EVIDENCE):
    manifest = json.loads((evidence / "MANIFEST.json").read_text())
    for name, metadata in manifest["files"].items():
        contents = (evidence / name).read_bytes()
        require(len(contents) == metadata["bytes"], f"Size mismatch: {name}")
        require(hashlib.sha256(contents).hexdigest() == metadata["sha256"], f"SHA-256 mismatch: {name}")

    frame = pd.read_csv(evidence / "test_v2_intervals.csv.gz")
    require(len(frame) == manifest["rows_scored"], "Interval row count differs")
    require(not frame.isna().any().any(), "Missing interval values")
    numeric = frame.drop(columns=["timestamp_utc", "scope"])
    require(np.isfinite(numeric.to_numpy()).all(), "Non-finite interval values")
    require((frame.capacity_mw > 0).all(), "Non-positive monitored capacity")
    require((frame.elevation_deg > 0).all(), "Non-daylight interval")
    timestamps = pd.to_datetime(frame.timestamp_utc, utc=True)
    require((timestamps == timestamps.dt.floor("15min")).all(), "Not quarter-hour timestamps")
    require(not frame.duplicated(["timestamp_utc", "scope"]).any(), "Duplicate interval/scope")
    require(set(frame.scope) == set(manifest["scopes"]), "Scope inventory differs")
    frame["date"] = timestamps.dt.strftime("%Y-%m-%d")
    window = manifest["test_window"]
    require(frame.date.between(window["start"], window["end"]).all(), "Interval outside test window")
    all_dates = set(pd.date_range(window["start"], window["end"]).strftime("%Y-%m-%d"))
    excluded = {entry["date"] for entry in window["excluded_dates"]}
    require(all_dates - set(frame.date) == excluded, "Excluded dates differ")
    for scope, part in frame.groupby("scope"):
        require(part.date.nunique() == window["days_scored"], f"{scope} scored days differ")
        require(len(part) == manifest["scopes"][scope], f"{scope} row count differs")

    losses = interval_losses(frame)
    daily = daily_summary(losses)
    stored_daily = pd.read_csv(evidence / "test_v2_daily.csv")
    pd.testing.assert_frame_equal(daily, stored_daily, check_dtype=False, rtol=1e-12, atol=1e-12)
    scores, cis = results(losses)
    check_references(scores, cis, pd.read_csv(evidence / "test_v2_scores.csv"),
                     json.loads((evidence / "test_v2_ci.json").read_text()))

    print(f"Scored {len(frame):,} common daylight quarter-hours across {window['days_scored']} UTC days "
          f"(Belgium + {len(manifest['scopes']) - 1} provinces).")
    display = scores[["scope", "method", "pinball", "mae", "cover80", "width"]].copy()
    display["pinball"] = display.pinball.map(lambda x: f"{x:.4f}")
    for metric, digits in (("mae", 2), ("cover80", 1), ("width", 1)):
        display[metric] = display[metric].map(lambda x: f"{x * 100:.{digits}f}%")
    print(display.to_string(index=False))
    for scope, values in cis.items():
        part = scores[scores.scope == scope].set_index("method").pinball
        change = 100 * (part["Penumbra v2"] / part["TSO (Elia day-ahead 11h)"] - 1)
        print(f"{scope}: pinball {change:+.1f}%; paired daily difference {values['diff']:.5f} "
              f"[{values['lo']:.5f}, {values['hi']:.5f}] (95% CI, {values['days']} days)")
    print("PASS: SHA-256, daily aggregates, all score metrics and paired daily CIs match at published precision.")
    return scores, cis


if __name__ == "__main__":
    try:
        verify()
    except (ValueError, AssertionError, OSError, KeyError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
