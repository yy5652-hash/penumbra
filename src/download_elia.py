"""Download Elia ods032 (Belgian PV measured + TSO forecasts): since 2023-12, and with `hist` 2021-01 to 2023-11."""
from pathlib import Path

import requests

OUT = Path("data/raw/elia_ods032.parquet")
URL = "https://opendata.elia.be/api/explore/v2.1/catalog/datasets/ods032/exports/parquet"
FIELDS = "datetime,region,measured,dayahead11hforecast,dayahead11hconfidence10,dayahead11hconfidence90,mostrecentforecast,monitoredcapacity"


def main(out=OUT, where="datetime >= date'2023-12-01'"):
    if out.exists():
        print("already there", out.stat().st_size)
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    params = {"select": FIELDS, "where": where}
    with requests.get(URL, params=params, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = out.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.rename(out)
    print("saved", out.stat().st_size)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["hist"]:
        main(Path("data/raw/elia_ods032_hist.parquet"), "datetime >= date'2021-01-01' and datetime < date'2023-12-01'")
    else:
        main()
