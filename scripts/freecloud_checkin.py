#!/usr/bin/env python3
import os
import sys
import json
import time
import random
import re
import traceback
from typing import Dict, Any, Optional, Tuple

import requests
from urllib.parse import urljoin, urlparse

try:
    from bs4 import BeautifulSoup  # type: ignore
    HAVE_BS4 = True
except Exception:
    HAVE_BS4 = False


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

DEFAULT_BASE_URL = "https://panel.freecloud.ltd"

SUCCESS = "success"
ALREADY = "already"
TWO_FA = "2fa"
FAILED = "failed"
SKIPPED = "skipped"


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    print(f"[{ts} UTC] {msg}")


def mask_email(email: str) -> str:
    try:
        local, domain = email.split("@", 1)
    except ValueError:
        return "***"
    if len(local) <= 2:
        masked_local = local[0] + "*" * (len(local) - 1)
    else:
        masked_local = local[0] + "*" * (len(local) - 2) + local[-1]
    return f"{masked_local}@{domain}"


def safe_label(account: Dict[str, Any]) -> str:
    label = (account.get("label") or "").strip()
    if label:
        return label
    email = (account.get("email") or "").strip()
    return mask_email(email) if email else "(no-label)"


def is_2fa_or_human_challenge(text: str, url: str = "") -> bool:
    if not text:
        return False
    patterns = [
        r"Two\s*Factor",
        r"Two-?Factor",
        r"二次验证",
        r"二步验证",
        r"两步验证",
        r"验证码",  # generic verification code
        r"人机验证",
        r"机器人验证",
        r"hcaptcha",
        r"recaptcha",
        r"Please complete the security check",
        r"Attention Required!\s*Cloudflare",
        r"安全验证",
    ]
    if any(re.search(p, text, flags=re.I) for p in patterns):
        return True
    if re.search(r"two[-_]?factor|twofa|2fa", url, flags=re.I):
        return True
    return False


def http_request(
    session: requests.Session,
    method: str,
    url: str,
    retries: int = 3,
    backoff: float = 1.7,
    timeout: int = 30,
    **kwargs,
) -> requests.Response:
    last_exc = None
    for attempt in range(retries):
        try:
            resp = session.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code >= 500:
                raise requests.RequestException(
                    f"Server error: {resp.status_code}"
                )
            return resp
        except Exception as e:
            last_exc = e
            if attempt < retries - 1:
                sleep_s = backoff ** (attempt + 1) + random.uniform(0, 0.5)
                time.sleep(sleep_s)
            else:
                raise
    # Should not reach here
    raise last_exc  # type: ignore


def _extract_csrf_token_from_html(html: str) -> Optional[str]:
    if not html:
        return None
    # Try BeautifulSoup first if available
    if HAVE_BS4:
        try:
            soup = BeautifulSoup(html, "html.parser")
            # WHMCS usually uses input name="token"
            token_input = soup.find("input", attrs={"name": "token"})
            if token_input and token_input.get("value"):
                return token_input.get("value")
        except Exception:
            pass
    # Fallback regex
    m = re.search(r'name\s*=\s*[\"\']token[\"\']\s+value\s*=\s*[\"\']([^\"\']+)[\"\']', html, re.I)
    if m:
        return m.group(1)
    return None


def login_whmcs(
    session: requests.Session,
    base_url: str,
    email: str,
    password: str,
) -> Tuple[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Referer": base_url,
        "Connection": "keep-alive",
    }

    login_url = urljoin(base_url, "/index.php?rp=/login")

    # Visit login page to obtain CSRF token and cookies
    resp = http_request(session, "GET", login_url, headers=headers)
    text = resp.text or ""

    if is_2fa_or_human_challenge(text, resp.url):
        return TWO_FA, "2FA or human verification detected on login page"

    token = _extract_csrf_token_from_html(text)

    payload = {
        # WHMCS typically expects 'username' for the email address
        "username": email,
        "password": password,
        "rememberme": "on",
    }
    if token:
        payload["token"] = token

    # Determine post target: default to login_url
    post_url = login_url
    if HAVE_BS4:
        try:
            soup = BeautifulSoup(text, "html.parser")
            # find the login form if present
            form = None
            for f in soup.find_all("form"):
                if f.get("action") and re.search(r"/login", f.get("action"), re.I):
                    form = f
                    break
                # Heuristic: form contains an input for username/password
                if f.find("input", attrs={"name": "username"}) and f.find("input", attrs={"name": "password"}):
                    form = f
                    break
            if form and form.get("action"):
                post_url = urljoin(base_url, form.get("action"))
        except Exception:
            pass

    resp = http_request(
        session,
        "POST",
        post_url,
        headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
        data=payload,
        allow_redirects=True,
    )

    # If redirected to two-factor challenge or security check, mark as 2FA
    if is_2fa_or_human_challenge(resp.text or "", resp.url):
        return TWO_FA, "2FA or human verification challenge detected after login"

    # Heuristic checks for login failure messages
    failure_patterns = [
        r"Login Details Incorrect",
        r"Invalid\s+Login",
        r"登录失败",
        r"邮箱或密码错误",
        r"Email Address or Password",
        r"sign in was incorrect",
    ]
    if any(re.search(p, resp.text or "", re.I) for p in failure_patterns):
        return FAILED, "Invalid credentials or login failed"

    # Try accessing client area to confirm login
    ca_url = urljoin(base_url, "/clientarea.php")
    ca = http_request(session, "GET", ca_url, headers=headers)
    if is_2fa_or_human_challenge(ca.text or "", ca.url):
        return TWO_FA, "2FA or human verification detected in client area"

    # Check for a sign that we are logged in (presence of logout link, client area title etc.)
    logged_in_indicators = [
        r"Logout",
        r"退出",
        r"Client Area",
        r"客户中心",
        r"我的资料",
        r"服务",
    ]
    if any(re.search(p, ca.text or "", re.I) for p in logged_in_indicators):
        return SUCCESS, "Logged in"

    # If we reached here, uncertain state but treat as failed
    return FAILED, "Unable to confirm login"


