#!/usr/bin/env node

import { chromium } from 'playwright';

const BASE_URL = 'https://panel.freecloud.ltd';

const STATUS = {
  SUCCESS: 'success',
  ALREADY: 'already',
  TWO_FA: '2fa',
  FAILED: 'failed',
};

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function maskEmail(email) {
  try {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***';
    if (local.length <= 2) return `${local[0]}${'*'.repeat(Math.max(0, local.length - 1))}@${domain}`;
    return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
  } catch {
    return '***';
  }
}

function safeLabel(account) {
  const label = (account.label || '').trim();
  if (label) return label;
  const email = (account.email || '').trim();
  return email ? maskEmail(email) : '(no-label)';
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, jitterMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      const delay = Math.round(baseDelayMs * Math.pow(1.7, i) + Math.random() * jitterMs);
      if (i < attempts - 1) await sleep(delay);
    }
  }
  throw lastErr;
}

async function is2FAOrHuman(page) {
  try {
    const content = await page.content();
    const url = page.url();
    const patterns = [
      /Two\s*Factor/i,
      /Two-?Factor/i,
      /二次验证|二步验证|两步验证/i,
      /验证码/i,
      /人机验证|机器人验证/i,
      /hcaptcha/i,
      /recaptcha/i,
      /Please\s+complete\s+the\s+security\s+check/i,
      /Attention\s+Required!\s*Cloudflare/i,
      /安全验证/i,
    ];
    if (patterns.some((p) => p.test(content)) || /two[-_]?factor|twofa|2fa/i.test(url)) {
      return true;
    }

    // If there's an hcaptcha/recaptcha iframe, mark as human verification
    const challengeFrame = page.frames().find(f => /recaptcha|hcaptcha/i.test(f.url()));
    if (challengeFrame) return true;
  } catch {
    // ignore
  }
  return false;
}

async function safeGoto(page, url) {
  return withRetry(async () => {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return resp;
  });
}

async function ensureLoggedIn(page) {
  // Heuristics: presence of "Logout"/"退出" or clientarea URL
  const txt = await page.textContent('body');
  if (page.url().includes('clientarea') || /Logout|退出|Client\s*Area|客户中心|我的资料|服务/i.test(txt || '')) {
    return true;
  }
  return false;
}

async function performLogin(page, baseUrl, email, password) {
  const loginUrl = `${baseUrl}/index.php?rp=/login`;

  await safeGoto(page, loginUrl);

  if (await is2FAOrHuman(page)) {
    return { status: STATUS.TWO_FA, detail: '2FA or human verification detected on login page' };
  }

  // Fill username/email
  const emailSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    '#inputEmail',
    '#username',
    'input[type="email"]',
  ];
  const pwdSelectors = [
    'input[name="password"]',
    '#inputPassword',
    'input[type="password"]',
  ];

  let emailBox, pwdBox;
  for (const sel of emailSelectors) {
    const loc = page.locator(sel);
    if (await loc.first().count()) { emailBox = loc.first(); break; }
  }
  for (const sel of pwdSelectors) {
    const loc = page.locator(sel);
    if (await loc.first().count()) { pwdBox = loc.first(); break; }
  }

  if (!emailBox || !pwdBox) {
    // try a light wait for dynamic rendering
    await page.waitForTimeout(1500);
    if (!emailBox) {
      for (const sel of emailSelectors) {
        const loc = page.locator(sel);
        if (await loc.first().count()) { emailBox = loc.first(); break; }
      }
    }
    if (!pwdBox) {
      for (const sel of pwdSelectors) {
        const loc = page.locator(sel);
        if (await loc.first().count()) { pwdBox = loc.first(); break; }
      }
    }
  }

  if (!emailBox || !pwdBox) {
    return { status: STATUS.FAILED, detail: 'Login form not found' };
  }

  await emailBox.fill(email, { timeout: 15000 });
  await pwdBox.fill(password, { timeout: 15000 });

  // Click submit
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
    'input[type="submit"]',
  ];

  let clicked = false;
  for (const sel of submitSelectors) {
    const loc = page.locator(sel);
    if (await loc.first().count()) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        loc.first().click({ timeout: 15000 }).catch(() => {}),
      ]);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // fallback: press Enter in password field
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      pwdBox.press('Enter').catch(() => {}),
    ]);
  }

  if (await is2FAOrHuman(page)) {
    return { status: STATUS.TWO_FA, detail: '2FA or human verification challenge detected after login' };
  }

  // Check for login failure messages
  const bodyText = (await page.textContent('body')) || '';
  const failurePatterns = [
    /Login\s+Details\s+Incorrect/i,
    /Invalid\s+Login/i,
    /登录失败|邮箱或密码错误/i,
    /Email Address or Password/i,
    /sign in was incorrect/i,
  ];
  if (failurePatterns.some((p) => p.test(bodyText))) {
    return { status: STATUS.FAILED, detail: 'Invalid credentials or login failed' };
  }

  // Navigate to client area to confirm login
  await safeGoto(page, `${baseUrl}/clientarea.php`);
  if (await is2FAOrHuman(page)) {
    return { status: STATUS.TWO_FA, detail: '2FA or human verification detected in client area' };
  }

  if (await ensureLoggedIn(page)) {
    return { status: STATUS.SUCCESS, detail: 'Logged in' };
  }

  return { status: STATUS.FAILED, detail: 'Unable to confirm login' };
}

