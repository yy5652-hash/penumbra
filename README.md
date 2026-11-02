# Penumbra

Tomorrow's solar power, with a margin. Penumbra gives calibrated P10, P50 and P90 day-ahead forecasts, and checks them in public against the grid operator.

**Live site:** https://yy5652-hash.github.io/penumbra/
**Deck:** https://yy5652-hash.github.io/penumbra/Penumbra_DATANOVA_2026.pptx
Built for DATANOVA 2026, track DN-SU-01 Solar Energy Generation Forecasting.

## Results

359 unseen days, 2025-11 to 2026-10, daylight quarter-hours, as a share of monitored capacity. The pipeline was committed in `b1ed71c` before this window was run, and it ran once.

| Method | Scope | Pinball | MAE | 80% band coverage | Band width |
|---|---|---|---|---|---|
| Elia day-ahead 11:00 | Belgium | 0.0104 | 3.08% | 83.4% | 13.7% |
| **Penumbra grid** | Belgium | **0.0097** | 3.05% | 80.3% | **9.8%** |
| Elia day-ahead 11:00 | 11 provinces | 0.0120 | 3.63% | 76.5% | 13.6% |
| **Penumbra grid** | 11 provinces | **0.0111** | 3.50% | 80.5% | **11.1%** |
| Penumbra weather only | 11 provinces | 0.0138 | 4.34% | 79.6% | 13.4% |
| Quartz, open source | 11 provinces | | 11.9% | | |

- The paired daily pinball difference against Elia is -0.00067 in Belgium, 95% CI [-0.00097, -0.00038], and -0.00078 in provinces, [-0.00103, -0.00054].
- Three British regions the model never saw: MAE 4.14% against 11.1% for Quartz on the same rows, with 75.4% band coverage and no local calibration.
- For the Belgian system the average band falls from 1,616 MW to 1,154 MW. Average P10 rises from 1,919 MW to 2,116 MW; outcomes reached it 89.7% of the time, against 91.9% for Elia's.

`EXPERIMENTS.md` records every run, including the variants that were rejected.

## How it works

1. **Inputs that existed at the cutoff.** Elia's 11:00 forecast, four weather models from runs at least 48 hours old, solar geometry, and history that stops at the end of D-2.
2. **Residual quantiles.** LightGBM learns P10, P50 and P90 of the gap to Elia's median, refit monthly on past data with a 2-day gap.
3. **Rolling calibration.** Conformal shifts from the trailing 60 days, by band width and sun height, with national and provincial rows apart.

The tool on the site uses a second model that needs only coordinates and capacity. It runs in the browser, so coordinates go from the visitor to Open-Meteo and nothing reaches us. The output assumes a typical fleet mix; tilt and orientation are not modelled yet.

## Public ledger

`ledger/<date>.json` holds one forecast per target date, written once, with the SHA-256 of the previous file. `ledger/scores.json` scores each finished day. Live forecasts begin with 2026-11-04. Earlier files are marked `backfill`, because they were computed afterwards from data available at their cutoff. Elia published no 11:00 forecast for 2026-10-28 to 10-31, so those dates have no entry.

## Reproduce

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python pandas pyarrow lightgbm scikit-learn requests matplotlib
export PYTHONPATH=src
.venv/bin/python src/download_elia.py
.venv/bin/python src/download_weather.py
.venv/bin/python src/download_prices.py
.venv/bin/python src/features.py
.venv/bin/python src/backtest.py val
.venv/bin/python src/backtest.py test
.venv/bin/python src/value.py test
.venv/bin/python src/download_gb.py
.venv/bin/python src/portability.py
node --test site/test/*.test.mjs
python3 -m http.server --directory site 8765
```

On macOS without Homebrew libomp, prefix the LightGBM commands with `DYLD_LIBRARY_PATH=$PWD/.venv/lib/python3.11/site-packages/sklearn/.dylibs`. Quartz runs in its own environment: see `src/quartz_baseline.py` for the pinned versions noted in `PROGRESS.md`.

## Sources and credits

- Solar generation and forecasts, imbalance prices: [Elia Open Data](https://opendata.elia.be/), Elia Transmission Belgium SA, CC BY 4.0. Values are converted to a share of monitored capacity.
- Weather and geocoding: [Open-Meteo.com](https://open-meteo.com/), CC BY 4.0.
- British outturn: [Sheffield Solar PV_Live](https://www.solar.sheffield.ac.uk/pvlive/), CC BY 4.0. Values are converted to a share of installed capacity.
- Day-ahead prices: [Energy-Charts](https://energy-charts.info/).
- Baseline: [Quartz Solar Forecast](https://github.com/openclimatefix/open-source-quartz-solar-forecast), MIT, used for comparison only.
- Chart library: [uPlot](https://github.com/leeoniya/uPlot), MIT.

Development used AI coding assistants; the author reviewed the code and validated every result.

## Licence

MIT. See `LICENSE`. Data remains under its own licence.