def _find_checkin_action_in_html(base_url: str, html: str) -> Optional[Dict[str, Any]]:
    if not html:
        return None

    # Try BS4 first
    if HAVE_BS4:
        try:
            soup = BeautifulSoup(html, "html.parser")
            # Look for links/buttons with text containing 签到
            candidates = []
            for a in soup.find_all(["a", "button"]):
                txt = (a.get_text(strip=True) or "")
                if re.search(r"签到", txt):
                    href = a.get("href")
                    if href:
                        candidates.append({"method": "GET", "url": urljoin(base_url, href)})
            # Also look for forms that contain 签到 on a submit button or label
            for form in soup.find_all("form"):
                form_text = form.get_text(" ", strip=True) or ""
                if re.search(r"签到", form_text):
                    action = form.get("action") or ""
                    method = (form.get("method") or "POST").upper()
                    action_url = urljoin(base_url, action) if action else None
                    if action_url:
                        payload = {}
                        for inp in form.find_all("input"):
                            name = inp.get("name")
                            if not name:
                                continue
                            val = inp.get("value") or ""
                            payload[name] = val
                        candidates.append({"method": method, "url": action_url, "data": payload})
            if candidates:
                return candidates[0]
        except Exception:
            pass

    # Regex fallback: anchor with 签到 text
    m = re.search(
        r"<a[^>]+href=\"([^\"]+)\"[^>]*>[^<]*签到[^<]*</a>", html, flags=re.I | re.S
    )
    if m:
        return {"method": "GET", "url": urljoin(base_url, m.group(1))}

    # Regex fallback: form containing 签到
    m2 = re.search(
        r"<form[^>]+action=\"([^\"]+)\"[^>]*>(?:(?!</form>).)*签到(?:(?!</form>).)*</form>",
        html,
        flags=re.I | re.S,
    )
    if m2:
        action_url = urljoin(base_url, m2.group(1))
        # Try to include token if present
        token = _extract_csrf_token_from_html(html)
        payload = {"token": token} if token else {}
        return {"method": "POST", "url": action_url, "data": payload}

    return None


def perform_checkin(session: requests.Session, base_url: str) -> Tuple[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Referer": urljoin(base_url, "/clientarea.php"),
        "Connection": "keep-alive",
    }

    ca_url = urljoin(base_url, "/clientarea.php")
    ca = http_request(session, "GET", ca_url, headers=headers)

    action = _find_checkin_action_in_html(base_url, ca.text or "")
    if not action:
        # Heuristics: try a few common endpoints
        candidates = [
            "/clientarea.php?action=qiandao",
            "/clientarea.php?action=checkin",
            "/index.php?m=checkin",
            "/index.php?m=signin",
            "/index.php?rp=/checkin",
            "/index.php?rp=/signin",
        ]
        for path in candidates:
            test_url = urljoin(base_url, path)
            try:
                resp = http_request(session, "GET", test_url, headers=headers)
                if resp.status_code == 200 and re.search(r"签到|已签到|成功|积分|check-?in", resp.text or "", re.I):
                    action = {"method": "GET", "url": test_url}
                    break
            except Exception:
                continue

    if not action:
        return FAILED, "Check-in entry not found"

    method = action.get("method", "GET").upper()
    url = action.get("url")
    data = action.get("data") or {}

    if not url:
        return FAILED, "Check-in action URL missing"

    if method == "POST":
        # Ensure token if any needed
        if "token" not in data:
            # Try to fetch latest token from current page
            token = _extract_csrf_token_from_html(ca.text or "")
            if token:
                data["token"] = token
        resp = http_request(
            session,
            "POST",
            url,
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            data=data,
            allow_redirects=True,
        )
    else:
        resp = http_request(session, "GET", url, headers=headers, allow_redirects=True)

    # Determine result
    text = resp.text or ""
    # JSON case
    try:
        maybe_json = resp.headers.get("Content-Type", "").lower().startswith("application/json")
        if maybe_json:
            j = resp.json()
            # common patterns
            msg = j.get("message") or j.get("msg") or j.get("status") or ""
            if isinstance(msg, str):
                if re.search(r"已签到|already|重复", msg, re.I):
                    return ALREADY, msg
                if re.search(r"成功|success|ok", msg, re.I):
                    return SUCCESS, msg
            # fallback by boolean flags
            for k in ("success", "ok", "result"):
                if k in j and bool(j[k]) is True:
                    return SUCCESS, msg or "OK"
    except Exception:
        pass

    # HTML case
    if re.search(r"今日已签到|已签到|already", text, re.I):
        return ALREADY, "Already checked in today"
    if re.search(r"签到成功|成功|success", text, re.I):
        return SUCCESS, "Check-in success"
    if is_2fa_or_human_challenge(text, resp.url):
        return TWO_FA, "2FA or human verification encountered during check-in"

    return FAILED, "Unable to determine check-in result"


