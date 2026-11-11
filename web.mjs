// 受控浏览器：插件自己的浏览器窗口（持久化 profile），一次登录同时拿到
//   1) OAuth 授权（PKCE，回调 127.0.0.1），插件用它换 token 和项目服务 AK；
//   2) meoo.com 的网页会话 cookie，每日积分（/api/mc/entitlement/init）只认这个。
//
// 为什么不直接用宿主打开的默认浏览器：那是一次性的，cookie 留在用户日常浏览器里，
// 插件拿不到；而且 cli.compat 的 OAuth token 打 /api/mc/... 是 401 NEED_LOGIN，
// 每日签到根本进不去。用同一个持久 profile，登录一次两边都通。
//
// 依赖 playwright-core 是 optionalDependencies：没装就静态降级（授权回退成宿主打开
// 系统浏览器，签到返回 failed 并说明原因），不影响插件的其他功能。

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const HOME_URL = "https://meoo.com/"
export const INIT_PATH = "/api/mc/entitlement/init"

/** 受控浏览器的 profile：登录态在这里，删掉等于退出登录。 */
export function profileDir() {
  return process.env.MEOO_WEB_PROFILE || join(homedir(), ".meoo", "web-profile")
}

export async function loadPlaywright() {
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return await import(name)
    } catch {}
  }
  return null
}

const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"]

async function launch(headless) {
  const pw = await loadPlaywright()
  if (!pw) {
    const err = new Error("没有可用的 playwright-core")
    err.code = "NO_PLAYWRIGHT"
    throw err
  }
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  const base = { headless, viewport: headless ? { width: 1280, height: 820 } : null, args: LAUNCH_ARGS }
  let lastErr = null
  // 用系统已装的 Chrome / Edge，避免再下一份 chromium
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await pw.chromium.launchPersistentContext(dir, { ...base, channel })
    } catch (e) {
      lastErr = e
    }
  }
  try {
    return await pw.chromium.launchPersistentContext(dir, base)
  } catch (e) {
    throw lastErr ?? e
  }
}

/**
 * 在受控浏览器里打开一个页面（授权登录用）。返回 { ok, close } —— 调用方负责关掉。
 * 打不开（没 playwright、没 Chrome、profile 被另一个实例占用）时 ok:false，调用方回退。
 */
export async function openBrowserWindow(url) {
  // 测试/无头环境：完全别启动浏览器（browserSignIn 会退化成宿主打开系统浏览器）
  if (process.env.MEOO_NO_BROWSER === "1") return { ok: false, close: async () => {}, error: "MEOO_NO_BROWSER=1" }
  try {
    const ctx = await launch(false)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {})
    return {
      ok: true,
      close: async () => {
        try {
          await ctx.close()
        } catch {}
      },
    }
  } catch (e) {
    return { ok: false, close: async () => {}, error: e?.message ?? String(e), code: e?.code ?? null }
  }
}

async function callInit(page) {
  return await page.evaluate(async (path) => {
    const res = await fetch(path, { headers: { accept: "application/json" }, credentials: "include" })
    let json = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json }
  }, INIT_PATH)
}

function normalize(r) {
  const j = r?.json ?? {}
  const d = j.data ?? {}
  return {
    status: r?.status ?? 0,
    granted: d.dailyLoginGranted ?? null,
    amount: d.dailyLoginGrantAmount ?? null,
    skipReason: d.dailyLoginSkipReason ?? null,
    error: j.errCode ? `${j.errCode} ${j.error?.message ?? ""}`.trim() : null,
  }
}

/**
 * 打开 profile、访问首页、在页面上下文里打 initEntitlement（服务端按北京日幂等）。
 * 请求从页面里发出，TLS 指纹、sec-fetch-* 都是真的，不用手工拼 cookie。
 */
