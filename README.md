# tumt-wall-data

電競直播實作課「頻道牆」的資料抓取管線。`fetch.mjs` 讀學生登記的頻道清單,
抓 YouTube RSS 取最新影片、抓 `/streams` 分頁判斷是否公開開播中,輸出 `channels.json`
給前端靜態讀取。**零 npm 依賴、零金鑰**。GitHub Actions 每 5 分鐘跑一輪。

> 🤖 給 AI 代理/新協作者:先讀 [`CLAUDE.md`](CLAUDE.md)。

## 老師設定(開學做一次)

1. Google 表單收兩欄,題目名稱**必須**是「組名」與「頻道連結」(程式用題目名對欄位,缺了會直接報錯)。
2. 連到的 Google 試算表 → 檔案 → 分享 → **發布到網路** → 選 CSV → 複製連結。
3. 本 repo → Settings → Secrets and variables → Actions → **Variables** → 新增 `CSV_URL` = 該連結。
4. Actions 分頁手動跑一次「Update channel wall data」,看 log 有沒有 `OK(channelId=…)`。

沒設 `CSV_URL` 時,Action 會印警告並只抓 `channels.csv` 裡的三個測試頻道(不是學生清單)。

學生填的頻道連結四種格式都收:`youtube.com/channel/UC…`、`youtube.com/@handle`、`/c/名稱`、`/user/名稱`。
同一組多次提交以**最後一筆**為準。

## 開發

```bash
npm test          # 離線自檢(不打網路,< 1 秒);改 fetch.mjs 一定要跑
npm run fetch     # 用 channels.csv fixture 實跑一輪,產生 channels.json
CSV_URL=https://… npm run fetch   # 用真實清單跑
```

可調環境變數:`FETCH_TIMEOUT_MS`(單一請求逾時,預設 15000)、`CONCURRENCY`(同時處理幾個頻道,預設 4)。

## 輸出格式(`channels.json`,前端契約)

```jsonc
{
  "schemaVersion": 2,
  "updatedAt": "2026-09-06T15:56:18.981Z",     // 本輪完成時間
  "stats": { "total": 12, "ok": 11, "stale": 1, "skipped": 0 },
  "skipped": [ { "group": "X隊", "error": "無法解析頻道連結: …" } ],   // 抓不到又沒舊資料的組
  "channels": [
    {
      "group": "夜市巡航隊",                 // 學生填的組名(顯示用)
      "channelId": "UC…",
      "channelName": "頻道名稱",              // 來自 RSS
      "channelUrl": "https://www.youtube.com/channel/UC…",
      "live": null,                          // 未開播 = null;開播中 = { videoId, title, url, startedAt: null }
      "latest": [                            // 最新影片,最多 6 部,新→舊
        { "videoId", "title", "publishedAt", "thumbnail", "url" }
      ],
      "fetchedAt": "2026-09-06T15:56:10.000Z", // 這筆資料最後一次「真的抓到」的時間
      "stale": false,                        // true = 本輪抓失敗、沿用上一輪;建議前端標示「資料可能過時」
      "error": "RSS HTTP 503"                // 只有 stale:true 才有
    }
  ]
}
```

- `channels` 順序 = 表單提交順序(去重後)。
- 只會**加**欄位,不會改義或刪欄位;`schemaVersion` 改義時才 +1。
- `live.startedAt` 永遠是 `null`(`/streams` 分頁沒有開播時間;欄位依規格保留)。

## 故障排查

| 症狀 | 看哪裡 | 常見原因 |
|---|---|---|
| Action 紅、log 出現 `CSV 缺少必要欄位` | 表單題目名稱 | 題目被改名、或 `CSV_URL` 貼成試算表網址而非「發布到網路」CSV 連結 |
| Action 紅、log 出現 `全部失敗且無舊資料` | 各組錯誤列在 log | YouTube 整批擋 runner IP、或清單全是壞連結;此時**不會**覆寫 `channels.json` |
| 某組一直 `stale:true` | `error` 欄位 | 頻道被刪/改私人、連結填錯;請該組重填表單 |
| 開播了但 `live` 是 null | 5 分鐘內再看 | 剛開播、或直播設為「不公開」;RSS/`/streams` 只看公開直播 |
| 開播燈永遠不亮 | `fetch.mjs` 的 live 偵測註解 | YouTube 改版把 LIVE 徽章 JSON 換了;用 `node fetch.mjs` 在本機重現後修 `parseStreamsPage` |

## 為什麼 force-push 成單一 commit

這是資料 repo,只有最新一輪 `channels.json` 有意義,歷史沒有保留價值;每 5 分鐘一次 commit 若正常疊加,
`.git` 會無限膨脹。`.github/workflows/update.yml` 因此用 `git commit --amend` + `git push --force`
永遠只保留一個 commit,**這是刻意設計,不是誤用**。程式碼改動請開分支 / PR(`ci.yml` 會跑測試),
合進 main 後下一輪更新會把它一起帶進那個單一 commit。

## 關聯 repo

| Repo | 角色 |
|---|---|
| tumt-wall-data(本 repo) | 頻道牆資料管線 |
| tumt-site(網站首頁) | 讀本 repo 的 `channels.json` 渲染頻道牆 |
| tumt-platform | 教學遊戲後端(與本 repo 無程式相依) |
| tumt-course-115-1 | 課程設計文件 |
