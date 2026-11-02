"""Download Belgian imbalance prices (Elia ods134) and day-ahead prices (Energy-Charts) for the value backtest."""
from pathlib import Path

import pandas as pd
import requests

OUT = Path("data/raw")


def main():
    path = OUT / "imbalance.parquet"
    if not path.exists():
        url = "https://opendata.elia.be/api/explore/v2.1/catalog/datasets/ods134/exports/parquet"
        params = {"select": "datetime,imbalanceprice,systemimbalance", "where": "datetime >= date'2025-05-01'"}
        r = requests.get(url, params=params, timeout=300)
        r.raise_for_status()
        path.write_bytes(r.content)
    path = OUT / "dayahead.parquet"
    if not path.exists():
        r = requests.get("https://api.energy-charts.info/price",
                         params=dict(bzn="BE", start="2025-05-01", end="2026-10-31"), timeout=180)
        r.raise_for_status()
        j = r.json()
        frame = pd.DataFrame({"datetime": pd.to_datetime(j["unix_seconds"], unit="s", utc=True), "price": j["price"]})
        frame.drop_duplicates("datetime").sort_values("datetime").to_parquet(path)
    a = pd.read_parquet(OUT / "imbalance.parquet")
    b = pd.read_parquet(path)
    print(a.shape, a.datetime.min(), a.datetime.max(), a.imbalanceprice.describe().round(1).to_dict())
    print(b.shape, b.datetime.min(), b.datetime.max(), b.price.describe().round(1).to_dict())
    print(b.datetime.diff().value_counts().head(3))


if __name__ == "__main__":
    main()
