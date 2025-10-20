# FreeCloud Check-in Automation (GH Actions + Node.js Playwright scaffolding)

This repository automates daily check-ins for V2Board/SSPanel-based panels (e.g., FreeCloud). It contains:

- GitHub Actions workflows that run a small Python 3.11 script daily using repository secrets (ACCOUNTS, TG_BOT_TOKEN, TG_CHAT_ID)
- A Node.js project scaffold configured for ES Modules with Playwright and an OTP library, enabling local runs and future browser-based fallbacks (for Cloudflare/captcha/OTP flows)

Note: The existing CI workflows continue to use Python. The Node.js code is provided for local runs and as a foundation to extend browser automation.

## Requirements

- Node.js 18+ (Node 20 recommended)
- npm 9+
- For Playwright on Linux: system packages or `npx playwright install --with-deps`

## Install

```bash
# In repo root
npm install
# Install Playwright browsers & OS dependencies (Linux)
npm run playwright:install
# On some Linux environments you may need root privileges for system deps
# sudo npm run playwright:install-deps
```

## Accounts configuration

You can provide accounts via either environment variables or a file. The Node runner will look for:

1) Environment variable ACCOUNTS_JSON (preferred) or ACCOUNTS (back-compat with workflows)
2) A local JSON file accounts.json in the repo root (or config/accounts.json)

Schema for each account object:

```json
{
  "base_url": "https://panel.freecloud.ltd",    // optional; defaults to this URL if omitted
  "email": "user@example.com",
  "password": "password123",
  "otp_secret": "JBSWY3DPEHPK3PXP",            // optional: base32 TOTP secret for 2FA
  "tg_chat_id": 123456789                        // optional: override default Telegram chat id
}
```

Provide an array of such objects. Example (as ACCOUNTS_JSON or accounts.json):

```json
[
  {
    "base_url": "https://panel.freecloud.ltd",
    "email": "alice@example.com",
    "password": "alice-password",
    "otp_secret": "JBSWY3DPEHPK3PXP",
    "tg_chat_id": 123456789
  },
  {
    "base_url": "https://another-panel.example",
    "email": "bob@example.com",
    "password": "bob-password"
  }
]
```

Tips:
- If you store the JSON in a GitHub secret, make sure it is a single-line, valid JSON string
- For local runs, you can export the variable or create an accounts.json file in the repository root

## Telegram notifications (optional)

Set the following environment variables:

- TG_BOT_TOKEN: Bot token from @BotFather
- TG_CHAT_ID: Default chat to receive messages

Per-account overrides: `tg_chat_id` in each account object.

## Run locally

```bash
# Provide configuration via env var
export ACCOUNTS_JSON='[{"email":"you@example.com","password":"..."}]'

# or create a local accounts.json file with the same array structure

# Install browsers/deps once
npm run playwright:install

# Run
npm run checkin
```

Environment flags for the Node runner:
- STARTUP_DELAY_MINUTES_MAX: default 120. Random start delay (minutes). Set 0 or NO_DELAY=1 to disable
- JITTER_MIN_SEC/JITTER_MAX_SEC: per-account wait jitter (default 5–60 seconds)
- PLAYWRIGHT_HEADFUL=1: run browser in non-headless mode for troubleshooting
- HTTP(S)_PROXY: use a proxy when needed

## NPM scripts

- npm run checkin: Run the Node-based check-in locally (V2Board API first, then Playwright fallback)
- npm run checkin:dev: Same as above with more verbose Node warnings
- npm run playwright:install: Install Playwright browsers and required OS dependencies (Linux)
- npm run playwright:install-deps: Install just OS dependencies (Linux)

## How it works

- The Python workflow tries a V2Board API login and check-in first. If that fails, it attempts SSPanel web flow. It can notify via Telegram.
- The Node.js runner mirrors the V2Board API attempt and includes a best-effort SSPanel fallback using Playwright. The fallback tries to log in and POST /user/checkin from the browser context, attaching CSRF headers when found. It also supports generating TOTP codes when `otp_secret` is present.

This scaffolding is intended to be extended as needed for site-specific flows (selectors, extra steps, Cloudflare mitigation, etc.).

## GitHub Actions secrets (for existing workflows)

Set these repository secrets:
- ACCOUNTS or ACCOUNTS_JSON: JSON array of account objects (see schema above)
- TG_BOT_TOKEN: Telegram bot token
- TG_CHAT_ID: Default Telegram chat id (optional if you set per-account tg_chat_id)

Workflows are in `.github/workflows/` and already reference the above secrets. You typically do not need to change the workflows.

## Troubleshooting

- Playwright missing libraries (Linux): run `npm run playwright:install` or `npx playwright install --with-deps`. You may need root privileges for OS deps (`sudo`)
- Cloudflare/captcha encountered: Use `PLAYWRIGHT_HEADFUL=1 npm run checkin` to see the browser, tweak flow, or add wait conditions/selectors for your panel
- OTP/TOTP issues: Ensure `otp_secret` is a base32-encoded secret; time on your machine must be correct for TOTP
- Proxying: set HTTP_PROXY/HTTPS_PROXY env vars if your environment requires a proxy
- TLS/certs: behind corporate proxies, set `NODE_EXTRA_CA_CERTS` to your CA bundle
- JSON parsing errors: validate your ACCOUNTS_JSON content is a proper JSON array

## Notes

- Do not commit secrets. Prefer GitHub Secrets for CI and environment variables locally
- Node code uses ES Modules (`type: module`)
- The Node runner is optional and does not alter CI workflows; it is provided for local usage and as a base for future improvements
