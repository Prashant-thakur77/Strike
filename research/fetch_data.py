"""Download daily prices for the backtest and cache them in research/data/.

Source: Yahoo Finance chart API (v8), one request per symbol, daily bars.
Each CSV keeps the raw close, the split/dividend-adjusted close and the volume.
`research/data/SOURCES.json` records the exact URL and the download time (UTC) for every file.

Run: python3 research/fetch_data.py            (skips symbols already cached)
     python3 research/fetch_data.py --refresh  (downloads again)
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DATA = Path(__file__).resolve().parent / "data"
SYMBOLS = ["TSLA", "NVDA", "AMZN", "SPY", "^VIX"]
# Start early enough to warm up the 21-day volatility window before 2019-01-01.
START = "2018-10-01"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]


def file_name(symbol: str) -> str:
    return symbol.replace("^", "") + ".csv"


def url_for(host: str, symbol: str, p1: int, p2: int) -> str:
    return (
        f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?period1={p1}&period2={p2}&interval=1d&events=div%2Csplit"
    )


def download(symbol: str) -> tuple[pd.DataFrame, str]:
    p1 = int(datetime.fromisoformat(START).replace(tzinfo=timezone.utc).timestamp())
    p2 = int(time.time())
    last_err = None
    for attempt in range(4):
        for host in HOSTS:
            url = url_for(host, symbol, p1, p2)
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    payload = json.load(r)
            except Exception as e:  # noqa: BLE001 - report and retry on the next host
                last_err = e
                continue
            res = payload["chart"]["result"][0]
            q = res["indicators"]["quote"][0]
            adj = res["indicators"].get("adjclose", [{}])[0].get("adjclose", q["close"])
            tz = res["meta"].get("exchangeTimezoneName", "America/New_York")
            dates = pd.to_datetime(res["timestamp"], unit="s", utc=True).tz_convert(tz).date
            df = pd.DataFrame(
                {"date": pd.to_datetime(dates), "close": q["close"], "adj_close": adj, "volume": q["volume"]}
            ).dropna(subset=["close", "adj_close"])
            df = df.drop_duplicates("date", keep="last").sort_values("date")
            return df, url
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"could not download {symbol}: {last_err}")


def main() -> None:
    refresh = "--refresh" in sys.argv
    DATA.mkdir(parents=True, exist_ok=True)
    meta_path = DATA / "SOURCES.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    for sym in SYMBOLS:
        path = DATA / file_name(sym)
        if path.exists() and not refresh:
            print(f"{sym}: cached ({path.name})")
            continue
        df, url = download(sym)
        df.to_csv(path, index=False, date_format="%Y-%m-%d")
        meta[sym] = {
            "file": path.name,
            "source": "Yahoo Finance chart API v8 (daily bars; adj_close is split- and dividend-adjusted)",
            "url": url,
            "downloaded_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "rows": int(len(df)),
            "first": df["date"].min().strftime("%Y-%m-%d"),
            "last": df["date"].max().strftime("%Y-%m-%d"),
        }
        print(f"{sym}: {len(df)} rows {meta[sym]['first']} .. {meta[sym]['last']}")
        time.sleep(1.5)
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
