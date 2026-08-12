const scannerUrl = "https://scanner.tradingview.com/global/scan";
const headers = { "content-type": "application/json", origin: "https://www.tradingview.com", referer: "https://www.tradingview.com/", "user-agent": "Mozilla/5.0 (compatible; A-share-MA-Screener/1.0)" };
const payload = {
  filter: [], options: { lang: "zh" }, symbols: { query: { types: [] }, tickers: [] }, sort: { sortBy: "market_cap_basic", sortOrder: "desc" }, range: [0, 8000],
  columns: ["name", "description", "exchange", "type", "close", "open", "low", "volume", "average_volume_10d_calc", "SMA5", "SMA10", "SMA10[1]", "SMA20", "SMA30", "SMA50", "volume[1]", "update_mode"], markets: ["china"],
};
const HISTORY_WINDOW_DAYS = 70;
const HISTORY_VISIBLE_DAYS = 5;
const HISTORY_STRATEGY_VERSION = "ma-pullback-v1";

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function isStarST(data) { return /^\*?ST/i.test(String(data?.[1] || data?.[0] || "").trim()); }
function isHistoryStock(row) { return /^(000|001|002|003|300|301|600|601|603|605|688)\d{3}$/.test(row.code) && !isStarST([row.code, row.name]); }
function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function historyKey(date) { return `history:day:${date}`; }
function normalizeHistoryRow(row) {
  const code = String(row?.code || ""), exchange = row?.exchange === "SSE" ? "SSE" : row?.exchange === "SZSE" ? "SZSE" : null;
  const values = [row?.open, row?.high, row?.low, row?.close, row?.volume, row?.amount].map(Number);
  return exchange && /^\d{6}$/.test(code) && values.every(Number.isFinite) ? { code, exchange, name: String(row.name || code), open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4], amount: values[5] } : null;
}
async function historyAuthorized(request, env) {
  const expected = env.HISTORY_INGEST_TOKEN, supplied = request.headers.get("x-history-token") || "";
  return Boolean(expected) && supplied === expected;
}

