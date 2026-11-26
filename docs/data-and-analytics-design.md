# 場地協助中心：資料保存、備份與分析方案（設計稿）

狀態：**第一階段已實作（本機測試通過，尚未部署）**，第二、三階段尚未做（2026-11-26）。處理人員採「君子協定」（使用者已決定）。目標：客戶送出的每一筆求助與每一次處理動作都**永久保留**，有**備份**，並能事後依類別、時間、場地、處理人員等維度分析與匯出。

## 1. 現況與缺口（已用 Railway 日誌與程式碼確認）
- 即時案件存在 Volume 上的 `state.json`；已完成且超過 7 天（或超出最近 150 筆）的才搬進 `archive.db`（SQLite）。兩個檔案都在同一個 Volume（`/data`）。
- 缺口：（1）沒有任何備份；（2）沒有查詢／匯出介面，資料還分散在兩處；（3）只記「建立時間」「最後更新時間」，**沒記接單時間與處理人員**，所以算不出回應時間，也無法按人員分析。

## 2. 設計原則
1. **單一來源**：所有案件與事件只存一個 SQLite（`/data/helpdesk.db`），不再「JSON＋封存」兩處。
2. **只增不改的事件紀錄**（`request_events`）是分析的依據；`requests` 是為了查詢方便的彙總列，兩者在同一個交易裡寫入。
3. **快照名稱**：案件裡同時存場地／類別的 id 與當時的名稱，之後改名或刪除場地、類別也不影響歷史分析。
4. 時間一律存 UTC 毫秒，報表以臺北時間（UTC+8）切日與時段。
5. 對現有畫面的影響最小：`/api/state`、Socket.IO 事件與員工儀表板的資料形狀不變，改的是底層儲存。

## 3. 資料表（草案）
```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,      room_name TEXT NOT NULL,       -- 當時的名稱快照
  category_id TEXT NOT NULL,  category_label TEXT NOT NULL,  category_icon TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                  -- pending | in_progress | done
  created_at INTEGER NOT NULL,           -- 客戶送出
  accepted_at INTEGER, accepted_by TEXT, -- 第一次接單
  resolved_at INTEGER, resolved_by TEXT, -- 最近一次標記完成
  reopen_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_requests_created ON requests(created_at);
CREATE INDEX idx_requests_category ON requests(category_id, created_at);
CREATE INDEX idx_requests_room ON requests(room_id, created_at);

CREATE TABLE request_events (            -- append-only，永不修改、不刪除
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  at INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- created | accepted | resolved | reopened
  actor TEXT,                            -- 處理人員（客戶送出時為空）
  from_status TEXT, to_status TEXT
);
CREATE INDEX idx_events_request ON request_events(request_id, at);
CREATE INDEX idx_events_at ON request_events(at);

CREATE TABLE rejections (                -- 選用：只記次數，不記內容與 IP
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, room_id TEXT,
  reason TEXT NOT NULL                   -- out_of_hours | rate_limited
);
```

## 4. 能回答哪些問題
| 面向 | 指標 |
|---|---|
| 量 | 依日／週／月、時段（0–23 時）、星期、類別、場地的案件數；尖峰時段；各場地各類別交叉表 |
| 回應 | **接單等待時間** = `accepted_at − created_at`（中位數、P90、**5 分鐘內接單比例**，與儀表板紅燈門檻一致） |
| 處理 | 處理時間 = `resolved_at − accepted_at`；總時間 = `resolved_at − created_at` |
| 品質 | 重新開啟比例（`reopen_count`）、目前未解決案件的等待時間 |
| 人員 | 各人員接單數、完成數、平均處理時間（依 `accepted_by`／`resolved_by`） |
| 需求 | （選用）服務時段外與被頻率限制擋下的次數，看有沒有人在時段外有需求 |

## 5. 處理人員怎麼記
目前整站只有一個共用密碼，**沒有個人身分**。建議：登入後讓員工在畫面上選／輸入「我是誰」（存在該瀏覽器），接單與完成時一併送出。這是君子協定，**不是安全驗證**，只用於分析與責任歸屬的參考。若日後需要可稽核的個人帳號，是另一個較大的改動。

## 6. 報表與匯出（員工登入後使用）
- 新頁面 `/reports`：日期範圍、場地、類別篩選；卡片（總件數、接單中位數、5 分鐘內接單比例）、各類別長條圖、時段熱度圖、各場地表格。純前端繪圖，不引入外部圖表套件。
- 匯出：`案件` 與 `事件` 兩份 CSV（UTF-8 含 BOM，Excel 直接開得了中文）。
- API：`GET /api/reports/summary?from=&to=&room=&category=`、`GET /api/reports/export.csv?type=requests|events&from=&to=`，皆需員工登入。

## 7. 備份（三層）
1. **每日快照（同 Volume）**：每天 03:00（臺北）用 SQLite 一致性備份（`VACUUM INTO`）寫到 `/data/backups/helpdesk-YYYYMMDD.db`，保留 14 份。防誤操作與檔案損毀，**防不了整個 Volume 遺失**。
2. **離開 Volume 的備份**：每日把快照傳到 Railway 的 Bucket（S3 相容儲存，與 Volume 分開）。需要新增 Bucket，會有少量費用。
3. **人工留存**：員工登入後可下載資料庫備份檔（每月留一份離線）。
另外：確認你的 Railway 方案是否提供 Volume 備份（我從這邊看不到），有的話一併打開。**文件要寫還原步驟，並實際演練一次還原**，沒演練過的備份不算備份。

## 8. 遷移與上線順序
1. **第一階段（必須在客戶使用前）**：建 `helpdesk.db`、寫入改為「案件＋事件」同交易、一次性匯入現有 `state.json` 與 `archive.db`（可重複執行、不覆蓋、原檔保留不刪）、接單／完成記錄處理人員、每日本地快照。
2. **第二階段**：報表頁與 CSV 匯出。
3. **第三階段**：Bucket 備份、人工下載、還原演練。
- 每階段都在本機先測、開 PR、你同意後才合併部署；匯入前先在 Railway 後台對 Volume 做一次手動備份（若方案支援）。
- 彙總儀表板（tnh-hub）的 `/api/metrics` 改從資料庫計算，輸出欄位不變。

## 9. 隱私
- 不記 IP、不記客戶身分；但「備註」是自由文字，客戶可能寫進姓名或電話。建議在客戶頁備註欄加提示「請勿填寫個人資料」。
- 備份檔同樣含備註，Bucket 與下載功能都要限制只有員工能存取。
- 「永久保留」是你的決定；建議另寫一句內部保存政策（保存目的、誰能看、多久檢視一次）。

## 10. 需要使用者決定
1. 處理人員：君子協定（建議）或個人帳號？
2. 要分析的指標：上表是預設集合，是否增減？接單時間目標是否就用 5 分鐘？
3. 要不要記錄被擋下的次數（`rejections`）？
4. 備份要做到哪一層？第 2 層會新增 Railway Bucket。
5. 備註欄要不要加「請勿填寫個人資料」提示？

## 11. 風險與限制
- SQLite 單檔、單一執行個體即可（目前就是）；若將來要多個實例需換資料庫。
- 事件紀錄只增不改，**寫錯了不能直接改**，要用補登的更正事件，這是設計上的取捨。
- 匯入舊資料時，舊案件沒有接單時間與處理人員，這些欄位會是空的，報表要排除。
