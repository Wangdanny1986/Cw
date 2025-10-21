FreeCloud daily check‑in automation (V2Board/SSPanel)

This repository contains a GitHub Actions workflow that performs daily check‑ins for FreeCloud/other V2Board or SSPanel panels. It supports password‑only login and makes TOTP optional. If a 2FA challenge (TOTP) or human verification (Cloudflare/captcha) is detected, the run will skip that account gracefully and report "2FA required" with an advice to switch to cookie‑mode or provide TOTP.

Key features
- Password‑only login supported (email + password). TOTP is optional.
- Detects 2FA/human verification blockers and marks the account as "2FA required" without failing the whole run.
- Falls back: tries V2Board API first, then SSPanel web flow.
- Multiple accounts via a single ACCOUNTS secret (JSON array).
- Telegram notifications with a final per‑account summary: success / already checked / failed / 2FA required.
- No secrets are logged. Only labels and high‑level status appear in logs/Telegram.

How to use (GitHub Actions)
1) Create repository secrets:
- ACCOUNTS: JSON array (see examples below)
- TG_BOT_TOKEN: Telegram bot token (optional but recommended)
- TG_CHAT_ID: Default Telegram chat ID (optional; can be overridden per account)

2) The workflow is scheduled daily and can be run manually from the Actions tab.

ACCOUNTS secret schema
Provide ACCOUNTS as a JSON array of account objects. Fields:
- label: Optional label used in logs/notifications (recommended). If omitted, your email will be masked for display.
- email: Account email (required)
- password: Account password (required)
- base_url: Optional panel base URL. Default: https://panel.freecloud.ltd
- tg_chat_id: Optional per‑account Telegram chat override
- totpSecret: Optional. If your account enforces 2FA, keep this here for cookie‑mode/Playwright‑based flows. The default password‑only flow will not use it and will mark the account as "2FA required" when a challenge appears.

Examples
Minimal (password‑only, no TOTP):
[
  {
    "label": "FreeCloud #1",
    "email": "user1@example.com",
    "password": "p@ssw0rd"
  },
  {
    "label": "FreeCloud #2",
    "email": "user2@example.com",
    "password": "another-pass",
    "base_url": "https://panel.freecloud.ltd"
  }
]

With optional TOTP secret present (kept for cookie‑mode/Playwright flows if you choose to use them):
[
  {
    "label": "My Main Account",
    "email": "me@example.com",
    "password": "super-secret",
    "totpSecret": "JBSWY3DPEHPK3PXP"
  }
]

What you will see in Telegram/logs
At the end of each run a summary is sent, for example:
- 成功: FreeCloud #1
- 已签到: FreeCloud #2
- 需2FA: My Main Account
- 失败: Backup Account

If an account is marked as 2FA required, the message will advise: 切换为 Cookie 模式或提供 TOTP (switch to cookie‑mode or provide a TOTP secret).

Notes
- This workflow first tries the V2Board API endpoint; if that does not work, it falls back to an SSPanel web flow. Some panels may deploy Cloudflare/hCaptcha/2FA gates which block automation. In such cases you will see the "2FA required" status.
- The script avoids printing credentials. Use the label field for friendly names.
- Random start delay and small jitter between accounts are applied to mimic human behavior.
