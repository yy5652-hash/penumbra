# Penumbra

Tomorrow's solar power, with a margin. Penumbra gives calibrated P10, P50 and P90 day-ahead forecasts, and checks them in public against the grid operator.

**Live site:** https://yy5652-hash.github.io/penumbra/
**Deck:** https://yy5652-hash.github.io/penumbra/Penumbra_DATANOVA_2026.pptx
Built for DATANOVA 2026, track DN-SU-01 Solar Energy Generation Forecasting.

## Results

359 test days, 2025-11 to 2026-10. Scores cover daylight quarter-hours as a share of monitored capacity.

| Method | Scope | Pinball | MAE | 80% band coverage | Band width |
|---|---|---|---|---|---|
| Elia day-ahead 11:00 | Belgium | 0.0101 | 2.98% | 81.9% | 13.3% |
| Penumbra v2 | Belgium | 0.0090 (-10.8%) | 2.79% | 80.2% | 9.1% |
| Elia day-ahead 11:00 | 11 provinces | 0.0117 | 3.54% | 75.4% | 13.2% |
| Penumbra v2 | 11 provinces | 0.0105 (-10.0%) | 3.28% | 80.2% | 10.5% |

- Paired daily pinball difference: Belgium -0.00106 [-0.00134, -0.00077]; provinces -0.00112 [-0.00135, -0.00090] (95% confidence intervals).
- Three British regions the model never saw: MAE 4.14% against 11.1% for Quartz on the same rows, with 75.4% band coverage and no local calibration.
- The average Belgian band falls from 1,561 MW to 1,073 MW. Mean P10 rises from 1,851 MW to 2,054 MW. Output met P10 in 89.9% of intervals for Penumbra, against 90.4% for Elia.

`EXPERIMENTS.md` records every run, including the variants that were rejected.

## How it works

1. **Inputs that existed at the cutoff.** Inputs include four weather models from runs at least 48 hours old, fresh GFS 00z of D-1 from the NOAA archive, and D-1 morning measured output before the 11:00 cutoff. Training history starts in 2021. Other output lags stop at D-2.
2. **Residual quantiles.** LightGBM learns P10, P50 and P90 of the gap to Elia's median, refit monthly on past data with a 2-day gap.
3. **Rolling calibration.** Conformal shifts from the trailing 60 days, by band width and sun height, with national and provincial rows apart.

The test window was used twice: first by v1, then by v2, which was chosen on validation and frozen in 16e4605 before its single run. The first frozen version was v1 (`b1ed71c`).

The tool on the site uses a second model that needs only coordinates and capacity. It runs in the browser, so coordinates go from the visitor to Open-Meteo and nothing reaches us. The output assumes a typical fleet mix; tilt and orientation are not modelled yet.

## Public ledger

`ledger/<date>.json` holds one forecast per target date, written once, with the SHA-256 of the previous file. `ledger/scores.json` scores each finished day. Live forecasts begin with 2026-11-04. Target dates from 2026-11-08 use v2 for grid forecasts; new forecast files and daily scores record the model version. Earlier files are marked `backfill`, because they were computed afterwards from data available at their cutoff. Elia published no 11:00 forecast for 2026-10-28, so that date has no entry; 10-29 to 10-31 appeared later and are backfill.

## Reproduce

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python pandas pyarrow lightgbm scikit-learn requests matplotlib eccodes
export PYTHONPATH=src
.venv/bin/python src/download_elia.py
.venv/bin/python src/download_elia.py hist
.venv/bin/python src/download_weather.py
.venv/bin/python src/download_prices.py
.venv/bin/python src/download_gfs.py 2021-01-01
.venv/bin/python src/features.py
.venv/bin/python src/features.py extended
.venv/bin/python src/backtest.py val
# Frozen v2 test artifacts are already recorded; do not rerun the test window.
.venv/bin/python src/value.py test_v2
.venv/bin/python src/download_gb.py
.venv/bin/python src/portability.py
node --test site/test/*.test.mjs
python3 -m http.server --directory site 8765
```

On macOS without Homebrew libomp, prefix the LightGBM commands with `DYLD_LIBRARY_PATH=$PWD/.venv/lib/python3.11/site-packages/sklearn/.dylibs`. Quartz runs in its own environment: see `src/quartz_baseline.py` for the pinned versions noted in `PROGRESS.md`.

## Sources and credits

- Solar generation and forecasts, imbalance prices: [Elia Open Data](https://opendata.elia.be/), Elia Transmission Belgium SA, CC BY 4.0. Values are converted to a share of monitored capacity.
- Fresh GFS 00z runs: [NOAA GFS archive](https://noaa-gfs-bdp-pds.s3.amazonaws.com/).
- Weather and geocoding: [Open-Meteo.com](https://open-meteo.com/), CC BY 4.0.
- British outturn: [Sheffield Solar PV_Live](https://www.solar.sheffield.ac.uk/pvlive/), CC BY 4.0. Values are converted to a share of installed capacity.
- Day-ahead prices: [Energy-Charts](https://energy-charts.info/).
- Baseline: [Quartz Solar Forecast](https://github.com/openclimatefix/open-source-quartz-solar-forecast), MIT, used for comparison only.
- Chart library: [uPlot](https://github.com/leeoniya/uPlot), MIT.

Development used AI coding assistants; the author reviewed the code and validated every result.

## Licence

MIT. See `LICENSE`. Data remains under its own licence.