async function performCheckin(page, baseUrl) {
  // Ensure we are in client area
  await safeGoto(page, `${baseUrl}/clientarea.php`);

  const searchers = [
    'a:has-text("签到")',
    'button:has-text("签到")',
    'a:has-text("每日签到")',
    'button:has-text("每日签到")',
    'a:has-text("Check-in")',
    'button:has-text("Check-in")',
  ];

  for (const sel of searchers) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        loc.click({ timeout: 10000 }).catch(() => {}),
      ]);
      // After clicking, try to detect result
      await page.waitForTimeout(1500);
      const text = (await page.textContent('body')) || '';
      if (/今日已签到|已签到|already/i.test(text)) return { status: STATUS.ALREADY, detail: 'Already checked in today' };
      if (/签到成功|成功|success|ok/i.test(text)) return { status: STATUS.SUCCESS, detail: 'Check-in success' };
      if (await is2FAOrHuman(page)) return { status: STATUS.TWO_FA, detail: '2FA/human verification encountered during check-in' };
      break; // if button existed but we couldn't determine, try fallbacks
    }
  }

  // Try common endpoints directly
  const candidates = [
    '/clientarea.php?action=qiandao',
    '/clientarea.php?action=checkin',
    '/index.php?m=checkin',
    '/index.php?m=signin',
    '/index.php?rp=/checkin',
    '/index.php?rp=/signin',
  ];
  for (const path of candidates) {
    const url = `${baseUrl}${path}`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    if (!resp) continue;
    const ct = resp.headers()['content-type'] || '';
    try {
      if (/application\/json/i.test(ct)) {
        const j = await resp.json();
        const msg = j.message || j.msg || j.status || '';
        if (typeof msg === 'string') {
          if (/已签到|already|重复/i.test(msg)) return { status: STATUS.ALREADY, detail: msg };
          if (/成功|success|ok/i.test(msg)) return { status: STATUS.SUCCESS, detail: msg };
        }
        for (const k of ['success', 'ok', 'result']) {
          if (k in j && Boolean(j[k]) === true) return { status: STATUS.SUCCESS, detail: msg || 'OK' };
        }
      }
    } catch {
      // ignore parse errors
    }

    const html = await resp.text().catch(() => '');
    if (/今日已签到|已签到|already/i.test(html)) return { status: STATUS.ALREADY, detail: 'Already checked in today' };
    if (/签到成功|成功|success/i.test(html)) return { status: STATUS.SUCCESS, detail: 'Check-in success' };
    if (await is2FAOrHuman(page)) return { status: STATUS.TWO_FA, detail: '2FA/human verification encountered during check-in' };
  }

  return { status: STATUS.FAILED, detail: 'Unable to determine check-in result' };
}