function baseCandidates(rows) {
  return rows.flatMap(({ s: symbol, d }) => {
    const [name, description, exchange, type, price, , low, volume, averageVolume, ma5, ma10, ma10Previous, ma20, ma30, ma50, volume1] = d;
    if (type !== "stock" || isStarST(d) || ![price, low, volume, averageVolume, ma5, ma10, ma10Previous, ma20, ma30, ma50, volume1].every(Number.isFinite)) return [];
    const distance = (low / ma10 - 1) * 100, priceDistance = (price / ma10 - 1) * 100, trendSlope = (ma10 / ma10Previous - 1) * 100, turnover = price * volume, volumeRatio = volume / averageVolume;
    if (!(ma5 > ma10 && ma10 > ma20 && ma20 > ma30) || Math.abs(distance) > 0.1 || ma10 / ma20 - 1 > 0.10 || ma10 / ma30 - 1 > 0.15 || !(volume < volume1 && volume <= averageVolume) || turnover < 100_000_000) return [];
    return [{ symbol, code: symbol.split(":").pop(), name: description || name, exchange, price, low, ma5, ma10, ma20, ma30, ma50, distance, priceDistance, trendSlope, turnover, volumeRatio, volumeState: "缩量", confirmation: price >= ma10 ? "确认" : "观察" }];
  });
}
function recentStartSignal(candles) {
  const start = Math.max(0, candles.length - 30); let recentStart = false, limitUpRecent = false;
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index], gain = candle.close / candle.open - 1, previous = candles.slice(Math.max(0, index - 10), index), averageVolume = previous.length ? average(previous.map(row => row.volume)) : 0;
    const limitUp = gain >= 0.095, explosive = gain >= 0.05 && previous.length >= 5 && candle.volume >= averageVolume * 1.5;
    if (limitUp || explosive) recentStart = true; if (limitUp) limitUpRecent = true;
  }
  return { recentStart, limitUpRecent };
}
function scoreCandidate(candidate, signal) { return Math.round((signal.limitUpRecent ? 50 : 35) + 25 - Math.min(20, Math.abs(candidate.priceDistance) * 20) + (candidate.volumeRatio <= 0.5 ? 15 : 10) + Math.min(10, candidate.trendSlope * 100)); }
async function screen(rows) {
  const candidates = baseCandidates(rows), matches = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = await Promise.all(candidates.slice(index, index + 8).map(async candidate => { try { const signal = recentStartSignal(await kline(candidate.symbol)); return signal.recentStart ? { ...candidate, limitUpRecent: signal.limitUpRecent, score: scoreCandidate(candidate, signal) } : null; } catch { return null; } }));
    matches.push(...batch.filter(Boolean));
  }
  return matches.sort((a, b) => b.score - a.score || Math.abs(a.priceDistance) - Math.abs(b.priceDistance));
}
function historicalCandidate(series) {
  const target = series.at(-1), ma5 = average(series.slice(-5).map(row => row.close)), ma10 = average(series.slice(-10).map(row => row.close)), ma10Previous = average(series.slice(-11, -1).map(row => row.close)), ma20 = average(series.slice(-20).map(row => row.close)), ma30 = average(series.slice(-30).map(row => row.close)), ma50 = average(series.slice(-50).map(row => row.close)), averageVolume = average(series.slice(-11, -1).map(row => row.volume));
  const distance = (target.low / ma10 - 1) * 100, priceDistance = (target.close / ma10 - 1) * 100, trendSlope = (ma10 / ma10Previous - 1) * 100, volumeRatio = target.volume / averageVolume;
  const signal = recentStartSignal(series.slice(-30));
  if (!(ma5 > ma10 && ma10 > ma20 && ma20 > ma30) || Math.abs(distance) > 0.1 || ma10 / ma20 - 1 > 0.10 || ma10 / ma30 - 1 > 0.15 || !(target.volume < series.at(-2).volume && target.volume <= averageVolume) || target.amount < 100_000_000 || !signal.recentStart) return null;
  const candidate = { symbol: `${target.exchange}:${target.code}`, code: target.code, name: target.name, exchange: target.exchange, price: target.close, low: target.low, ma5, ma10, ma20, ma30, ma50, distance, priceDistance, trendSlope, turnover: target.amount, volumeRatio, volumeState: "缩量", confirmation: target.close >= ma10 ? "确认" : "观察" };
  return { ...candidate, limitUpRecent: signal.limitUpRecent, score: scoreCandidate(candidate, signal) };
}
function screenHistorical(snapshots, date) {
  const dates = snapshots.map(snapshot => snapshot.date), byDate = new Map(snapshots.map(snapshot => [snapshot.date, new Map(snapshot.rows.map(row => [row.code, row]))])), matches = [];
  for (const target of byDate.get(date).values()) { if (!isHistoryStock(target)) continue; const series = dates.map(day => byDate.get(day).get(target.code)); const candidate = series.some(row => !row) ? null : historicalCandidate(series); if (candidate) matches.push(candidate); }
  return matches.sort((a, b) => b.score - a.score || Math.abs(a.priceDistance) - Math.abs(b.priceDistance));
}
async function historyManifest(env) { return (await env.SCREEN_CACHE.get("history:manifest", "json")) || { dates: [], updatedAt: null }; }

