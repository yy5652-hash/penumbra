# Devpost gallery

Run `.venv/bin/python tools/resume-round3.py --browser-only` from the repository root in a local terminal. The script serves `site/` on a private local port, checks the three horizons and slide viewer, and saves these English screenshots at 1600 × 1000 pixels:

1. `01-cambridge-forecast.png`: Cambridge forecast and uncertainty band.
2. `02-horizon-choice.png`: the D+3 choice and forecast.
3. `03-ledger.png`: public ledger.
4. `04-evidence.png`: evidence section.
5. `05-deck.png`: first presentation slide.

`manifest.json` records dimensions, capture times and hashes. Each image and its manifest entry are saved atomically. The tool uses a fresh browser context with no personal profile. Forecast screenshots require a successful real Open-Meteo response.
