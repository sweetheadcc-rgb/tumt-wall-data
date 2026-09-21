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
Twitch 頻道連結也收:`twitch.tv/<帳號>`、`m.twitch.tv/<帳號>/home?...`、帶查詢字串的網址皆可(見下方「Twitch 設定」)。
同一組多次提交以**最後一筆**為準。

## Twitch 設定(開學做一次,選用)

不設定也不會壞——沒有 `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` 時,Twitch 頻道本輪會被略過
(log 會清楚寫「TWITCH_CLIENT_ID/SECRET 未設定,Twitch 頻道本輪略過」),YouTube 頻道完全不受影響。
**零 npm 依賴**:Twitch 走官方 Helix API,一樣只用 Node 內建 `fetch`。

1. 到 [dev.twitch.tv/console](https://dev.twitch.tv/console) 登入(需要開通 Twitch 帳號的兩步驟驗證)。
2. **Register Your Application**:
   - Name:隨意,例如 `tumt-wall`
   - OAuth Redirect URLs:填 `http://localhost`(用不到,但欄位必填)
   - Category:選 `Website Integration`
   - Client Type:選 **Confidential**
   - 按 **Create**
3. 進剛建立的 App → **Manage**,複製 **Client ID**;按 **New Secret** 產生並複製 **Client Secret**
   (這個 Secret 只會顯示一次,沒複製到就要重新產生一次)。
4. 本 repo → **Settings → Secrets and variables → Actions → Secrets**(注意是 Secrets 分頁,不是
   `CSV_URL` 所在的 Variables 分頁)→ **New repository secret**,建立兩個:
   - `TWITCH_CLIENT_ID` = 剛複製的 Client ID
   - `TWITCH_CLIENT_SECRET` = 剛複製的 Client Secret
5. **Actions** 分頁 → 選 `Update channel wall data` → **Run workflow** 手動跑一次,看 log 裡 Twitch
   那幾組是不是變成 `OK(twitch login=…)`。

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
      "platform": "youtube",                 // "youtube" | "twitch"
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
    },
    {
      "group": "電競社直播部",
      "platform": "twitch",
      "channelId": "123456789",              // Twitch user id
      "channelName": "顯示名稱",              // Twitch display_name
      "channelUrl": "https://www.twitch.tv/帳號",
      "avatar": "https://static-cdn.jtvnw.net/…",
      "live": null,                          // 未開播 = null;開播中 = { title, url, thumbnail, viewers, startedAt }
      "latest": [                            // 最近幾支 VOD(type=all),很多頻道關 VOD、空陣列是正常情況
        { "videoId", "title", "url": "https://www.twitch.tv/videos/…", "published": "…" }
      ],
      "fetchedAt": "2026-09-06T15:56:10.000Z",
      "stale": false
    }
  ]
}
```

- `channels` 順序 = 表單提交順序(去重後),YouTube 與 Twitch 混在同一個陣列裡,用 `platform` 分辨。
- 只會**加**欄位,不會改義或刪欄位;`schemaVersion` 改義時才 +1。
- `live.startedAt`:YouTube 永遠是 `null`(`/streams` 分頁沒有開播時間;欄位依規格保留);Twitch 是 Helix
  `streams` 回傳的實際開播時間字串。
- Twitch 的 `latest[].published` 欄位名跟 YouTube 的 `latest[].publishedAt` **不同**(沿用 Twitch Helix API
  原始欄位命名,故意不統一),前端讀取時要兩個都兼顧。

## 故障排查

| 症狀 | 看哪裡 | 常見原因 |
|---|---|---|
| Action 紅、log 出現 `CSV 缺少必要欄位` | 表單題目名稱 | 題目被改名、或 `CSV_URL` 貼成試算表網址而非「發布到網路」CSV 連結 |
| Action 紅、log 出現 `全部失敗且無舊資料` | 各組錯誤列在 log | YouTube 整批擋 runner IP、或清單全是壞連結;此時**不會**覆寫 `channels.json` |
| 某組一直 `stale:true` | `error` 欄位 | 頻道被刪/改私人、連結填錯;請該組重填表單 |
| 開播了但 `live` 是 null | 5 分鐘內再看 | 剛開播、或直播設為「不公開」;RSS/`/streams` 只看公開直播 |
| 開播燈永遠不亮 | `fetch.mjs` 的 live 偵測註解 | YouTube 改版把 LIVE 徽章 JSON 換了;用 `node fetch.mjs` 在本機重現後修 `parseStreamsPage` |
| Twitch 組一直 `stale:true`、error 提到 `TWITCH_CLIENT_ID/SECRET 未設定` | repo Secrets 設定 | 沒設定或設錯分頁(要設在 Secrets,不是 Variables);見「Twitch 設定」 |
| Twitch 某組 error 是「Twitch 帳號不存在或已改名」 | 該組填的連結 | Twitch 帳號改名或打錯;請該組重填表單 |

## 為什麼資料 commit 會被 amend + force-push

這是資料 repo,只有最新一輪 `channels.json` 有意義,歷史沒有保留價值;每 5 分鐘一次 commit 若正常疊加,
`.git` 會無限膨脹。`.github/workflows/update.yml` 因此把資料更新**疊在同一個 bot commit 上**
(`git commit --amend` + `git push --force-with-lease`),**這是刻意設計,不是誤用**。

規則:HEAD 是 bot commit → amend;HEAD 是人的 commit(程式碼剛合進 main)→ 保留它、在上面另開一個 bot commit。
所以歷史長這樣:`[程式碼 commit…] → [一個一直被 amend 的 bot commit]`,程式碼改動走一般分支 / PR 即可(`ci.yml` 會跑測試)。

> ⚠️ 2026-09-06 之前的版本連 root commit 都在 amend,任何分支都會和 main「沒有共同歷史」而開不了 PR。
> 第一次合入這個修正時,請在本機 `git merge --allow-unrelated-histories` 或直接把分支 force-push 到 main;之後就正常了。

## 關聯 repo

| Repo | 角色 |
|---|---|
| tumt-wall-data(本 repo) | 頻道牆資料管線 |
| tumt-site(網站首頁) | 讀本 repo 的 `channels.json` 渲染頻道牆 |
| tumt-platform | 教學遊戲後端(與本 repo 無程式相依) |
| tumt-course-115-1 | 課程設計文件 |
