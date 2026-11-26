# 場地即時協助系統（venue-help-desk）

來源 repo：`TaipeiNewHorizon-tw/venue-help-desk`（公開）。本資料夾是 2026-09-01 commit `7764f3e` 的完整原始碼。`_prototype-artifact/` 是更早的 artifact 原型，只供對照，可刪。

## 這是什麼
客戶掃場地內的 QR code 送出求助，工作人員在儀表板即時看到並處理進度（待處理 → 處理中 → 已完成）。客戶不必裝 App。

## 架構
- Node.js ≥18、Express 4、Socket.IO 4、better-sqlite3 11。`npm start` 即 `node server.js`。
- 檔案：`server.js`（343 行，所有後端）、`public/index.html`、`public/app.js`（604 行）、`public/styles.css`。
- 畫面：`/` 是工作人員儀表板；`/?room=<場地代碼>` 是客戶求助頁。各場地連結與 QR code 在儀表板的「場地服務QR-CODE設定」產生（按鈕原名「場地設定」，2026-11-26 改名）。
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

## 資料保存、事件紀錄與備份（2026-11-26 第一階段，已部署）
- **處理人員（君子協定）**：員工儀表板右上角有「值班人員」欄位，存在該瀏覽器（localStorage `vhd_staff_name`）；沒填就不能接單／完成（會跳提示）。名字隨 `PATCH /api/requests/:id` 的 `actor` 送出，記在 `accepted_by`、`resolved_by` 與事件裡。**這不是身分驗證**（整站仍是一個共用密碼），只用於報表歸屬；案件卡片會顯示「接單：○○」「完成：○○」。
- **記錄方式**：`accepted_at`＝第一次接單（重新開啟後再接單不會改）；`resolved_at`＝最近一次完成；`reopen_count`＝重新開啟次數。從「待處理」直接標記完成會同時記一筆接單與完成。**舊資料（匯入的）沒有接單時間與處理人員**，報表要排除這兩個欄位。
- **每日快照**：啟動時與每 30 分鐘檢查，每個臺北日期最多一份，存到 `/data/backups/helpdesk-YYYYMMDD.db`（用 `VACUUM INTO` 做一致性備份）與 `state-YYYYMMDD.json`，保留最新 14 份（環境變數 `BACKUP_KEEP`）。**仍在同一個 Volume**，防得了誤操作與檔案損毀，防不了整個 Volume 遺失；離開 Volume 的備份屬第三階段。還原：停服務，用快照檔取代 `/data/helpdesk.db`（同時刪除 `helpdesk.db-wal`、`helpdesk.db-shm`），再啟動；**尚未實際演練過**。
- **啟動失敗就不啟動**：資料庫打不開會直接結束（exit 1），不會在無法保存的情況下繼續收案。`/healthz` 在資料庫可讀時回 200，部署時建議在 Railway 設 Healthcheck Path = `/healthz`，這樣新版起不來時 Railway 會保留舊版。
- `/api/metrics` 改從資料庫計算（輸出欄位不變）；`resolved_today` 改依 `resolved_at`（臺北日期）。
- **測試**：`npm test`（Node 內建測試，14 項：事件與欄位、舊資料匯入與重複匯入、臺北時間邊界、快照與保留數、完整 HTTP 流程含重啟後資料仍在、頻率限制、資料庫打不開時拒絕啟動）。需要 Node ≥ 22.13。
- **已部署（2026-11-26）**：main 的 dadb04，Railway 建置用 Node 22.23.5；Healthcheck Path 已設 /healthz；首次啟動日誌：[store] ready: /data/helpdesk.db (14 requests, 28 events, 14 imported from legacy storage)、[backup] created /data/backups/helpdesk-20261126.db。日誌裡的 ExperimentalWarning: SQLite is an experimental feature 是 
ode:sqlite 的正常警告。部署方式仍是手動（見上方「自動部署」）。下面是當時的部署注意事項，留作紀錄：
- **部署注意（第一次上線這版）**：（1）`package.json` 移除了 `better-sqlite3` 並要求 Node ≥ 22.13，要確認 Railway 建置用的 Node 版本；（2）首次啟動會把 `state.json` 與 `archive.db` 的舊案件匯入新資料庫（原檔不動）；（3）部署前先在 Railway 對 Volume 做一份手動備份（若方案支援）；（4）部署後檢查日誌有 `[store] ready` 與 `[backup] created`。
- 尚未做：報表頁與 CSV 匯出（第二階段）、Bucket 備份與還原演練（第三階段）、被擋下次數記錄（`rejections`，待決定）、客戶備註欄「請勿填寫個人資料」提示（待決定）。
## 每日 QR code（有日期、時段的通行碼）（2026-11-26，已部署）
**已部署**：main 的 43ab9b9（2026-11-26），資料庫升級後仍是 14 筆案件／28 個事件（重新部署資料沒有遺失）；強制開關**目前是關閉**，舊的場地 QR code 仍有效。**目的**：離場的人不能再用舊 QR code 送求助。流程：每天下班前列印「隔天有開放使用」的場地 QR code（上面印使用日期與時段），當天也能臨時產生。
- **通行碼（pass）**：資料表 `qr_passes`＝「一個場地＋一段有效起迄時間」，QR code 網址是 `/?p=<10 碼隨機>`（字元集排除易混淆的 0/O/1/I/L，約 8e14 種組合，猜不到）。網址**不含場地代碼**，場地由伺服器查表。有效期間：起點含、終點不含；員工頁產生時會把「結束分鐘」算進去（結束 18:00 ＝ 到 18:00:59 都有效，和服務時段的算法一致）。客戶仍同時受「服務時段」限制。
- **員工頁 `/qr.html`**（需先在儀表板登入；入口在「場地服務QR-CODE設定」）：選使用日期、開始／結束時間、連續天數（1–14，中間不中斷）、場地（記住上次勾選）；有「明天（下班前列印）」「今天，從現在起（臨時）」快捷鈕；產生後出列印預覽（A4，每頁 2 張，含場地名、日期、使用時段、「需要協助嗎？請掃描 QR code，通知現場工作人員」、編號後 4 碼）；下方列出已產生的通行碼，可「重印」「停用」。
- **客戶看到的**：時段內正常使用；未開始／已過期／已停用／無法辨識 → 顯示說明，**沒有表單、也看不到該場地的案件**（未開始會告訴開放時間；錯誤訊息不透露場地名稱）。客戶頁開著時如果到期或被停用，伺服器會在 60 秒內（停用則立刻）用 Socket.IO 通知該頁，並且每次送出都會重新驗證，所以半夜才按送出也會被擋。
- **開關 `qrRequirePass`**（存在 `state.json`，預設**關**）：關＝舊的場地連結 `/?room=` 與舊 QR code 仍可用（不影響現場已印好的）；開＝只接受通行碼，舊連結立刻失效（已開著的舊頁面也會被切斷）。在 `/qr.html` 最下方切換，開啟前會跳確認。**要等現場換成新印的 QR code 再開**。
- **API**：客戶 `GET /api/public?p=`、`POST /api/requests`（body 帶 `p`；有 `p` 時場地以通行碼為準，不看 body 的 `roomId`）；員工 `GET/POST /api/passes`、`DELETE /api/passes/:id`、`PATCH /api/qr-mode`。簽發限制：一次最多 60 張、有效期間最長 14 天、結束時間要晚於開始且尚未過去。
- **記錄**：`requests.pass_id` 記錄案件是透過哪一張通行碼進來（舊資料庫啟動時會自動補欄位；舊案件與用舊連結的為空）。
- **限制**：擋得了「離場後」，擋不了「當天在場的人把 QR code 拍照傳給別人」；要更嚴格只能縮短有效時段（例如依活動時段簽發）或用螢幕輪播短效 QR code（未做）。印出去的 QR code 網址含目前的主機名稱，換網域就要重印。產生頁用 `cdnjs` 的 qrcodejs，列印時需要連網。
- **測試**：`npm test` 共 17 項，含通行碼資料庫（編號格式與不重複、起迄時間邊界、停用、舊資料庫升級）與完整 HTTP 流程（簽發驗證、未開始／過期／無法辨識、通行碼優先於 `roomId`、強制模式開關、停用即失效）。瀏覽器實測過：員工產生與預覽、客戶透過通行碼送出、未開始說明、客戶頁開著時被停用即時切換、開關對舊連結的效果。**尚未實測**：實際用印表機列印、手機掃描、午夜過期的行為、Socket 到期通知（只驗過「停用」那條路）。
## 報表頁與 CSV 匯出（2026-11-26，已部署）
- **已部署**：main 的 d779f80（2026-11-26），部署後資料庫仍是原有案件、沒有遺失。**入口**：員工儀表板右上角「報表」→ `/reports.html`（需先在儀表板登入）。篩選：開始／結束日期（臺北日期、含頭尾，預設近 30 天，最長 366 天）、場地、類別；快捷鈕「今天／近 7 天／近 30 天／本月／上個月」。篩選條件寫進網址（`?from=&to=&room=&category=`），可加書籤或分享給同事（對方仍需登入）。場地與類別的選項來自**歷史資料**，已刪除的場地、類別也找得到。
- **指標**：總件數、已完成、未完成；**接單等待**（中位數、P90）與「5 分鐘內接單」比例；處理時間（接單到完成的中位數）；曾重新開啟件數。圖表：每日件數、一天中的時段（0–23 時，臺北）、星期、類別（含各類別接單等待）、場地表、人員表（接單數、完成數、處理中位數）。尖峰以橘色標示。純 HTML/CSS 繪圖，沒有引入圖表套件。
- **舊資料**：從舊儲存匯入的案件（以及沒有接單時間的已完成案件）**不列入接單等待與處理時間**，頁面會標註有幾件；它們仍列入件數、類別、時段等統計。人員欄位也是空的。
- **CSV**：`GET /api/reports/export.csv?type=requests|events&from=&to=&room=&category=`。`requests` 一案件一列（時間為臺北時間、含接單／完成人員、等待與處理秒數、通行碼編號）；`events` 是這些案件的每一次狀態變更。**UTF-8 含 BOM**（Excel 直接開得了中文）、CRLF。**CSV 公式注入防護**：客戶備註、人員名字若以 `= + - @` 開頭，會在前面加單引號，避免被 Excel 當公式執行（真正的數字不受影響）。事件匯出是依「案件建立日」落在範圍內來挑，所以一段期間的匯出自成一體。
- **API**：`GET /api/reports/summary`（回傳 `range`、`filters`、`summary`），皆需員工登入；日期格式錯誤、開始晚於結束、超過 366 天、`type` 不合法都回 400。
- **程式**：計算在 `reports.js`（純函式：`buildSummary`、`parseRange`、`requestsCsv`、`eventsCsv`），查詢在 `store.js`（`queryRequests`、`queryEvents`、`listFilters`）。畫面連續切換篩選時，只有最新一次請求會畫出來（避免慢的舊回應蓋掉新的）。
- **測試**：`npm test` 共 28 項，新增：報表計算（中位數與 P90、舊資料排除、臺北時間的時段／星期／日界線、分組與排序）、CSV（BOM、引號、公式注入、欄位數）、資料庫查詢（日期半開區間、場地／類別篩選、含已刪除場地的清單）、報表 API（需登入、篩選、錯誤輸入、CSV 標頭與內容）。瀏覽器用模擬的 164 筆、20 天資料實測過：指標、圖表、篩選、快捷鈕、匯出連結、CSV 實際內容。**尚未實測**：用 Excel 實際開啟 CSV、手機版的長時間使用、資料量很大時的速度（目前全部在記憶體計算，幾萬筆內沒問題）。
- **注意**：儀表板的「場地設定」按鈕已改名為「場地服務QR-CODE設定」（同一個畫面）。
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

