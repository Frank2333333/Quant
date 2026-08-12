const scannerUrl = "https://scanner.tradingview.com/global/scan";
const headers = {
  "content-type": "application/json",
  origin: "https://www.tradingview.com",
  referer: "https://www.tradingview.com/",
  "user-agent": "Mozilla/5.0 (compatible; A-share-MA-Screener/1.0)",
};

const payload = {
  filter: [],
  options: { lang: "zh" },
  symbols: { query: { types: [] }, tickers: [] },
  sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
  range: [0, 8000],
  columns: ["name", "description", "exchange", "type", "close", "open", "low", "volume", "average_volume_10d_calc", "SMA5", "SMA10", "SMA10[1]", "SMA20", "SMA30", "SMA50", "volume[1]", "update_mode"],
  markets: ["china"],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isStarST(data) {
  return /^[*＊]\s*ST/i.test(String(data?.[1] || data?.[0] || "").trim());
}

function baseCandidates(rows) {
  return rows.flatMap(({ s: symbol, d }) => {
    const [name, description, exchange, type, price, , low, volume, averageVolume, ma5, ma10, ma10Previous, ma20, ma30, ma50, volume1] = d;
    if (type !== "stock" || isStarST(d) || ![price, low, volume, averageVolume, ma5, ma10, ma10Previous, ma20, ma30, ma50, volume1].every(Number.isFinite)) return [];
    const distance = (low / ma10 - 1) * 100;
    const priceDistance = (price / ma10 - 1) * 100;
    const trendSlope = (ma10 / ma10Previous - 1) * 100;
    const turnover = price * volume;
    const volumeRatio = volume / averageVolume;
    const trend = ma5 > ma10 && ma10 > ma20 && ma20 > ma30;
    const pullback = Math.abs(distance) <= 0.1;
    const maSpacing = ma10 / ma20 - 1 <= 0.10 && ma10 / ma30 - 1 <= 0.15;
    const shrinkingVolume = volume < volume1 && volume <= averageVolume;
    if (!trend || !pullback || !maSpacing || !shrinkingVolume || turnover < 100_000_000) return [];
    const confirmation = price >= ma10 ? "确认" : "观察";
    const volumeState = "缩量";
    return [{ symbol, code: symbol.split(":").pop(), name: description || name, exchange, price, low, ma5, ma10, ma20, ma30, ma50, distance, priceDistance, trendSlope, turnover, volumeRatio, volumeState, confirmation }];
  });
}

function recentStartSignal(candles) {
  const start = Math.max(0, candles.length - 30);
  let recentStart = false, limitUpRecent = false;
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    const gain = candle.close / candle.open - 1;
    const previous = candles.slice(Math.max(0, index - 10), index);
    const averageVolume = previous.reduce((sum, row) => sum + row.volume, 0) / previous.length;
    const limitUp = gain >= 0.095;
    const explosive = gain >= 0.05 && previous.length >= 5 && candle.volume >= averageVolume * 1.5;
    if (limitUp || explosive) recentStart = true;
    if (limitUp) limitUpRecent = true;
  }
  return { recentStart, limitUpRecent };
}

async function screen(rows) {
  const candidates = baseCandidates(rows);
  const matches = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = await Promise.all(candidates.slice(index, index + 8).map(async candidate => {
      try {
        const signal = recentStartSignal(await kline(candidate.symbol));
        if (!signal.recentStart) return null;
        const score = Math.round(
          + (signal.limitUpRecent ? 50 : 35)
          + 25 - Math.min(20, Math.abs(candidate.priceDistance) * 20)
          + (candidate.volumeRatio <= 0.5 ? 15 : 10)
          + Math.min(10, candidate.trendSlope * 100),
        );
        return { ...candidate, limitUpRecent: signal.limitUpRecent, score };
      } catch (error) {
        return null;
      }
    }));
    matches.push(...batch.filter(Boolean));
  }
  return matches.sort((a, b) => b.score - a.score || Math.abs(a.priceDistance) - Math.abs(b.priceDistance));
}

