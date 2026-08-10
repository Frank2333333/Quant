from __future__ import annotations

from datetime import datetime

import pandas as pd
import streamlit as st
from tvscreener import Market, StockField, StockScreener


MA_COLUMNS = {
    "MA5": "Simple Moving Average (5)",
    "MA10": "Simple Moving Average (10)",
    "MA20": "Simple Moving Average (20)",
    "MA30": "Simple Moving Average (30)",
    "MA50": "Simple Moving Average (50)",
}


def fetch_a_share_snapshot() -> pd.DataFrame:
    """Fetch the latest delayed Chinese-market snapshot from TradingView."""
    fields = [
        StockField.NAME,
        StockField.DESCRIPTION,
        StockField.EXCHANGE,
        StockField.TYPE,
        StockField.PRICE,
        StockField.LOW,
        StockField.SIMPLE_MOVING_AVERAGE_5,
        StockField.SIMPLE_MOVING_AVERAGE_10,
        StockField.SIMPLE_MOVING_AVERAGE_20,
        StockField.SIMPLE_MOVING_AVERAGE_30,
        StockField.SIMPLE_MOVING_AVERAGE_50,
    ]
    screener = StockScreener()
    screener.set_markets(Market.CHINA)
    screener.add_option("lang", "zh")
    screener.set_range(0, 8_000)
    screener.select(*fields)
    return screener.get()


def screen_stocks(snapshot: pd.DataFrame, max_pullback_pct: float) -> pd.DataFrame:
    """Keep A-share stocks in MA5>MA10>MA20>MA30>MA50 and touching MA10."""
    frame = snapshot.loc[snapshot["Type"].eq("stock")].copy()
    ma5, ma10, ma20, ma30, ma50 = (frame[column] for column in MA_COLUMNS.values())
    bullish_alignment = (ma5 > ma10) & (ma10 > ma20) & (ma20 > ma30) & (ma30 > ma50)
    frame["距MA10(%)"] = (frame["Low"] / ma10 - 1) * 100
    pullback_without_breaking = (frame["Low"] >= ma10) & (frame["距MA10(%)"] <= max_pullback_pct)
    result = frame.loc[bullish_alignment & pullback_without_breaking].copy()
    result["代码"] = result["Symbol"].str.split(":").str[-1]
    result = result.rename(columns={"Description": "名称", "Price": "最新价", "Low": "最低价"})
    return result[["代码", "名称", "Exchange", "最新价", "最低价", *MA_COLUMNS.values(), "距MA10(%)"]].sort_values(
        "距MA10(%)"
    )


st.set_page_config(page_title="A股均线回踩筛选", page_icon="📈", layout="wide")
st.title("A股均线回踩筛选")
st.caption("数据源：TradingView 中国市场延时行情（通常约15分钟延迟），仅供研究，不构成投资建议。")

max_pullback_pct = st.sidebar.slider("距 MA10 最大距离（%）", 0.1, 5.0, 1.0, 0.1)
st.sidebar.markdown("""
**筛选条件**

1. MA5 > MA10 > MA20 > MA30 > MA50
2. 最新日最低价 ≥ MA10
3. 最低价距 MA10 不超过设定阈值
4. 仅普通股票，自动剔除基金与指数
""")

@st.fragment(run_every="15m")
def market_panel() -> None:
    st.button("立即刷新", type="primary")
    try:
        with st.spinner("正在获取A股行情…"):
            snapshot = fetch_a_share_snapshot()
            result = screen_stocks(snapshot, max_pullback_pct)
        st.session_state["result"] = result
        st.session_state["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    except Exception as error:
        st.error(f"数据获取失败：{error}")

    if "result" not in st.session_state:
        return

    result = st.session_state["result"]
    st.success(f"检测完成：共找到 {len(result)} 只符合条件的A股。更新时间：{st.session_state['updated_at']}")
    display = result.copy()
    display.columns = [*display.columns[:5], "MA5", "MA10", "MA20", "MA30", "MA50", "距MA10(%)"]
    st.dataframe(
        display.style.format(
            {"最新价": "{:.2f}", "最低价": "{:.2f}", "MA5": "{:.2f}", "MA10": "{:.2f}", "MA20": "{:.2f}", "MA30": "{:.2f}", "MA50": "{:.2f}", "距MA10(%)": "{:.2f}%"}
        ),
        use_container_width=True,
        hide_index=True,
    )
    st.download_button("下载 CSV", result.to_csv(index=False).encode("utf-8-sig"), "a_share_ma_pullback.csv", "text/csv")


market_panel()
