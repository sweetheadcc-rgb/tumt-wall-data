# CLAUDE.md — tumt-wall-data 給 AI 代理的工作守則

這是一條**零相依、零金鑰**的資料管線:`fetch.mjs` 把 Google 表單 CSV 的頻道清單變成 `channels.json`,
GitHub Actions 每 5 分鐘跑一次。前端(別的 repo)靜態讀 `channels.json`。

## 先跑什麼

```bash
npm test        # 離線自檢,不打網路;改 fetch.mjs 必跑
npm run fetch   # 用 channels.csv fixture 實跑一輪(需要能連 youtube.com)
```

## 不要做的事

- **不要加 npm 依賴**(沒有 `npm install` 步驟、沒有 lockfile,這是刻意的)。解析用 regex/內建 API 就好。
- **不要「修正」update.yml 的 `--amend` + `--force`**:資料 repo 永遠只留一個 commit 是設計(見 README)。
- **不要改 `channels.json` 的既有欄位語意或刪欄位**;只能加欄位。前端靠它。改義才 bump `SCHEMA_VERSION`。
- **不要把 live 偵測改回打 `/live` 頁**:GitHub runner 的 IP 會被 YouTube 的 LOGIN_REQUIRED 擋板抽空欄位,
  本機正常、線上永遠不亮(`fetch.mjs` 註解有完整實測紀錄)。
- **不要手改 `channels.json` / `resolve-cache.json`**:下一輪 Action 會覆寫。

## 改東西的慣例

- 網路相依集中在 `httpGet` / `resolveChannelId` / `fetchRss` / `fetchLive`;彙整邏輯在 `collectChannels`,
  三個抓取函式都可注入,新邏輯請用注入方式在 `test.mjs` 離線測(不要在測試裡打真網路)。
- 每個頻道的失敗語意:有舊資料 → 沿用並標 `stale:true`;沒有 → 進 `skipped[]`;live 失敗不算頻道失敗。
- 清單非空卻一組都沒抓到 → `main()` 以非零結束且**不覆寫**輸出(讓 Action 紅,不讓頻道牆變空)。
- 解析 YouTube HTML 的 regex 一旦失效,先用 `node fetch.mjs` 在本機重現,再改 `parseStreamsPage` / `resolveChannelId`,
  並在 `test.mjs` 補一段當時抓到的最小 HTML 片段當回歸案例。
- log 一律走 `console.error`(stderr),stdout 留給將來可能的 JSON 輸出。

## 語言

文件、註解、commit 一律繁體中文;不要在 commit / 程式碼裡寫模型名稱或代理身分。