## 場地名稱固定清單與平面圖資料（2026-11-26）
- 場地名稱不再自由輸入，改成下拉選單，只能選這 14 個：601會議室～608會議室、A廳～F廳（`server.js` 的 `VENUE_ROOMS`，`public/app.js` 有一份相同的，**兩邊要一起改**）。後端 `POST/PATCH /api/rooms` 會驗證：不在清單回 400、與別的場地重名回 409。
- 啟動時 `seedVenueRooms` 會補齊 14 個場地：名稱還是「場地 N」的預留場地依序改名（id 不變，已印的 QR code 照常可用），不夠再新增；已被人改過名字的場地不動（下拉會顯示「舊名稱，請改選」）。
- `/api/metrics` 新增 `active`：每一件未解決案件的 `{room, category, status, age_sec}`（場地名、問題類別、狀態、等待秒數），給營運總表的六樓平面圖閃爍用。**只有類別，沒有客戶填的備註**。

## `/api/metrics` 新增 `category_stats`（2026-11-26，已測試，尚未部署）
- `category_stats: {days: 30, total, items: [{category, count}]}`：近 30 天各問題類別（用案件當時的類別名稱）的件數，由多到少，最多 8 類。沒有備註、場地等內容。給營運總表「常見問題統計」用，計算在 `store.js` 的 `categoryStats()`。