export async function webDaily({ headless = true } = {}) {
  let ctx = null
  try {
    ctx = await launch(headless)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {})
    const r = await callInit(page).catch((e) => ({ status: 0, json: null, error: e?.message }))
    const out = normalize(r)
    return { ok: out.status === 200, ...out }
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e), code: e?.code ?? null }
  } finally {
    try {
      await ctx?.close()
    } catch {}
  }
}

/**
 * auth.checkin 的实现：把网页端的结果翻译成 magpie 的 outcome。
 * 注意 outcome 是 "claimed" / "done" / "failed" 这三档，captcha 语义这里用不上
 * （真出验证码时浏览器会停在验证页，initEntitlement 会拿不到 200，按 failed 报）。
 */
export async function checkinViaWeb() {
  // MEOO_WEB_DAILY=0：整体关掉签到（不重试、不报错）
  if (process.env.MEOO_WEB_DAILY === "0") return { outcome: "inactive", message: "MEOO_WEB_DAILY=0：签到已在插件里关闭" }
  if (!existsSync(profileDir())) {
    return { outcome: "failed", message: "受控浏览器里还没有 meoo.com 登录态：重新登录一次这个账号（会打开受控浏览器），或在设置里授权" }
  }
  const r = await webDaily({ headless: true })
  if (!r.ok) {
    if (r.code === "NO_PLAYWRIGHT") {
      return { outcome: "failed", message: "插件缺少 playwright-core，无法驱动受控浏览器签到（npm i playwright-core 后重试）" }
    }
    if (r.status === 401) {
      return { outcome: "failed", message: "受控浏览器里的 meoo.com 登录态失效了：重新登录一次这个账号" }
    }
    return { outcome: "failed", message: r.error ?? `签到请求失败（HTTP ${r.status || "?"}）` }
  }
  if (r.granted) return { outcome: "claimed", credit: r.amount ?? undefined, message: r.amount ? `+${r.amount} 积分` : undefined }
  if (r.skipReason === "ALREADY_GRANTED_TODAY") return { outcome: "done" }
  return { outcome: "done" }
}

// ---- 登录态有效期（面板用） -------------------------------------------------
// 只读 Chrome 的 Cookies 库拿 expires_utc，不解密任何值：面板要的是「还能用多久」，
// 不是 cookie 内容。库被浏览器占用时先拷到临时目录再读。

const CHROME_EPOCH_MS = 11644473600000 // 1601-01-01 → 1970-01-01
const AUTH_COOKIES = ["oneday_sid", "oneday_sid.sig", "login_oneday_ticket", "login_oneday_ticket.sig", "lang", "lang.sig"]

/** Chrome 的 cookies.expires_utc（1601 起的微秒）→ Date；0 是会话 cookie。 */
export function chromeTimeToDate(us) {
  const n = Number(us)
  if (!n) return null
  return new Date(n / 1000 - CHROME_EPOCH_MS)
}

/** 剩余时长的中文短写法。 */
export function formatRemain(ms) {
  if (ms == null) return "会话"
  if (ms <= 0) return "已过期"
  if (ms >= 86400000) return `${Math.floor(ms / 86400000)} 天`
  if (ms >= 3600000) return `${Math.floor(ms / 3600000)} 小时`
  return `${Math.max(1, Math.floor(ms / 60000))} 分钟`
}

