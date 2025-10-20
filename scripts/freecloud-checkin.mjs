import { chromium } from 'playwright';
import crypto from 'node:crypto';

// Environment variables
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || process.env.ACCOUNTS || '[]';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '';

// Defaults
const DEFAULT_BASE_URL = 'https://panel.freecloud.ltd';

// Utility: mask sensitive values in logs
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
  const [user, domain] = email.split('@');
  const maskedUser = user.length <= 2 ? `${user[0] || ''}*` : `${user.slice(0, 1)}***${user.slice(-1)}`;
  const maskedDomain = domain.replace(/[^.]/g, '*');
  return `${maskedUser}@${maskedDomain}`;
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url ? '***' : '';
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function sendTelegram(text, chatId) {
  const token = TELEGRAM_BOT_TOKEN;
  const chat = chatId || TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const body = new URLSearchParams({ chat_id: chat, text });
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!resp.ok) {
      console.warn('Telegram send failed:', resp.status, await resp.text());
    }
  } catch (e) {
    console.warn('Telegram send error:', e?.message || e);
  }
}

// ----- TOTP generation (RFC 6238) -----
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32DecodeToBuffer(base32) {
  if (!base32) throw new Error('Empty TOTP secret');
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) {
    const val = BASE32_ALPHABET.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret, { step = 30, digits = 6, t = Date.now() } = {}) {
  const counter = Math.floor((t / 1000) / step);
  const buf = Buffer.alloc(8);
  if (typeof buf.writeBigUInt64BE === 'function') {
    buf.writeBigUInt64BE(BigInt(counter));
  } else {
    // Fallback for very old Node versions
    let ctr = counter;
    for (let i = 7; i >= 0; i--) {
      buf[i] = ctr & 0xff;
      ctr = Math.floor(ctr / 256);
    }
  }
  const key = base32DecodeToBuffer(secret);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | (hmac[offset + 3]);
  const str = String(code % 10 ** digits).padStart(digits, '0');
  return str;
}

// Resilient helpers
async function withRetries(fn, desc, { attempts = 3, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      console.warn(`[retry ${i}/${attempts}] ${desc}:`, e?.message || e);
      if (i < attempts) await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function gotoWithRetries(page, url, { attempts = 3 } = {}) {
  const u = maskUrl(url);
  return withRetries(async (i) => {
    await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
    return true;
  }, `goto ${u}`, { attempts });
}

async function fillFirstVisible(page, selectors, value, { timeout = 8000 } = {}) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    try {
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().fill(value, { timeout });
      return true;
    } catch {}
  }
  return false;
}

async function pressEnterOnFirst(page, selectors, { timeout = 8000 } = {}) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    try {
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().press('Enter', { timeout });
      return true;
    } catch {}
  }
  return false;
}

async function clickAny(page, selectors, { timeoutPerTry = 5000, attempts = 3, delayBetween = 500 } = {}) {
  for (let a = 1; a <= attempts; a++) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: timeoutPerTry });
        await Promise.race([
          loc.click({ timeout: timeoutPerTry }),
          page.keyboard.press('Enter').catch(() => {}),
        ]);
        return true;
      } catch {}
    }
    await sleep(delayBetween);
  }
  return false;
}

async function waitForAny(page, selectors, { timeout = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        try {
          if (await loc.isVisible()) return sel;
        } catch {}
      }
    }
    await sleep(200);
  }
  return null;
}

