# 場地即時協助系統（venue-help-desk）

來源 repo：`TaipeiNewHorizon-tw/venue-help-desk`（公開）。本資料夾是 2026-09-01 commit `7764f3e` 的完整原始碼。`_prototype-artifact/` 是更早的 artifact 原型，只供對照，可刪。

## 這是什麼
客戶掃場地內的 QR code 送出求助，工作人員在儀表板即時看到並處理進度（待處理 → 處理中 → 已完成）。客戶不必裝 App。

## 架構
- Node.js ≥18、Express 4、Socket.IO 4、better-sqlite3 11。`npm start` 即 `node server.js`。
- 檔案：`server.js`（343 行，所有後端）、`public/index.html`、`public/app.js`（604 行）、`public/styles.css`。
- 畫面：`/` 是工作人員儀表板；`/?room=<場地代碼>` 是客戶求助頁。各場地連結與 QR code 在儀表板的「場地設定」產生。
- API：`GET /api/state`、`POST /api/requests`、`POST/DELETE /api/rooms`、`POST/DELETE /api/categories`。任何狀態變動都用 Socket.IO 事件 `state` 廣播給所有連線。
- 預設資料：12 個場地（場地 1–12，可改名）；求助類別為音響、網路、清潔、餐飲、其他（其他必填備註）。
- 資料存放（2026-11-26 起，第一階段）：**所有求助與每次狀態變更都永久存在 SQLite `helpdesk.db`**（Volume 上），表 `requests`（每筆案件，場地／類別名稱為當時的快照）與 `request_events`（只增不改的事件紀錄：created／accepted／resolved／reopened／reverted，含處理人員）；邏輯在 `store.js`，使用 Node 內建 `node:sqlite`（不再需要 `better-sqlite3`，所以 `engines` 要求 Node ≥ 22.13）。`state.json` 現在只當設定檔（場地、類別、服務時段、場地總稱），並仍同步寫入「目前儀表板顯示的案件」作為還原備援；儀表板顯示的案件由資料庫重建（未完成的全部＋最近 7 天內完成、最多 150 筆）。舊的 `archive.db` 不再寫入，啟動時只讀一次匯入（可重複執行、不覆蓋）。詳見 `docs/data-and-analytics-design.md`。

## 啟動
```
npm install
PORT=3000 npm start      # Windows PowerShell：$env:PORT=3000; npm start
```
資料預設寫在專案內 `data/`。

## 部署（Railway）
- 必須新增 Volume 並掛載到 `/data`（專案設定 → Volumes），否則每次重新部署，場地清單與求助紀錄都會清空。程式會自動讀 Railway 提供的 `RAILWAY_VOLUME_MOUNT_PATH`；沒有就退回容器內 `data/`（不會保留）。
- **自動部署：實測沒有作用**（2026-11-26，更正先前兩次不實的說法）。Railway 專案 `venue-help-desk`、服務 `web` 列有 repo `TaipeiNewHorizon-tw/venue-help-desk`，但合併到 `main` 之後 Railway **沒有產生新部署**（連續兩次：`8928425`、`c92853c`），所以文件原本寫的「自動部署尚未設定」是對的。目前的部署方式是：合併後，用 Railway 的「重新綁定來源到 `main`」（MCP 的 `connect-service-source`，repo 與 branch=main 同上次）或在 Railway 後台按 Deploy，會立即建置並部署 `main` 最新 commit。要真的自動部署，需要到 Railway 服務的 Settings → Source 確認有選分支、並在 GitHub 的 Railway App 授權設定裡確認此 repo 在可存取清單內（推測原因，尚未驗證）。網址 `web-production-21718.up.railway.app`；Volume `state-data` 掛在 `/data`（5000 MB）。
- 2026-11-26 已在該服務設定環境變數 `STAFF_PASSWORD`、`METRICS_TOKEN`（以不重新部署的方式設定，會在下一次部署生效；值只在 Railway，不在 repo）。合併分支前這兩個必須已存在，否則儀表板會鎖死。
- 環境變數名稱：`PORT`、`DATA_DIR`（選用，預設 `./data`）、`RAILWAY_VOLUME_MOUNT_PATH`（Railway 自動提供）、`STAFF_PASSWORD`（新增，儀表板密碼，必填）。
- 上線網址：待補（請從 Railway 專案取得）。

