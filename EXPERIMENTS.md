# Experiments

All scores are on daylight quarter-hours, as a share of monitored capacity. Weather is at least 48 h old at the
11:00 D-1 cutoff. Only the pipeline frozen in commit b1ed71c ran on the test window, and it ran once.

## Validation, 2025-05..2025-10 (184 days)
| Change | Scope | Pinball | MAE | Cover 80 | Width | Verdict |
|---|---|---|---|---|---|---|
| Elia day-ahead 11h | Belgium | 0.0111 | 3.28% | 80.4% | 13.8% | reference |
| Elia day-ahead 11h | Provinces | 0.0126 | 3.86% | 73.9% | 13.6% | reference |
| Quartz on 48 h ICON | Provinces | | 10.9% | | | public baseline, bias +7.3% |
| Weather + lags, conformal | Provinces | 0.0157 | 5.20% | 78.3% | 14.1% | half of Quartz's MAE |
| Weather, no lags, scoped calibration | Provinces | 0.0157 | 5.23% | 79.4% | 14.2% | no history needed: kept for any site |
| Stack on TSO inputs, conformal | Belgium | 0.0111 | 3.55% | 84.1% | 12.1% | tie, median worse |
| H1 residual quantiles on TSO P50 | Belgium | 0.0106 | 3.31% | 85.7% | 12.1% | CI excludes 0 |
| H1 + H3 calibrate Belgium apart | Belgium | 0.0105 | 3.31% | 79.6% | 10.4% | fixes over-coverage |
| H1 + H2 trailing TSO error + H3 | Belgium | 0.0104 | 3.28% | 79.8% | 10.3% | **frozen** |
| H1 + H2 trailing TSO error + H3 | Provinces | 0.0120 | 3.78% | 79.9% | 11.9% | **frozen** |
| Same with 500 trees | Belgium | 0.0106 | 3.37% | 79.8% | 10.6% | worse, rejected |
| Open-Meteo Single Runs API for fresher runs | | | | | | run not available for 2024 or 2025, dead end |

## Test, 2025-11..2026-10 (359 days), single run
| Method | Scope | Pinball | MAE | Cover 80 | Width |
|---|---|---|---|---|---|
| Elia day-ahead 11h | Belgium | 0.0104 | 3.08% | 83.4% | 13.7% |
| Penumbra grid | Belgium | 0.0097 | 3.05% | 80.3% | 9.8% |
| Elia day-ahead 11h | Provinces | 0.0120 | 3.63% | 76.5% | 13.6% |
| Penumbra grid | Provinces | 0.0111 | 3.50% | 80.5% | 11.1% |
| Penumbra weather only | Provinces | 0.0138 | 4.34% | 79.6% | 13.4% |
| Quartz on 48 h ICON | Provinces | | 11.9% | | |
| Persistence, D-2 | Provinces | | 8.97% | | |

Paired daily pinball difference against Elia, 2,000 block bootstrap draws, Penumbra grid:
Belgium -0.00067 [-0.00097, -0.00038]; provinces -0.00078 [-0.00103, -0.00054].

## Operator value, Belgium, 11.76 GW monitored
| Metric | Elia | Penumbra | Period |
|---|---|---|---|
| Mean band | 1,616 MW | 1,154 MW | test |
| Mean P10 | 1,919 MW | 2,116 MW | test |
| Share of time output met P10 | 91.9% | 89.7% | test |
| Settlement difference, P50 nomination | | +361 EUR/MWp/yr [87, 638] | test |
| Settlement difference, P50 nomination | | -114 EUR/MWp/yr [-538, 302] | validation |

The settlement gain is not stable across the two periods, so it stays out of the headline numbers.

## Portability: Belgium-trained, no GB data in training or calibration, 2025-11..2026-10
| Region | Pinball | MAE | Cover 80 | Width |
|---|---|---|---|---|
| Eastern | 0.0135 | 4.16% | 75.6% | 13.4% |
| Southern | 0.0138 | 4.24% | 73.7% | 13.3% |
| South-Western | 0.0130 | 4.05% | 76.9% | 13.8% |
| All three | 0.0134 | 4.15% | 75.4% | 13.5% |

Same three regions, on the 48,899 rows both models cover: Quartz on 48 h ICON MAE 11.1%, bias +7.2%; Penumbra 4.14%.
Band coverage falls short of the 80% target when a region supplies no outcomes, so the site reports this figure.

## Monthly coverage of the 80% band, Belgium, test window
Penumbra 72.5% to 85.4%, lowest in January; Elia 73.5% to 93.2%.

## Forward check after the test
Backfilled days since Elia's new datasets, 2026-10-26, 10-27, 11-01, 11-02, Belgium: Penumbra pinball 0.0081, Elia 0.0096; coverage 68% and 86%; band 7.9% and 12.5%.
Four autumn days are too few to judge, so the live ledger decides whether coverage holds.