function extractAccountFields(acc) {
  const baseUrl = (acc.base_url || acc.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const email = acc.email || acc.user || acc.username;
  const password = acc.password || acc.pass || acc.pwd;
  const totpSecret = acc.totp_secret || acc.totpSecret || acc.totp || acc.mfa_secret || acc.ga_secret || acc.otp_secret || '';
  const tgChatId = acc.tg_chat_id || acc.telegram_chat_id || '';
  return { baseUrl, email, password, totpSecret, tgChatId };
}

async function tryLoginV2Board(page, { baseUrl, email, password, totpSecret }) {
  await gotoWithRetries(page, `${baseUrl}/#/signin`).catch(() => {});

  const emailFilled = await fillFirstVisible(page,
    [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="email" i]',
      'input[autocomplete="username"]',
      'input[name="username"]',
    ],
    email
  );

  const pwdFilled = await fillFirstVisible(page,
    [
      'input[name="password"]',
      'input[type="password"]',
      'input[placeholder*="密码"]',
      'input[placeholder*="password" i]'
    ],
    password
  );

  if (!emailFilled || !pwdFilled) {
    return false;
  }

  // Optional TOTP field on some v2board deployments
  const maybeTotpVisible = await waitForAny(page, [
    'input[name="otp"]',
    'input[name="totp"]',
    'input[name="code"]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="Google" i]'
  ], { timeout: 500 });
  if (maybeTotpVisible && totpSecret) {
    const code = generateTOTP(totpSecret);
    await fillFirstVisible(page, [maybeTotpVisible], code).catch(() => {});
  }

  const clicked = await clickAny(page, [
    'button[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("登錄")',
    'text=登录',
    'text=Sign in'
  ], { attempts: 3, timeoutPerTry: 6000 });

  if (!clicked) {
    // Try pressing enter on password field as a fallback
    await pressEnterOnFirst(page, [
      'input[name="password"]',
      'input[type="password"]'
    ]).catch(() => {});
  }

  // Wait for post-login cue
  try {
    await Promise.race([
      page.waitForURL(/#\/(dashboard|orders|plan|profile)/, { timeout: 12000 }).catch(() => {}),
      page.waitForURL(/\/(user|dashboard)/, { timeout: 12000 }).catch(() => {}),
      page.waitForSelector('text=签到', { timeout: 12000 }).catch(() => {}),
    ]);
  } catch {}

  // Heuristic: if login form still visible, consider failure
  const stillOnLogin = await waitForAny(page, [
    'input[name="email"]', 'input[type="email"]', 'text=登录'
  ], { timeout: 500 });
  return !stillOnLogin; // true means likely logged in
}

async function tryLoginSSPanel(page, { baseUrl, email, password, totpSecret }) {
  await gotoWithRetries(page, `${baseUrl}/auth/login`).catch(() => {});

  const emailFilled = await fillFirstVisible(page, [
    'input[name="email"]',
    'input[type="email"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="email" i]'
  ], email);
  const pwdFilled = await fillFirstVisible(page, [
    'input[name="passwd"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="密码"]',
  ], password);
  if (!emailFilled || !pwdFilled) return false;

  // SSPanel 2FA code field is typically name=code
  const codeFieldVisible = await waitForAny(page, [
    'input[name="code"]', 'input[name="otp"]', 'input[name="totp"]', 'input[placeholder*="验证码"]'
  ], { timeout: 500 });
  if (codeFieldVisible && totpSecret) {
    const code = generateTOTP(totpSecret);
    await fillFirstVisible(page, [codeFieldVisible], code).catch(() => {});
  }

  const clicked = await clickAny(page, [
    'button[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("Sign in")',
    'button:has-text("Login")'
  ], { attempts: 3, timeoutPerTry: 6000 });
  if (!clicked) {
    await pressEnterOnFirst(page, [
      'input[name="passwd"]', 'input[name="password"]'
    ]).catch(() => {});
  }

  // Expect to land on /user
  try { await page.waitForURL(/\/user/, { timeout: 12000 }); } catch {}

  const onUser = /\/user/.test(page.url());
  return onUser;
}

async function performCheckin(page, baseUrl) {
  // Prepare to capture responses for /checkin endpoints
  const responses = [];
  const respListener = (resp) => {
    try {
      const url = resp.url();
      if (/checkin/i.test(url)) responses.push(resp);
    } catch {}
  };
  page.on('response', respListener);

  try {
    // Try V2Board dashboard first
    await page.goto(`${baseUrl}/#/dashboard`, { timeout: 25000 }).catch(() => {});
    let clicked = await clickAny(page, [
      '#checkin',
      'button#checkin',
      'a#checkin',
      'button:has-text("签到")',
      'text=签到',
      'text=每日签到',
      'text=打卡',
      'button:has-text("Checkin")',
      'text=/check-?in/i'
    ], { attempts: 3, timeoutPerTry: 5000 });

    if (!clicked) {
      await page.goto(`${baseUrl}/user`, { timeout: 25000 }).catch(() => {});
      clicked = await clickAny(page, [
        '#checkin', 'button#checkin', 'a#checkin',
        'button:has-text("签到")', 'text=签到', 'text=每日签到', 'text=打卡'
      ], { attempts: 3, timeoutPerTry: 5000 });
    }

    // Capture feedback via common notifiers or API response
    let message = '';

    // After clicking, wait a bit for any dialogs/toasts
    await sleep(2000);

    try {
      const textSel = await waitForAny(page, [
        '.swal2-html-container',
        '.swal2-container .swal2-html-container',
        '.layui-layer-content',
        '.modal-dialog',
        '.el-message', '.el-message__content',
        '.el-notification__content',
        '.van-toast', '.van-toast__text',
        'text=/已签到|签到成功|获得|流量|明日再来|success|ok/i'
      ], { timeout: 5000 });
      if (textSel) {
        try {
          const el = page.locator(textSel).first();
          const v = (await el.textContent()) || '';
          message = v.trim();
        } catch {}
      }
    } catch {}

    if (!message && responses.length) {
      for (const r of responses) {
        try {
          const ct = r.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const j = await r.json();
            const raw = typeof j === 'string' ? j : JSON.stringify(j);
            if (/msg|message|result/.test(raw)) message = raw;
          } else {
            const t = await r.text();
            if (t) message = t.slice(0, 200);
          }
        } catch {}
      }
    }

    return { clicked, message: message || (clicked ? '已点击签到按钮' : '未找到签到按钮') };
  } finally {
    page.off('response', respListener);
  }
}