function chinaSymbol(symbol) {
  const [exchange, code] = (symbol || "").split(":");
  if (!/^(SSE|SZSE)$/.test(exchange) || !/^\d{6}$/.test(code)) return null;
  return `${exchange === "SSE" ? "sh" : "sz"}${code}`;
}

async function kline(symbol) {
  const ticker = chinaSymbol(symbol);
  if (!ticker) return null;
  const source = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=${ticker},day,,,180,qfq&r=${Date.now()}`;
  try {
    const response = await fetch(source, { headers: { referer: "https://gu.qq.com/" } });
    const text = await response.text();
    const rows = JSON.parse(text.slice(text.indexOf("=") + 1))?.data?.[ticker]?.qfqday;
    if (Array.isArray(rows)) return rows.map(([time, open, close, high, low, volume]) => ({
      time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
    })).filter(({ time, open, high, low, close }) => time && [open, high, low, close].every(Number.isFinite));
  } catch (error) {
    // Fall through to the alternate public source.
  }
  const secid = `${ticker.startsWith("sh") ? 1 : 0}.${ticker.slice(2)}`;
  const fallback = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&lmt=180`;
  try {
    const response = await fetch(fallback, { headers: { referer: "https://quote.eastmoney.com/", "user-agent": "Mozilla/5.0" } });
    const rows = (await response.json())?.data?.klines;
    if (Array.isArray(rows)) return rows.map(row => {
      const [time, open, close, high, low, volume] = row.split(",");
      return { time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
    }).filter(({ time, open, high, low, close }) => time && [open, high, low, close].every(Number.isFinite));
  } catch (error) {
    // Fall through to the globally available source.
  }
  const yahooSymbol = `${ticker.slice(2)}.${ticker.startsWith("sh") ? "SS" : "SZ"}`;
  const end = Math.floor(Date.now() / 1000), start = end - 240 * 24 * 60 * 60;
  const yahoo = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${start}&period2=${end}&interval=1d`;
  const result = (await (await fetch(yahoo)).json())?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!Array.isArray(result?.timestamp) || !quote) throw new Error("K-line data unavailable");
  return result.timestamp.map((timestamp, index) => ({
    time: new Date(timestamp * 1000).toISOString().slice(0, 10), open: quote.open[index], high: quote.high[index], low: quote.low[index], close: quote.close[index], volume: quote.volume[index],
  })).filter(({ time, open, high, low, close }) => time && [open, high, low, close].every(Number.isFinite));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/screen") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        const response = await fetch(scannerUrl, { method: "POST", headers, body: JSON.stringify(payload) });
        if (!response.ok) return json({ error: "行情服务暂时不可用，请稍后重试。" }, 502);
        const data = await response.json();
        const sourceRows = data.data || [];
        const result = {
          updatedAt: new Date().toISOString(),
          totalStocks: sourceRows.filter(({ d }) => d?.[3] === "stock" && !isStarST(d)).length,
          rows: await screen(sourceRows),
        };
        await env.SCREEN_CACHE.put("latest-screen", JSON.stringify(result));
        return json(result);
      } catch (error) {
        return json({ error: "获取行情时发生网络错误，请稍后重试。" }, 502);
      }
    }
    if (url.pathname === "/api/latest") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const latest = await env.SCREEN_CACHE.get("latest-screen");
      return latest
        ? new Response(latest, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })
        : json({ error: "No saved result" }, 404);
    }
    if (url.pathname === "/api/kline") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        const rows = await kline(url.searchParams.get("symbol"));
        if (!rows) return json({ error: "Invalid symbol" }, 400);
        return json({ rows, updatedAt: new Date().toISOString() });
      } catch (error) {
        return json({ error: "K-line data is temporarily unavailable" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
