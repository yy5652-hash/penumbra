"""Download Elia ods032 (Belgian PV measured + TSO forecasts) since 2023-12."""
from pathlib import Path

import requests

OUT = Path("data/raw/elia_ods032.parquet")
URL = "https://opendata.elia.be/api/explore/v2.1/catalog/datasets/ods032/exports/parquet"
FIELDS = "datetime,region,measured,dayahead11hforecast,dayahead11hconfidence10,dayahead11hconfidence90,mostrecentforecast,monitoredcapacity"


def main():
    if OUT.exists():
        print("already there", OUT.stat().st_size)
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    params = {"select": FIELDS, "where": "datetime >= date'2023-12-01'"}
    with requests.get(URL, params=params, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = OUT.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.rename(OUT)
    print("saved", OUT.stat().st_size)


if __name__ == "__main__":
    main()
