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
- 資料存放：即時資料是單一 JSON 檔 `state.json`；已完成案件超出「最近 150 筆且 7 天內」的部分，自動搬到同目錄的 SQLite `archive.db`（表 `archived_requests`：id、room_id、room_name、category、category_label、category_icon、note、status、created_at、updated_at、archived_at，另有 created_at 與 category 索引）。搬移在每次新增或更新請求時觸發，不需排程。SQLite 初始化失敗時伺服器照常運作，只是不封存。

## 啟動
```
npm install
PORT=3000 npm start      # Windows PowerShell：$env:PORT=3000; npm start
```
資料預設寫在專案內 `data/`。

## 部署（Railway）
- 必須新增 Volume 並掛載到 `/data`（專案設定 → Volumes），否則每次重新部署，場地清單與求助紀錄都會清空。程式會自動讀 Railway 提供的 `RAILWAY_VOLUME_MOUNT_PATH`；沒有就退回容器內 `data/`（不會保留）。
- **自動部署：已確認有**（2026-11-26 用 Railway 查證，更正先前「尚未設定」的說法）：Railway 專案 `venue-help-desk`、服務 `web` 連到 `TaipeiNewHorizon-tw/venue-help-desk`，最近一次部署的 commit 就是 `main` 的 `7764f3e`。**所以合併到 `main` 會直接部署到正式環境**。網址 `web-production-21718.up.railway.app`；Volume `state-data` 掛在 `/data`（5000 MB）。
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
- 已知限制：長時間不關的 Socket 連線在 Cookie 到期後不會自動斷線，但下一次操作 API 會回 401 並回到登入頁；`POST /api/requests`（客戶求助）沒有頻率限制；登入失敗計數只在單一執行個體內。
- 本機測試過（API 行為、Cookie 竄改、鎖定、客戶頁即時同步）；**登入成功後儀表板畫面（含登出按鈕）還沒在瀏覽器走過**。
- 部署前必須：在 Railway 設定 `STAFF_PASSWORD`。

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
