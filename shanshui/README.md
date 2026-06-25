# Shanshui integration

This folder hosts the shanshui report feature inside the existing davicool deployment service.

- page: `/shanshui/`
- routes:
  - `/api/shanshui/health`
  - `/api/shanshui/config`
  - `/api/shanshui/report`
  - `/api/shanshui/extension`
  - `/api/shanshui/chat`
  - `/api/shanshui/validate`

Default mode is `mock`.
Set `SHANSHUI_PROVIDER_MODE=live` and `GEMINI_API_KEY` to enable live provider calls.
