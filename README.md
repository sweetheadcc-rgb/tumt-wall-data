# tumt-wall-data

電競直播實作課「頻道牆」的資料抓取管線。`fetch.mjs` 讀學生登記的頻道清單，
抓 YouTube RSS 取最新影片、抓 `/streams` 分頁判斷是否公開開播中，輸出 `channels.json`
給前端靜態讀取。零 npm 依賴、零金鑰。

**設定 `CSV_URL`**：Google 表單收「組名＋頻道連結」兩欄 → 連到的 Google 試算表
「檔案 > 分享 > 發布到網路」選 CSV → 把該連結設成本 repo 的 Actions variable
`CSV_URL`。未設定時 `fetch.mjs` 會退回讀本地 `channels.csv` fixture（開發用）。

**為什麼 force-push 成單一 commit**：這是資料 repo，只有最新一輪 `channels.json`
有意義，歷史沒有保留價值；每 5 分鐘一次 commit 若正常疊加，`.git` 會無限膨脹。
`.github/workflows/update.yml` 因此用 `git commit --amend` + `git push --force`
永遠只保留一個 commit，這是刻意設計，不是誤用。

開發：`node test.mjs` 跑離線自檢，`node fetch.mjs` 用 fixture 實跑一輪。
