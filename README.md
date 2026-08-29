# 場地協助中心（Railway 版）

客戶掃場地內的 QR code 送出求助，工作人員在同一站台的儀表板即時看到並處理進度。

## 兩種畫面

- 工作人員儀表板：網站根目錄 `/`
- 客戶求助頁：`/?room=<場地代碼>`（各場地連結與 QR code 在儀表板的「場地設定」內產生）

## 本機測試

```
npm install
npm start
```

預設監聽 `PORT`（本機測試可先 `PORT=3000 npm start`），資料存在 `DATA_DIR`（預設為專案內的 `data/` 資料夾）。

## 部署到 Railway 需要注意

**務必新增一個 Volume 並掛載到 `/data`**（Railway 專案設定 → Volumes），否則每次重新部署，場地清單與求助紀錄都會被清空重來。伺服器會自動偵測 Railway 提供的 `RAILWAY_VOLUME_MOUNT_PATH` 環境變數；若沒有設定，會退回存在容器內的 `data/` 資料夾（不會保留到下次部署）。

不需要額外設定資料庫服務——資料以一個 JSON 檔案儲存在 Volume 裡，規模已足夠應付這個用途。
