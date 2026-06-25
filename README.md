# 工廠客戶拜訪管理系統

Render Web Service 部署用 Node.js 專案。

## 善水報告功能

已整合同站入口：

```text
/shanshui/
```

相關 API：

```text
/api/shanshui/health
/api/shanshui/config
/api/shanshui/report
/api/shanshui/extension
/api/shanshui/chat
/api/shanshui/validate
```

預設為 `mock` 模式。若要改接真實 Gemini：

```text
SHANSHUI_PROVIDER_MODE=live
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

## Render 設定

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Environment Variables:

```text
DATA_DIR=/opt/render/project/src/data
GOOGLE_SHEET_WRITE_URL=Apps Script Web App URL
GOOGLE_SHEET_WRITE_SECRET=factory-crm-2026-secret
```

若尚未部署 Apps Script，可先只設定 `DATA_DIR`。

## 預設登入

```text
admin / admin123
```

上線後請新增自己的管理員帳號，再停用預設 admin。
