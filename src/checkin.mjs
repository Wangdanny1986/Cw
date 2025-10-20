/*
  FreeCloud/V2Board/SSPanel check-in automation scaffolding
  - Tries V2Board API first (login -> checkin)
  - Falls back to SSPanel via Playwright (best-effort)
  - Optional Telegram notifications

  Environment variables:
    ACCOUNTS_JSON: JSON array of account objects
    ACCOUNTS:      Back-compat with existing workflows (same format as ACCOUNTS_JSON)
    TG_BOT_TOKEN:  Telegram bot token (optional)
    TG_CHAT_ID:    Default Telegram chat ID (optional)

  Account object fields:
    {
      "base_url": "https://panel.freecloud.ltd", // optional, default as shown
      "email": "user@example.com",
      "password": "password123",
      "otp_secret": "JBSWY3DPEHPK3PXP",          // optional TOTP secret (base32)
      "tg_chat_id": 123456789                      // optional per-account chat id
    }
*/

import { authenticator } from 'otplib';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GLOBAL_TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const GLOBAL_TG_CHAT_ID = process.env.TG_CHAT_ID || '';

async function notify(message, chatId) {
  const c = chatId || GLOBAL_TG_CHAT_ID;
  console.log(message);
  if (!GLOBAL_TG_BOT_TOKEN || !c) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${GLOBAL_TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text: message }),
    });
    if (!resp.ok) {
      console.warn('TG notify failed:', resp.status, await safeText(resp));
    }
  } catch (e) {
    console.warn('TG notify error:', e?.message || e);
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function readAccounts() {
  const rawEnv = process.env.ACCOUNTS_JSON || process.env.ACCOUNTS || '';
  const cwd = process.cwd();
  const filePathCandidates = [
    path.join(cwd, 'accounts.json'),
    path.join(cwd, 'config', 'accounts.json')
  ];

  if (rawEnv) {
    try {
      const data = JSON.parse(rawEnv);
      if (Array.isArray(data)) return data;
      console.error('ACCOUNTS_JSON/ACCOUNTS must be a JSON array.');
    } catch (e) {
      console.error('Failed to parse ACCOUNTS_JSON/ACCOUNTS:', e?.message || e);
    }
  }

  for (const p of filePathCandidates) {
    if (fs.existsSync(p)) {
      try {
        const txt = fs.readFileSync(p, 'utf8');
        const data = JSON.parse(txt);
        if (Array.isArray(data)) return data;
        console.error(`${p} must contain a JSON array`);
      } catch (e) {
        console.error('Failed to read accounts file:', p, e?.message || e);
      }
    }
  }

  return [];
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function choice(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function v2BoardCheckin(baseUrl, email, password) {
  try {
    const loginResp = await fetch(`${baseUrl}/api/v1/passport/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!loginResp.ok) {
      return [false, `V2 login failed ${loginResp.status}: ${await safeText(loginResp)}`];
    }
    let data = {};
    try {
      data = await loginResp.json();
    } catch {}
    const token = (data?.data?.token) || data?.token;
    if (!token) return [false, `V2 no token in response: ${JSON.stringify(data).slice(0, 200)}`];

    const ckResp = await fetch(`${baseUrl}/api/v1/user/checkin`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    let cj; try { cj = await ckResp.json(); } catch { cj = { raw: await safeText(ckResp) }; }
    return [ckResp.ok, ckResp.ok ? `V2 success: ${JSON.stringify(cj)}` : `V2 failed ${ckResp.status}: ${JSON.stringify(cj)}`];
  } catch (e) {
    return [false, `V2 request error: ${e?.message || e}`];
  }
}

function extractCsrf(html) {
  const m1 = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)/i);
  const m2 = html.match(/csrfToken["']\s*[:=]\s*["']([^"']+)/i);
  const m3 = html.match(/name=["']_token["']\s+value=["']([^"']+)/i);
  const m = m1 || m2 || m3;
  return m ? m[1] : null;
}

async function sspanelCheckinWithPlaywright(baseUrl, email, password, otpSecret) {
  const headless = process.env.PLAYWRIGHT_HEADFUL ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // Navigate to login
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Fill credentials (common field names)
    const emailSel = 'input[name="email"], input[type="email"]';
    const pwdSel = 'input[name="passwd"], input[type="password"]';
    await page.fill(emailSel, email);
    await page.fill(pwdSel, password);

    // Optional TOTP code if a field exists and secret provided
    if (otpSecret) {
      const code = authenticator.generate(otpSecret);
      const codeSel = 'input[name="code"], input[name="otp"], input[name="totp"]';
      const codeInputs = await page.$$(codeSel);
      if (codeInputs.length) {
        await page.fill(codeSel, code);
      }
    }

    // Try submit form
    const submitSel = 'button[type="submit"], button:has-text("登录"), button:has-text("Sign in"), input[type="submit"]';
    const found = await page.$(submitSel);
    if (found) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
        found.click(),
      ]);
    } else {
      // Fallback: press Enter in password field
      await page.press(pwdSel, 'Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
    }

    // Go to /user
    await page.goto(`${baseUrl}/user`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Attempt POST /user/checkin via in-page fetch, attaching CSRF if present
    const res = await page.evaluate(async () => {
      function getCsrf() {
        const m = document.querySelector('meta[name="csrf-token"]');
        if (m) return m.getAttribute('content') || '';
        const input = document.querySelector('input[name="_token"]');
        return input?.getAttribute('value') || '';
      }
      const headers = { 'X-Requested-With': 'XMLHttpRequest' };
      const csrf = getCsrf();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      try {
        const r = await fetch('/user/checkin', { method: 'POST', headers });
        let j; try { j = await r.json(); } catch { j = { raw: await r.text() }; }
        return { ok: r.ok, status: r.status, body: j };
      } catch (e) {
        return { ok: false, status: 0, body: { error: String(e) } };
      }
    });

    if (res?.ok) {
      return [true, `SS success: ${JSON.stringify(res.body)}`];
    }
    return [false, `SS failed ${res?.status ?? 'n/a'}: ${JSON.stringify(res?.body ?? {})}`];
  } catch (e) {
    return [false, `SS playwright error: ${e?.message || e}`];
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runOne(acc) {
  const base = (acc.base_url || 'https://panel.freecloud.ltd').replace(/\/$/, '');
  const email = acc.email;
  const pwd = acc.password;
  const chat = acc.tg_chat_id;
  const otpSecret = acc.otp_secret || '';
  if (!email || !pwd) {
    await notify(`[${base}] Missing email/password, skip.`, chat);
    return;
  }

  await notify(`Start check-in: ${email} @ ${base}`, chat);

  const [ok1, msg1] = await v2BoardCheckin(base, email, pwd);
  if (ok1) { await notify(`${email} -> ${msg1}`, chat); return; }
  await notify(`${email} -> [V2 not successful] ${msg1}`, chat);

  const [ok2, msg2] = await sspanelCheckinWithPlaywright(base, email, pwd, otpSecret);
  if (ok2) { await notify(`${email} -> ${msg2}`, chat); return; }
  await notify(`${email} -> [SS not successful] ${msg2}`, chat);
}

async function main() {
  const maxDelayMin = Number(process.env.STARTUP_DELAY_MINUTES_MAX ?? '120');
  const noDelay = process.env.NO_DELAY === '1' || process.env.NO_DELAY === 'true';
  if (!noDelay && maxDelayMin > 0) {
    const d = choice(0, maxDelayMin) * 60 * 1000;
    if (d > 0) {
      console.log(`Random startup delay: ${Math.round(d / 1000)} sec`);
      await delay(d);
    }
  }

  const accounts = readAccounts();
  if (!accounts.length) {
    console.error('No accounts provided. Set ACCOUNTS_JSON or ACCOUNTS env var, or create accounts.json file.');
    process.exitCode = 1;
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    await runOne(acc);
    if (i < accounts.length - 1) {
      const jitter = choice(Number(process.env.JITTER_MIN_SEC ?? '5'), Number(process.env.JITTER_MAX_SEC ?? '60'));
      console.log(`Wait before next account: ${jitter} sec`);
      await delay(jitter * 1000);
    }
  }
}

const isMain = process.argv[1] ? (import.meta.url === pathToFileURL(process.argv[1]).href) : false;
if (isMain) {
  main().catch((e) => {
    console.error('Fatal error:', e?.stack || e);
    process.exitCode = 1;
  });
}