def send_telegram_summary(token: str, chat_id: str, message: str) -> None:
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "disable_web_page_preview": True,
        }
        requests.post(url, data=payload, timeout=20)
    except Exception as e:
        log(f"Telegram send failed: {e}")


def main() -> int:
    raw_accounts = os.getenv("ACCOUNTS")
    if not raw_accounts:
        log("No ACCOUNTS provided, exiting.")
        return 0

    try:
        accounts = json.loads(raw_accounts)
        if not isinstance(accounts, list):
            raise ValueError("ACCOUNTS must be a JSON array")
    except Exception as e:
        log(f"Invalid ACCOUNTS JSON: {e}")
        return 1

    tg_token = os.getenv("TG_BOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN") or ""
    tg_default_chat = os.getenv("TG_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID") or ""

    random.seed(time.time())
    # Random initial delay [0, 15] seconds
    time.sleep(random.uniform(0, 15))

    results = []  # list of tuples (status, label, detail)

    for idx, account in enumerate(accounts):
        label = safe_label(account)
        email = (account.get("email") or "").strip()
        password = (account.get("password") or "").strip()
        base_url = (account.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
        chat_id = (account.get("tg_chat_id") or tg_default_chat).strip()

        if not email or not password:
            log(f"[{label}] Missing email/password, skipping.")
            results.append((FAILED, label, "Missing credentials"))
            continue

        # Small jitter between accounts
        time.sleep(random.uniform(1.5, 4.5))

        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT})

        log(f"[{label}] Logging in at {base_url} ...")
        try:
            status, detail = login_whmcs(session, base_url, email, password)
        except Exception as e:
            log(f"[{label}] Login error: {e}")
            if os.getenv("DEBUG"):
                traceback.print_exc()
            results.append((FAILED, label, f"Login error: {e}"))
            continue

        if status == TWO_FA:
            log(f"[{label}] 2FA/human verification detected. Skipping check-in.")
            results.append((TWO_FA, label, detail))
            continue
        if status != SUCCESS:
            log(f"[{label}] Login failed: {detail}")
            results.append((FAILED, label, detail))
            continue

        # Try to check in
        try:
            status, detail = perform_checkin(session, base_url)
        except Exception as e:
            log(f"[{label}] Check-in error: {e}")
            if os.getenv("DEBUG"):
                traceback.print_exc()
            results.append((FAILED, label, f"Check-in error: {e}"))
            continue

        if status == SUCCESS:
            log(f"[{label}] Check-in success.")
        elif status == ALREADY:
            log(f"[{label}] Already checked in today.")
        elif status == TWO_FA:
            log(f"[{label}] 2FA/human verification encountered during check-in.")
        else:
            log(f"[{label}] Check-in failed: {detail}")
        results.append((status, label, detail))

        # Light delay after each account to be polite
        time.sleep(random.uniform(1.0, 3.0))

    # Build summary
    lines = []
    ok_count = 0
    fail_count = 0
    twofa_count = 0
    for status, label, _detail in results:
        if status == SUCCESS:
            ok_count += 1
            lines.append(f"- 成功: {label}")
        elif status == ALREADY:
            ok_count += 1
            lines.append(f"- 已签到: {label}")
        elif status == TWO_FA:
            twofa_count += 1
            lines.append(f"- 需2FA: {label}")
        else:
            fail_count += 1
            lines.append(f"- 失败: {label}")

    header = "FreeCloud 每日签到结果"
    msg = header + "\n" + "\n".join(lines)
    if twofa_count > 0:
        msg += "\n\n提示: 有账号需要 2FA/人机验证，建议切换 Cookie 模式或提供 TOTP。"

    # Always print summary to console
    log(msg)

    # Optional Telegram summary (not required)
    if tg_token and tg_default_chat:
        send_telegram_summary(tg_token, tg_default_chat, msg)

    # Exit code policy: non-zero exit only if all accounts failed due to non-2FA errors
    total_accounts = len([r for r in results])
    hard_failures = len([1 for s, _l, _d in results if s == FAILED])
    if hard_failures == total_accounts and total_accounts > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