/** 面板里的本地时间：2026-12-10 11:13:37。 */
export function formatLocal(iso) {
  if (!iso) return "会话"
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function cookiesDbFile(dir = profileDir()) {
  for (const rel of ["Default/Network/Cookies", "Network/Cookies", "Default/Cookies"]) {
    const f = join(dir, rel)
    if (existsSync(f)) return f
  }
  return null
}

const COOKIE_SQL = "SELECT name, host_key, expires_utc, is_secure, is_httponly FROM cookies WHERE host_key LIKE '%meoo.com' ORDER BY name"

async function queryCookies(file) {
  const tmp = join(tmpdir(), `meoo-cookies-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const copy = join(tmp, "Cookies")
  try {
    copyFileSync(file, copy)
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext)
    }
    // Bun 宿主（magpie）走 bun:sqlite；Node 22.5+ 有 node:sqlite；都没有就交给调用方降级
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(copy, { readonly: true })
      try {
        return { driver: "bun:sqlite", rows: db.query(COOKIE_SQL).all() }
      } finally {
        db.close()
      }
    } catch {}
    try {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        return { driver: "node:sqlite", rows: db.prepare(COOKIE_SQL).all() }
      } finally {
        db.close()
      }
    } catch {}
    return null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 登录态还剩多久：取参与鉴权的 6 个 cookie 里最早到期的那个。
 * 只读 expires_utc，不碰加密值，也不启动浏览器。
 */
export async function cookieExpiry() {
  const dir = profileDir()
  const at = new Date().toISOString()
  if (!existsSync(dir)) return { ok: false, reason: "NO_PROFILE", profile: dir, at }
  const file = cookiesDbFile(dir)
  if (!file) return { ok: false, reason: "NO_COOKIES_DB", profile: dir, at }
  const q = await queryCookies(file)
  if (!q) return { ok: false, reason: "NO_SQLITE", profile: dir, at }

  const now = Date.now()
  const seen = new Map()
  for (const row of q.rows) {
    if (seen.has(row.name)) continue
    const expires = chromeTimeToDate(row.expires_utc)
    seen.set(row.name, {
      name: row.name,
      host: row.host_key,
      httpOnly: !!row.is_httponly,
      secure: !!row.is_secure,
      expiresAt: expires ? expires.toISOString() : null,
      msLeft: expires ? expires.getTime() - now : null,
    })
  }
  const cookies = AUTH_COOKIES.map((n) => seen.get(n)).filter(Boolean)
  const timed = cookies.filter((c) => c.msLeft != null)
  const soonest = timed.length ? timed.reduce((a, b) => (a.msLeft <= b.msLeft ? a : b)) : null
  return {
    ok: true,
    at,
    profile: dir,
    driver: q.driver,
    sessionExpiresAt: soonest?.expiresAt ?? null,
    sessionMsLeft: soonest?.msLeft ?? null,
    missing: AUTH_COOKIES.filter((n) => !seen.has(n)),
    cookies,
  }
}

/**
 * 兜底：宿主运行时没有 sqlite（既不是 Bun，也不是 Node 22.5+）时，
 * 用受控浏览器读一遍 cookie 的到期时间。慢（要起 Chrome），调用方要节流。
 */
export async function cookieExpiryViaBrowser() {
  const at = new Date().toISOString()
  let ctx = null
  try {
    ctx = await launch(true)
    const list = await ctx.cookies("https://meoo.com/")
    const now = Date.now()
    const cookies = AUTH_COOKIES.map((name) => list.find((c) => c.name === name))
      .filter(Boolean)
      .map((c) => {
        const msLeft = c.expires > 0 ? c.expires * 1000 - now : null
        return {
          name: c.name,
          host: c.domain,
          httpOnly: c.httpOnly,
          secure: c.secure,
          expiresAt: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
          msLeft,
        }
      })
    const timed = cookies.filter((c) => c.msLeft != null)
    const soonest = timed.length ? timed.reduce((a, b) => (a.msLeft <= b.msLeft ? a : b)) : null
    return {
      ok: true,
      at,
      profile: profileDir(),
      driver: "playwright",
      sessionExpiresAt: soonest?.expiresAt ?? null,
      sessionMsLeft: soonest?.msLeft ?? null,
      missing: AUTH_COOKIES.filter((n) => !cookies.some((c) => c.name === n)),
      cookies,
    }
  } catch (e) {
    return { ok: false, reason: e?.code ?? "BROWSER_FAILED", profile: profileDir(), at, error: e?.message ?? String(e) }
  } finally {
    try {
      await ctx?.close()
    } catch {}
  }
}
