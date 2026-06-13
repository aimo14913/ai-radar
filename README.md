# AI Radar

全球 AI 資訊雷達，彙整官方、研究、媒體與台灣來源，並依細分賽道分類。

## 網站

GitHub Pages: https://aimo14913.github.io/ai-radar/

## 手動更新

需要 Node.js 18 或更新版本：

```bash
node fetch-ai-radar.mjs --limit 180 --days 21
```

抓取器會更新 `ai-radar-data.json`，並將最新資料嵌入 `index.html`。

## 資料來源

來源設定位於 `sources.json`。新增來源前請確認網站允許公開抓取，並遵守其使用條款與 robots 規範。
