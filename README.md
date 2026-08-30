場地協助中心（Railway 版）

客戶掃場地內的 QR code 送出求助，工作人員在同一站台的儀表板即時看到並處理進度。

兩種畫面
工作人員儀表板：網站根目錄 /
客戶求助頁：/?room=<場地代碼>（各場地連結與 QR code 在儀表板的「場地設定」內產生）
本機測試
npm install
npm start

預設監聽 PORT（本機測試可先 PORT=3000 npm start），資料存在 DATA_DIR（預設為專案內的 data/ 資料夾）。

部署到 Railway 需要注意

務必新增一個 Volume 並掛載到 /data（Railway 專案設定 → Volumes），否則每次重新部署，場地清單與求助紀錄都會被清空重來。伺服器會自動偵測 Railway 提供的 RAILWAY_VOLUME_MOUNT_PATH 環境變數；若沒有設定，會退回存在容器內的 data/ 資料夾（不會保留到下次部署）。

不需要額外設定資料庫服務——即時使用的資料以一個 JSON 檔案（state.json）儲存在 Volume 裡，規模已足夠應付這個用途。

已完成案件的封存（analytics archive）

為了不讓主儀表板的資料無限變大，已完成的請求只會在畫面上保留「最近 150 筆、且在 7 天內」的紀錄，超過這個範圍的案件不會被丟掉，而是自動搬進同一個 Volume 裡的 SQLite 檔案 archive.db（資料表 archived_requests，含 room_id、category、created_at、updated_at 等欄位，並對 created_at／category 建了索引），供之後按日期或類別做分析、或串接報表工具查詢用。這個搬移是每次有新請求或狀態更新時自動觸發的，不需要另外排程；如果 SQLite 初始化失敗，伺服器會照常運作，只是不會封存（log 會印出錯誤原因）。

目前還沒有內建的查詢/匯出畫面——archive.db 就是一般的 SQLite 檔案，需要的話可以用任何 SQLite 工具打開查詢，或請 Claude 之後加一個按日期/類別篩選的分析頁面。