## 登入驗證（2026-11-25 新增，尚未部署）
- 單一共用密碼，環境變數 **`STAFF_PASSWORD`**（Railway Variables 設定；**沒設定時儀表板會鎖死**，回 503，不會開放）。
- 登入：`POST /api/login`，成功核發 HttpOnly Cookie `vhd_staff`（HMAC 簽章，7 天，SameSite=Strict；https 時加 Secure）。`POST /api/logout` 登出。改密碼後所有舊登入失效。
- 失敗 10 次／15 分鐘／每 IP 會鎖定（記憶體內計數，重啟即清空）。已加 `trust proxy`，讓 Railway 後面取得真實 IP。
- 需登入：`GET /api/state`、所有 `PATCH/DELETE/POST` 的 `/api/requests/:id`、`/api/rooms*`、`/api/categories*`、`/api/venue`、`/api/service-hours`。
- 維持公開：靜態頁面、`GET /api/public?room=<id>`、`POST /api/requests`。客戶只拿得到自己那個場地的資料（`publicState`），拿不到其他場地的求助紀錄與備註。
- Socket.IO：移除 CORS `*`（僅同源）；客戶用 `?room=` 加入該場地頻道，工作人員需有效 Cookie 才加入 `staff` 頻道，否則收到 `auth-required`。
- 已知限制：長時間不關的 Socket 連線在 Cookie 到期後不會自動斷線，但下一次操作 API 會回 401 並回到登入頁；客戶求助的頻率限制見下一節（只擋量，擋不住有人換 IP 慢慢送）；登入失敗計數只在單一執行個體內。
- 本機測試過（API 行為、Cookie 竄改、鎖定、客戶頁即時同步）；**登入成功後儀表板畫面（含登出按鈕）還沒在瀏覽器走過**。
- 部署前必須：在 Railway 設定 `STAFF_PASSWORD`。