async function runForAccount(browser, account) {
  const label = safeLabel(account);
  const email = (account.email || '').trim();
  const password = (account.password || '').trim();
  const baseUrl = BASE_URL; // fixed per ticket

  if (!email || !password) {
    return { status: STATUS.FAILED, label, detail: 'Missing credentials' };
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    log(`[${label}] Logging in at ${baseUrl} ...`);
    const loginRes = await withRetry(() => performLogin(page, baseUrl, email, password), { attempts: 3, baseDelayMs: 1200 });
    if (loginRes.status === STATUS.TWO_FA) {
      return { status: STATUS.TWO_FA, label, detail: loginRes.detail };
    }
    if (loginRes.status !== STATUS.SUCCESS) {
      return { status: STATUS.FAILED, label, detail: loginRes.detail };
    }

    const checkinRes = await withRetry(() => performCheckin(page, baseUrl), { attempts: 2, baseDelayMs: 1200 });
    return { status: checkinRes.status, label, detail: checkinRes.detail };
  } catch (e) {
    return { status: STATUS.FAILED, label, detail: String(e && e.message ? e.message : e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function main() {
  const raw = process.env.ACCOUNTS;
  if (!raw) {
    log('No ACCOUNTS provided, exiting.');
    process.exit(0);
    return;
  }

  let accounts;
  try {
    accounts = JSON.parse(raw);
    if (!Array.isArray(accounts)) throw new Error('ACCOUNTS must be a JSON array');
  } catch (e) {
    log(`Invalid ACCOUNTS JSON: ${e.message || e}`);
    process.exit(1);
    return;
  }

  // Random initial delay 0-15s
  await sleep(Math.floor(Math.random() * 15000));

  const browser = await chromium.launch({ headless: true });

  const results = [];
  for (const account of accounts) {
    // Small jitter per account
    await sleep(1500 + Math.floor(Math.random() * 3000));
    const r = await runForAccount(browser, account);
    if (r.status === STATUS.SUCCESS) {
      log(`[${r.label}] Check-in success.`);
    } else if (r.status === STATUS.ALREADY) {
      log(`[${r.label}] Already checked in today.`);
    } else if (r.status === STATUS.TWO_FA) {
      log(`[${r.label}] 2FA/human verification required.`);
    } else {
      log(`[${r.label}] Check-in failed: ${r.detail}`);
    }
    results.push(r);
    await sleep(1000 + Math.floor(Math.random() * 2000));
  }

  await browser.close().catch(() => {});

  // Summary
  let ok = 0, fail = 0, twofa = 0;
  const lines = [];
  for (const r of results) {
    if (r.status === STATUS.SUCCESS) { ok++; lines.push(`- 成功: ${r.label}`); }
    else if (r.status === STATUS.ALREADY) { ok++; lines.push(`- 已签到: ${r.label}`); }
    else if (r.status === STATUS.TWO_FA) { twofa++; lines.push(`- 需2FA: ${r.label}`); }
    else { fail++; lines.push(`- 失败: ${r.label}`); }
  }

  const header = 'FreeCloud 每日签到结果';
  const msg = `${header}\n${lines.join('\n')}` + (twofa > 0 ? '\n\n提示: 有账号需要 2FA/人机验证。' : '');
  log(msg);

  // Exit code policy: non-zero if all failed for non-2FA reasons
  const total = results.length;
  const hardFailures = results.filter((r) => r.status === STATUS.FAILED).length;
  if (total > 0 && hardFailures === total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => {
  log(`Fatal error: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
