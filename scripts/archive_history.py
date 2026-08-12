"""Archive free Eastmoney A-share daily bars for the historical replay feature."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

INGEST_URL = os.environ["HISTORY_INGEST_URL"]
TOKEN = os.environ["HISTORY_INGEST_TOKEN"]
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
FIELDS = "f2,f5,f6,f12,f13,f14,f15,f16,f17,f18,f19,f20,f21,f22,f23,f24,f25,f26,f37,f38,f39,f40,f41,f45,f46,f47,f48,f49,f50,f51,f52,f55,f57,f58,f59,f60,f62,f100,f124"
FS = "m:0+t:6+f:!2,m:0+t:80+f:!2,m:0+t:81+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:1+t:24+f:!2,m:1+t:25+f:!2,m:1+t:26+f:!2,m:1+t:27+f:!2,m:1+t:28+f:!2,m:1+t:29+f:!2"


def request_json(url: str, payload: dict | None = None, token: bool = False) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    headers = dict(HEADERS)
    if data: headers["Content-Type"] = "application/json"
    if token: headers["X-History-Token"] = TOKEN
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=45) as response:
                return json.load(response)
        except Exception as error:
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"request failed: {url}: {last_error}")


def universe() -> tuple[str, list[dict]]:
    query = urllib.parse.urlencode({"pn": 1, "pz": 6000, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f3", "fs": FS, "fields": FIELDS})
    data = request_json(f"https://push2.eastmoney.com/api/qt/clist/get?{query}").get("data", {})
    rows = data.get("diff") or []
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    source_date = datetime.fromtimestamp(int(rows[0].get("f124", 0)), ZoneInfo("Asia/Shanghai")).date().isoformat() if rows else ""
    if source_date != today:
        raise RuntimeError(f"Eastmoney snapshot is not current: {source_date or 'unknown'}")
    stocks = []
    for row in rows:
        code, market = str(row.get("f12", "")), int(row.get("f13", -1))
        if market not in (0, 1) or not code.isdigit() or len(code) != 6: continue
        stocks.append({"code": code, "exchange": "SSE" if market == 1 else "SZSE", "name": str(row.get("f14") or code), "open": row.get("f17"), "high": row.get("f15"), "low": row.get("f16"), "close": row.get("f2"), "volume": row.get("f5"), "amount": row.get("f6")})
    if len(stocks) < 4000: raise RuntimeError(f"incomplete stock universe: {len(stocks)}")
    return today, stocks


def normalized(stock: dict) -> dict | None:
    try:
        values = [float(stock[key]) for key in ("open", "high", "low", "close", "volume", "amount")]
        if any(value <= 0 for value in values): return None
        return {**{key: stock[key] for key in ("code", "exchange", "name")}, **dict(zip(("open", "high", "low", "close", "volume", "amount"), values))}
    except (KeyError, TypeError, ValueError): return None


def upload_snapshot(date: str, rows: list[dict]) -> None:
    response = request_json(INGEST_URL, {"date": date, "rows": rows}, token=True)
    if response.get("rows") != len(rows): raise RuntimeError(f"snapshot upload rejected for {date}: {response}")
    print(f"uploaded {date}: {len(rows)} stocks", flush=True)


def archive_daily() -> None:
    date, raw_rows = universe()
    rows = [row for row in (normalized(stock) for stock in raw_rows) if row]
    upload_snapshot(date, rows)
    manifest = request_json(f"{INGEST_URL.rsplit('/ingest', 1)[0]}/dates?all=1", token=True)
    dates = sorted(set(manifest.get("dates", []) + [date]))[-70:]
    request_json(INGEST_URL, {"dates": dates}, token=True)
    print(f"manifest now contains {len(dates)} trading days", flush=True)


def stock_history(stock: dict) -> list[tuple[str, dict]]:
    secid = f"{1 if stock['exchange'] == 'SSE' else 0}.{stock['code']}"
    query = urllib.parse.urlencode({"secid": secid, "ut": "fa5fd1943c7b386f172d6893dbfba10b", "fields1": "f1,f2,f3,f4,f5,f6", "fields2": "f51,f52,f53,f54,f55,f56,f57", "klt": 101, "fqt": 1, "beg": 0, "end": 20500101, "lmt": 180})
    klines = request_json(f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{query}").get("data", {}).get("klines") or []
    output = []
    for text in klines:
        parts = text.split(",")
        if len(parts) < 7: continue
        try:
            row = normalized({**stock, "open": parts[1], "close": parts[2], "high": parts[3], "low": parts[4], "volume": parts[5], "amount": parts[6]})
            if row: output.append((parts[0], row))
        except (IndexError, ValueError): pass
    return output


def backfill() -> None:
    _, stocks = universe()
    by_date: dict[str, list[dict]] = defaultdict(list)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(stock_history, stock) for stock in stocks]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                for date, row in future.result(): by_date[date].append(row)
            except Exception: pass
            if index % 500 == 0: print(f"fetched {index}/{len(stocks)} stocks", flush=True)
    dates = [date for date, rows in sorted(by_date.items()) if len(rows) >= 4000][-70:]
    if len(dates) < 55: raise RuntimeError(f"only {len(dates)} complete historical days available")
    for date in dates: upload_snapshot(date, by_date[date])
    request_json(INGEST_URL, {"dates": dates}, token=True)
    print(f"backfill complete: {dates[-5:]}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("daily", "backfill"))
    args = parser.parse_args()
    backfill() if args.mode == "backfill" else archive_daily()
