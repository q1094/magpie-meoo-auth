// 受控浏览器 / 每日签到的纯逻辑测试：不启动浏览器、不碰网络。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkinViaWeb, chromeTimeToDate, cookieExpiry, formatLocal, formatRemain, profileDir } from "../web.mjs"

test("profileDir：默认落在 ~/.meoo/web-profile，可用 MEOO_WEB_PROFILE 覆盖", () => {
  const prev = process.env.MEOO_WEB_PROFILE
  try {
    delete process.env.MEOO_WEB_PROFILE
    assert.match(profileDir(), /[\\/]\.meoo[\\/]web-profile$/)
    const dir = mkdtempSync(join(tmpdir(), "meoo-web-"))
    process.env.MEOO_WEB_PROFILE = dir
    assert.equal(profileDir(), dir)
  } finally {
    if (prev === undefined) delete process.env.MEOO_WEB_PROFILE
    else process.env.MEOO_WEB_PROFILE = prev
  }
})

test("checkin：受控浏览器里还没登录过 → failed，并说清楚怎么补", async () => {
  const prev = process.env.MEOO_WEB_PROFILE
  const dir = mkdtempSync(join(tmpdir(), "meoo-web-"))
  process.env.MEOO_WEB_PROFILE = join(dir, "not-logged-in")
  try {
    const r = await checkinViaWeb()
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /还没有 meoo\.com 登录态/)
  } finally {
    if (prev === undefined) delete process.env.MEOO_WEB_PROFILE
    else process.env.MEOO_WEB_PROFILE = prev
  }
})

test("chromeTimeToDate：Chrome 的 1601 微秒 → Date，0 表示会话 cookie", () => {
  assert.equal(chromeTimeToDate(0), null)
  const epoch = 11644473600000000 // 1970-01-01T00:00:00Z
  assert.equal(chromeTimeToDate(epoch).toISOString(), "1970-01-01T00:00:00.000Z")
  assert.equal(chromeTimeToDate(epoch + 86400 * 1e6).toISOString(), "1970-01-02T00:00:00.000Z")
})

test("formatRemain：天 / 小时 / 分钟 / 已过期 / 会话", () => {
  assert.equal(formatRemain(null), "会话")
  assert.equal(formatRemain(-1), "已过期")
  assert.equal(formatRemain(29 * 86400000 + 3600000), "29 天")
  assert.equal(formatRemain(3 * 3600000), "3 小时")
  assert.equal(formatRemain(90 * 1000), "1 分钟")
})

test("formatLocal：面板里的时间写法", () => {
  assert.equal(formatLocal(new Date(2026, 11, 10, 11, 13, 37).toISOString()), "2026-12-10 11:13:37")
  assert.equal(formatLocal(null), "会话")
})

test("cookieExpiry：没有受控浏览器 profile → NO_PROFILE，不启动浏览器", async () => {
  const prev = process.env.MEOO_WEB_PROFILE
  const dir = mkdtempSync(join(tmpdir(), "meoo-web-"))
  process.env.MEOO_WEB_PROFILE = join(dir, "missing")
  try {
    const r = await cookieExpiry()
    assert.equal(r.ok, false)
    assert.equal(r.reason, "NO_PROFILE")
  } finally {
    if (prev === undefined) delete process.env.MEOO_WEB_PROFILE
    else process.env.MEOO_WEB_PROFILE = prev
  }
})
