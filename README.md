FreeCloud daily check-in (email + password, no Telegram required)

This repository provides a GitHub Actions workflow and a Python script to perform daily check-ins for FreeCloud (WHMCS-based) at https://panel.freecloud.ltd using only email + password. The workflow runs every day at 00:00 UTC (08:00 Asia/Shanghai) and can also be triggered manually from the Actions tab.

What it does
- Logs into https://panel.freecloud.ltd via the WHMCS login page (handles CSRF token and cookies).
- If a 2FA/human-verification challenge is detected, the script marks the account as "2FA required" and continues with the next account.
- Attempts the daily check-in in the client area and reports per-account status: success / already checked / 2FA required / failed.
- Masks sensitive information in logs.
- Exit code is 0 if at least one account succeeded or was already checked; non-zero only if all accounts failed for non-2FA reasons.

How to use (GitHub Actions)
1) Add the following repository secret:
- ACCOUNTS: a JSON array of accounts. Each account contains label (optional), email, password. The base_url is optional and defaults to https://panel.freecloud.ltd.

Example ACCOUNTS value
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

2) Triggering the workflow manually
- Go to the Actions tab in GitHub.
- Select the workflow named "daily-checkin".
- Click "Run workflow".

Schedule
- The workflow is configured to run daily at 00:00 UTC (08:00 Asia/Shanghai).

Notes
- Only the ACCOUNTS secret is required. No Telegram or proxy is needed.
- The script uses requests with a session, handles CSRF token (token) on WHMCS login, and detects common 2FA/human-verification pages.
- If a 2FA challenge is present for all accounts, the job will print that status and exit 0 (since failures are not due to non-2FA reasons).