function chinaSymbol(symbol) { const [exchange, code] = (symbol || "").split(":"); return /^(SSE|SZSE)$/.test(exchange) && /^\d{6}$/.test(code) ? `${exchange === "SSE" ? "sh" : "sz"}${code}` : null; }
async function kline(symbol) {
  const ticker = chinaSymbol(symbol); if (!ticker) return null;
  const source = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=${ticker},day,,,180,qfq&r=${Date.now()}`;
  try { const text = await (await fetch(source, { headers: { referer: "https://gu.qq.com/" } })).text(); const rows = JSON.parse(text.slice(text.indexOf("=") + 1))?.data?.[ticker]?.qfqday; if (Array.isArray(rows)) return rows.map(([time, open, close, high, low, volume]) => ({ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) })).filter(row => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite)); } catch {}
  try {
    const yahooSymbol = `${ticker.slice(2)}.${ticker.startsWith("sh") ? "SS" : "SZ"}`;
    const chart = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=1y&interval=1d`)).json();
    const result = chart?.chart?.result?.[0], quote = result?.indicators?.quote?.[0];
    if (Array.isArray(result?.timestamp) && quote) return result.timestamp.map((timestamp, index) => ({ time: new Date(timestamp * 1000).toISOString().slice(0, 10), open: Number(quote.open?.[index]), high: Number(quote.high?.[index]), low: Number(quote.low?.[index]), close: Number(quote.close?.[index]), volume: Number(quote.volume?.[index]) })).filter(row => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite));
  } catch {}
  const secid = `${ticker.startsWith("sh") ? 1 : 0}.${ticker.slice(2)}`, fallback = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=0&end=20500101&lmt=180`;
  const rows = (await (await fetch(fallback, { headers: { referer: "https://quote.eastmoney.com/", "user-agent": "Mozilla/5.0" } })).json())?.data?.klines;
  if (!Array.isArray(rows)) throw new Error("K-line data unavailable");
  return rows.map(text => { const [time, open, close, high, low, volume] = text.split(","); return { time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }; }).filter(row => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite));
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/screen") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    try { const response = await fetch(scannerUrl, { method: "POST", headers, body: JSON.stringify(payload) }); if (!response.ok) return json({ error: "行情服务暂时不可用，请稍后重试。" }, 502); const data = await response.json(), sourceRows = data.data || []; const result = { updatedAt: new Date().toISOString(), totalStocks: sourceRows.filter(({ d }) => d?.[3] === "stock" && !isStarST(d)).length, rows: await screen(sourceRows) }; await env.SCREEN_CACHE.put("latest-screen", JSON.stringify(result)); return json(result); } catch { return json({ error: "获取行情时发生网络错误，请稍后重试。" }, 502); }
  }
  if (url.pathname === "/api/latest") { if (request.method !== "GET") return json({ error: "Method not allowed" }, 405); const latest = await env.SCREEN_CACHE.get("latest-screen"); return latest ? new Response(latest, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ error: "No saved result" }, 404); }
  if (url.pathname === "/api/history/dates") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const manifest = await historyManifest(env);
    if (url.searchParams.get("all") === "1") {
      if (!(await historyAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);
      return json({ dates: manifest.dates, updatedAt: manifest.updatedAt });
    }
    return json({ dates: manifest.dates.slice(-HISTORY_VISIBLE_DAYS).reverse(), updatedAt: manifest.updatedAt });
  }
  if (url.pathname === "/api/history/screen") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405); const date = url.searchParams.get("date") || "", manifest = await historyManifest(env), selectedIndex = manifest.dates.indexOf(date);
    if (selectedIndex < 0) return json({ error: "该日期尚未归档" }, 404); const availableDates = manifest.dates.slice(Math.max(0, selectedIndex - HISTORY_WINDOW_DAYS + 1), selectedIndex + 1); if (availableDates.length < 51) return json({ error: "该日期缺少足够的历史日线" }, 409);
    const cacheKey = `history:screen:${HISTORY_STRATEGY_VERSION}:${date}`, cached = await env.SCREEN_CACHE.get(cacheKey, "json"); if (cached) return json(cached);
    const snapshots = await Promise.all(availableDates.map(day => env.SCREEN_CACHE.get(historyKey(day), "json"))); if (snapshots.some(snapshot => !snapshot)) return json({ error: "历史快照不完整" }, 409);
    const target = snapshots.at(-1), result = { source: "eastmoney", selectedDate: date, archivedAt: target.archivedAt, updatedAt: new Date().toISOString(), totalStocks: target.rows.filter(isHistoryStock).length, rows: screenHistorical(snapshots, date) }; await env.SCREEN_CACHE.put(cacheKey, JSON.stringify(result)); return json(result);
  }
  if (url.pathname === "/api/history/ingest") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405); if (!(await historyAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);
    try { const body = await request.json(); if (Array.isArray(body?.dates)) { const dates = [...new Set(body.dates.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort().slice(-HISTORY_WINDOW_DAYS), previous = await historyManifest(env); await Promise.all(previous.dates.filter(day => !dates.includes(day)).map(day => env.SCREEN_CACHE.delete(historyKey(day)))); await env.SCREEN_CACHE.put("history:manifest", JSON.stringify({ dates, updatedAt: new Date().toISOString() })); return json({ dates }); } const date = String(body?.date || ""), rows = Array.isArray(body?.rows) ? body.rows.map(normalizeHistoryRow).filter(Boolean) : []; if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || rows.length < 4000) return json({ error: "Invalid historical snapshot" }, 400); await env.SCREEN_CACHE.put(historyKey(date), JSON.stringify({ date, archivedAt: new Date().toISOString(), source: "eastmoney", rows })); await env.SCREEN_CACHE.delete(`history:screen:${HISTORY_STRATEGY_VERSION}:${date}`); return json({ date, rows: rows.length }); } catch { return json({ error: "Invalid historical payload" }, 400); }
  }
  if (url.pathname === "/api/kline") { if (request.method !== "GET") return json({ error: "Method not allowed" }, 405); try { const rows = await kline(url.searchParams.get("symbol")); return rows ? json({ rows, updatedAt: new Date().toISOString() }) : json({ error: "Invalid symbol" }, 400); } catch { return json({ error: "K-line data is temporarily unavailable" }, 502); } }
  return env.ASSETS.fetch(request);
} };
