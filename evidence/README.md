# Frozen v2 headline evidence

The public quarter-hour predictions and daily loss totals make Penumbra's headline
independently checkable in seconds, with pandas and NumPy and no retraining.
From the repository root, run:

```sh
.venv/bin/python src/verify_headline.py
```

Expected results (Penumbra / Elia): Belgium pinball **0.0090 / 0.0101
(−10.8%)**, MAE 2.79% / 2.98%, coverage 80.2% / 81.9%, width 9.1% / 13.3%;
provinces pinball **0.0105 / 0.0117 (−10.0%)**, MAE 3.28% / 3.54%, coverage
80.2% / 75.4%, width 10.5% / 13.2%. Paired daily differences and 95% CIs:
Belgium −0.00106 [−0.00134, −0.00077]; provinces −0.00112 [−0.00135, −0.00090].
The command finishes with `PASS` and exits non-zero on a mismatch.

- `test_v2_intervals.csv.gz`: 205,209 common daylight quarter-hours, one row per
  UTC timestamp and scope (Belgium and 11 provinces, including Brussels).
  Capacity, actual and forecasts are MW; elevation is degrees. MW fields retain
  six decimal places, preserving every published digit and every coverage count.
- `test_v2_daily.csv`: 4,308 day/scope rows with row counts and both methods'
  pinball sums/means, inclusive coverage counts and normalised width sums.
- `test_v2_scores.csv` and `test_v2_ci.json`: unchanged original scoring outputs,
  used as independent numerical references.
- `MANIFEST.json`: file hashes, frozen-spec commit, source provenance, scoring
  rules, precision, licences and the six excluded dates. Hashes cover every other
  file in this folder; the manifest does not hash itself.

Scoring divides every MW value by that row's monitored capacity. Pinball averages
the P10/P50/P90 losses equally. Provinces pool all provincial rows with equal row
weights; they do not average provincial scores. The bootstrap samples the 359
paired UTC-day means with replacement (2,000 draws, NumPy `default_rng(11)`, reset
for each scope, linear 2.5%/97.5% quantiles). Daily means have equal weight in the
CI; the headline table uses equal quarter-hour weights. Calibrated interval bounds
are preserved as scored, without sorting or clipping. Both methods use identical
rows: elevation > 0, available weather, valid actual and all Elia quantiles.

The specified window is 2025-11-01 through 2026-10-31. The frozen input archive
ends on 2026-10-25; 2026-10-26 through 2026-10-31 have no rows in that archive,
leaving 359 scored days. v1 ran once after its freeze; v2 was selected on
validation, frozen in `6e8d5b8`, and ran once on the same test window.

Elia observations, monitored capacities and day-ahead forecasts: **Elia Transmission
Belgium SA**, [Elia Open Data, CC BY 4.0](https://opendata.elia.be/pages/licence/).
Changes: selected common daylight rows, added Penumbra predictions, converted
capacity-normalised predictions to MW, rounded MW values and aggregated losses.
No weather-source files are redistributed. The verifier also works when `data/`
and LightGBM are absent. Test: `.venv/bin/python -m pytest -q src/test_verify_headline.py`.
