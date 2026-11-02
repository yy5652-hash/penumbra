# Devpost submission text

**Project name:** Penumbra

**Elevator pitch:** Tomorrow's solar power, with a margin. Calibrated day-ahead forecasts, checked in public against the grid operator.

**Track:** DN-SU-01 Solar Energy Generation Forecasting

## Overview
Penumbra forecasts tomorrow's solar output as a calibrated range. Anyone can open the site, pick a place and get a P10, P50 and P90 forecast in seconds. For Belgium, each forecast is also published next to the official one from Elia, the national grid operator, and scored the next day.

## Problem
Grid operators, traders and plant owners commit solar power at 11:00 the day before. They need to know how much they can safely promise, so a single number is not enough. A wide range costs money, because uncertainty has to be covered by reserves or left unsold. Accuracy claims are also hard to check: we found no vendor that publishes a daily record next to the grid operator's own forecast.

## Solution
Penumbra does not re-forecast the weather. It learns where the official forecast goes wrong. A LightGBM model learns the P10, P50 and P90 of the gap to Elia's median, using four weather models, solar geometry, recent output and recent Elia error. A rolling conformal step then corrects the band using the last 60 days. A second model uses weather alone, needs no local history, and runs in the visitor's browser for any place.

## Tech stack
Python, pandas, LightGBM, rolling conformal quantile calibration. A static site in plain JavaScript with uPlot, and LightGBM trees exported to JSON for browser inference. A scheduled daily job maintains the ledger.

## Implementation and demo
- Live site: https://yy5652-hash.github.io/penumbra/
- Code: https://github.com/yy5652-hash/penumbra
- Forecast tool: search, GPS or coordinates; capacity in kW or MW; 15-minute chart; a risk slider that turns the band into a commitment; CSV and JSON export; shareable links.
- Public ledger: one forecast per day, each carrying the hash of the one before, checked in the browser. Live forecasts begin with 4 November 2026.
- Parity tests confirm that the browser matches Python to 0.0001 on real weather responses.

## Results and validation
All features existed at the 11:00 cutoff: weather comes from runs at least 48 hours old, and history stops at the end of D-2. Choices were made on May to October 2025. The pipeline was then committed, and it ran once on 359 unseen days, November 2025 to October 2026.

| Method | Scope | Pinball | MAE | 80% coverage | Band width |
|---|---|---|---|---|---|
| Elia day-ahead 11:00 | Belgium | 0.0104 | 3.08% | 83.4% | 13.7% |
| Penumbra | Belgium | 0.0097 | 3.05% | 80.3% | 9.8% |
| Elia day-ahead 11:00 | 11 provinces | 0.0120 | 3.63% | 76.5% | 13.6% |
| Penumbra | 11 provinces | 0.0111 | 3.50% | 80.5% | 11.1% |

The 95% confidence intervals of the paired daily differences exclude zero on both scopes. Quartz, the strongest open-source baseline we found, scored 11.9% MAE on the same provinces with the same-age weather. In three British regions the Belgium-trained weather model reached 4.14% MAE against 11.1% for Quartz, with 75.4% band coverage and no local calibration.

## Impact
Across Belgium's 11.76 GW, the average 80% band falls from 1,616 MW to 1,154 MW. Average P10 rises from 1,919 MW to 2,116 MW; outcomes reached it 89.7% of the time, against 91.9% for Elia's. In provinces the band is 18% narrower while coverage rises from 76.5% to 80.5%.

## Team contributions
Yi Yu: problem framing, data, modelling, validation, product and presentation. AI coding assistants helped write and check code.

## Third-party acknowledgements
Elia Open Data; Open-Meteo.com (CC BY 4.0); Sheffield Solar PV_Live; Energy-Charts; Quartz Solar Forecast (MIT), used only as a baseline; uPlot (MIT).
