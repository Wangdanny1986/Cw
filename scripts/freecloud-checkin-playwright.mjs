import { chromium } from 'playwright';

const ACCOUNTS = process.env.ACCOUNTS ? JSON.parse(process.env.ACCOUNTS) : [];
const BASE = 'https://panel.freecloud.ltd';
const LOGIN = `${BASE}/index.php?rp=/login`;
const CLIENT = `${BASE}/clientarea.php`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function trySelectors(page, selectors, action) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await action(el, sel);
      return true;
    }
  }
  return false;
}

async function loginAndCheckin(browser, acc) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
  });
  const page = await ctx.newPage();
  const label = acc.label || acc.email || 'acc';
  const stamp = () => new Date().toISOString().replace('T',' ').replace('Z',' UTC');

  console.log(`***${stamp()}*** ***${label}*** Opening login page ...`);
  try {
    await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const emailSelectors = ['input[name="email"]','input[name="username"]','#inputEmail','#email'];
    const pwSelectors = ['input[name="password"]','#inputPassword','#password'];

    const okEmail = await trySelectors(page, emailSelectors, (el) => el.fill(acc.email || ''));
    const okPw = await trySelectors(page, pwSelectors, (el) => el.fill(acc.password || ''));

    if (!okEmail || !okPw) {
      await ctx.close();
      return { label, status: 'failed', reason: 'login form not found' };
    }

    await Promise.race([
      page.click('button[type="submit"], button:has-text("登录"), button:has-text("Login"), input[type="submit"]'),
      (async () => { await sleep(400); await page.keyboard.press('Enter'); })()
    ]);

    const nav = await Promise.race([
      page.waitForURL(u => u.href.includes('clientarea') || u.href.includes('dashboard'), { timeout: 15000 }).then(()=> 'ok').catch(()=> null),
      page.waitForSelector('text=两步验证|二步验证|2FA|验证码|人机验证|验证', { timeout: 15000 }).then(()=> '2fa').catch(()=> null)
    ]);

    if (nav === '2fa' || !nav) {
      await ctx.close();
      return { label, status: '2fa_or_human_verification' };
    }

    if (!page.url().includes('clientarea')) {
      await page.goto(CLIENT, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
    }

    let clicked = false;
    for (const sel of ['text=每日签到','text=签到','text=Sign in','text=Check-in','button:has-text("签")','a:has-text("签")']) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(()=>{}); clicked = true; await sleep(2000); break; }
    }

    const content = (await page.textContent('body').catch(()=>'')) || '';
    let result = 'unknown';
    if (/已签到|已领取|already/i.test(content)) result = 'already';
    else if (/成功|Success/i.test(content)) result = 'success';
    else if (clicked && /签|Sign/i.test(content)) result = 'maybe_success';

    await ctx.close();
    if (['success','already','maybe_success'].includes(result)) {
      return { label, status: result };
    }
    return { label, status: 'failed', reason: 'unable to confirm check-in' };
  } catch (e) {
    await ctx.close();
    return { label, status: 'failed', reason: e?.message || 'exception' };
  }
}

async function main() {
  if (!Array.isArray(ACCOUNTS) || ACCOUNTS.length === 0) {
    console.log('No accounts configured.');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const acc of ACCOUNTS) {
    const r = await loginAndCheckin(browser, acc);
    console.log(`>>> ${r.label}: ${r.status}${r.reason ? ' - ' + r.reason : ''}`);
    results.push(r);
    await sleep(1000 + Math.floor(Math.random()*1000));
  }
  await browser.close();

  const ok = results.some(r => ['success','already','maybe_success'].includes(r.status));
  const hardFails = results.filter(r => r.status === 'failed');
  console.log('Summary:', results);
  process.exit(ok || hardFails.length < results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