async function runForAccount(acc) {
  const { baseUrl, email, password, totpSecret, tgChatId } = extractAccountFields(acc);
  const maskedEmail = maskEmail(email);
  const baseMasked = maskUrl(baseUrl);

  if (!email || !password) {
    const msg = `[${baseMasked}] 缺少邮箱/密码，跳过。`;
    console.log(msg);
    await sendTelegram(msg, tgChatId);
    return { ok: false, summary: msg };
  }

  console.log(`开始签到：${maskedEmail} @ ${baseMasked}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Try V2Board login first, then fallback to SSPanel login
    let loggedIn = await tryLoginV2Board(page, { baseUrl, email, password, totpSecret });
    if (!loggedIn) {
      loggedIn = await tryLoginSSPanel(page, { baseUrl, email, password, totpSecret });
    }
    if (!loggedIn) {
      const msg = `${maskedEmail} -> 登录失败（可能需要验证码/异常防护）`;
      console.log(msg);
      await sendTelegram(msg, tgChatId);
      return { ok: false, summary: msg };
    }

    const { clicked, message } = await performCheckin(page, baseUrl);
    const ok = Boolean(clicked);
    const summary = `${maskedEmail} -> ${ok ? '签到尝试完成' : '签到失败'}${message ? `：${message}` : ''}`;
    console.log(summary);
    await sendTelegram(summary, tgChatId);
    return { ok, summary };
  } catch (e) {
    const msg = `${maskedEmail} -> 运行异常：${e?.message || e}`;
    console.warn(msg);
    await sendTelegram(msg, tgChatId);
    return { ok: false, summary: msg };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseAccountsEnv() {
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && parsed.accounts && Array.isArray(parsed.accounts)) return parsed.accounts;
    return [];
  } catch {
    console.warn('无法解析 ACCOUNTS_JSON，期望为 JSON 数组');
    return [];
  }
}

async function main() {
  const accounts = parseAccountsEnv();
  if (!accounts.length) {
    console.error('未提供 ACCOUNTS_JSON 或格式不正确。');
    process.exit(2);
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const res = await runForAccount(accounts[i]);
    if (res.ok) success++; else failed++;
    if (i < accounts.length - 1) {
      const jitter = 2000 + Math.floor(Math.random() * 4000);
      await sleep(jitter);
    }
  }

  if (success === 0) {
    console.error('所有账户签到均失败。');
    process.exit(1);
  }
}

// Run
main().catch((e) => {
  console.error('Fatal error:', e?.stack || e?.message || e);
  process.exit(1);
});
