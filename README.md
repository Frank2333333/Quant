# A股均线回踩筛选器

## 运行

```powershell
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --extra-index-url https://pypi.org/simple
python -m streamlit run app.py
```

浏览器打开程序显示的本地地址后即可查看结果；页面每15分钟自动刷新，也可点击“立即刷新”。

## 筛选规则

- `MA5 > MA10 > MA20 > MA30 > MA50`
- 最新日最低价回踩至 MA10 上方 0–0.1%（不破MA10）。0.1%用于适配均线小数与股票最小价格变动单位，避免“严格相等”漏掉真实触线的股票
- 仅保留普通A股，剔除基金与指数；证券名称使用中文简称

行情来自 TradingView 中国市场接口，通常存在约15分钟延迟；不构成投资建议。