## 資料保存、事件紀錄與備份（2026-11-26 第一階段，已完成但尚未部署）
- **處理人員（君子協定）**：員工儀表板右上角有「值班人員」欄位，存在該瀏覽器（localStorage `vhd_staff_name`）；沒填就不能接單／完成（會跳提示）。名字隨 `PATCH /api/requests/:id` 的 `actor` 送出，記在 `accepted_by`、`resolved_by` 與事件裡。**這不是身分驗證**（整站仍是一個共用密碼），只用於報表歸屬；案件卡片會顯示「接單：○○」「完成：○○」。
- **記錄方式**：`accepted_at`＝第一次接單（重新開啟後再接單不會改）；`resolved_at`＝最近一次完成；`reopen_count`＝重新開啟次數。從「待處理」直接標記完成會同時記一筆接單與完成。**舊資料（匯入的）沒有接單時間與處理人員**，報表要排除這兩個欄位。
- **每日快照**：啟動時與每 30 分鐘檢查，每個臺北日期最多一份，存到 `/data/backups/helpdesk-YYYYMMDD.db`（用 `VACUUM INTO` 做一致性備份）與 `state-YYYYMMDD.json`，保留最新 14 份（環境變數 `BACKUP_KEEP`）。**仍在同一個 Volume**，防得了誤操作與檔案損毀，防不了整個 Volume 遺失；離開 Volume 的備份屬第三階段。還原：停服務，用快照檔取代 `/data/helpdesk.db`（同時刪除 `helpdesk.db-wal`、`helpdesk.db-shm`），再啟動；**尚未實際演練過**。
- **啟動失敗就不啟動**：資料庫打不開會直接結束（exit 1），不會在無法保存的情況下繼續收案。`/healthz` 在資料庫可讀時回 200，部署時建議在 Railway 設 Healthcheck Path = `/healthz`，這樣新版起不來時 Railway 會保留舊版。
- `/api/metrics` 改從資料庫計算（輸出欄位不變）；`resolved_today` 改依 `resolved_at`（臺北日期）。
- **測試**：`npm test`（Node 內建測試，14 項：事件與欄位、舊資料匯入與重複匯入、臺北時間邊界、快照與保留數、完整 HTTP 流程含重啟後資料仍在、頻率限制、資料庫打不開時拒絕啟動）。需要 Node ≥ 22.13。
- **部署注意（第一次上線這版）**：（1）`package.json` 移除了 `better-sqlite3` 並要求 Node ≥ 22.13，要確認 Railway 建置用的 Node 版本；（2）首次啟動會把 `state.json` 與 `archive.db` 的舊案件匯入新資料庫（原檔不動）；（3）部署前先在 Railway 對 Volume 做一份手動備份（若方案支援）；（4）部署後檢查日誌有 `[store] ready` 與 `[backup] created`。
- 尚未做：報表頁與 CSV 匯出（第二階段）、Bucket 備份與還原演練（第三階段）、被擋下次數記錄（`rejections`，待決定）、客戶備註欄「請勿填寫個人資料」提示（待決定）。
## 客戶求助的頻率限制（2026-11-26 新增）
`POST /api/requests` 是公開的，所以加了防洗版：
- **每個場地**每 10 分鐘最多 5 筆；**每個 IP**每 10 分鐘最多 30 筆。超過回 429，訊息「送出太頻繁了，請稍候幾分鐘再試；如有緊急狀況請直接聯絡工作人員」，客戶頁以提示框顯示。
- 為什麼以場地為主：會場客人通常共用同一個 Wi-Fi（同一個對外 IP），只限 IP 會讓一個人亂送連累全場；IP 上限放寬到 30，主要擋跨場地洗版。
- 可用環境變數調整：`RATE_LIMIT_WINDOW_MIN`（預設 10）、`RATE_LIMIT_ROOM_MAX`（預設 5）、`RATE_LIMIT_IP_MAX`（預設 30）。
- 限制：計數存在記憶體，服務重啟就歸零，也只適用單一執行個體；依賴 `trust proxy`（Railway 後面取得真實 IP）。只有「通過驗證、真的建立了案件」的請求才計數，無效請求（不存在的場地、類別錯誤）不計。
- 本機測過：單一場地第 6 次起被擋、其他場地不受影響、單一 IP 剛好 30 次後被擋、無效請求仍回 400。**尚未在正式環境驗證。**

## 給彙總儀表板用的 `/api/metrics`（2026-11-25 新增，尚未部署）
- `GET /api/metrics`，需 `Authorization: Bearer <METRICS_TOKEN>`；**沒設環境變數 `METRICS_TOKEN` 時一律拒絕（503）**，金鑰錯誤回 401。與 `STAFF_PASSWORD` 無關，是另一把給機器讀的金鑰。
- 回傳 `calls_today`、`pending`、`in_progress`、`resolved_today`、`unresolved`、`unresolved_ages_sec`（每件未解決案件已等待的秒數，由大到小）、`service_open`。「今日」以臺北時間計。只有數字，沒有備註、場地名稱等內容。
- 部署時要在 Railway Variables 設 `METRICS_TOKEN`，並把同一個值設在 `tnh-hub` 的 `HELPDESK_METRICS_TOKEN`。見 `tnh-hub/CLAUDE.md`。
- 限制：今日數字取自即時資料 `state.json`；一天超過 150 筆已完成案件時，較舊的已被搬進 `archive.db` 而少算。

## 安全提醒
- repo 是公開的，原始碼人人可看；沒有密鑰所以不是洩漏問題。

## 待辦清單
1. 設定 Railway ↔ GitHub 自動部署，並確認 Volume 已掛載（優先）。
2. ~~儀表板加登入驗證~~（程式碼完成，見上；待設定 `STAFF_PASSWORD`、瀏覽器走一次登入流程後部署）。
3. archive.db 加查詢與 CSV 匯出頁（依日期、類別篩選）。
4. 加處理人員欄位與回應時長（SLA）統計。
5. 串接 LINE 通知，新求助不必開著網頁才會提醒。
6. 場地清單改成與費用試算共用一份主資料。
7. repo 與 Railway 收回公司組織帳號。
8. 目前 commit 都是網頁上傳（"Add files via upload"），沒有 .gitignore；加上 `.gitignore`（`data/`、`node_modules/`）。
