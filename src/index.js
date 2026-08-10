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
  columns: ["name", "description", "exchange", "type", "close", "low", "SMA5", "SMA10", "SMA20", "SMA30", "SMA50", "update_mode"],
  markets: ["china"],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function screen(rows) {
  return rows.flatMap(({ s: symbol, d }) => {
    const [name, description, exchange, type, price, low, ma5, ma10, ma20, ma30, ma50] = d;
    if (type !== "stock" || ![price, low, ma5, ma10, ma20, ma30, ma50].every(Number.isFinite)) return [];
    const distance = (low / ma10 - 1) * 100;
    const aligned = ma5 > ma10 && ma10 > ma20 && ma20 > ma30 && ma30 > ma50;
    const touched = low >= ma10 && distance <= 0.1;
    if (!aligned || !touched) return [];
    return [{ code: symbol.split(":").pop(), name: description || name, exchange, price, low, ma5, ma10, ma20, ma30, ma50, distance }];
  }).sort((a, b) => a.distance - b.distance);
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
        return json({ updatedAt: new Date().toISOString(), rows: screen(data.data || []) });
      } catch (error) {
        return json({ error: "获取行情时发生网络错误，请稍后重试。" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
