// OpenCode & Magpie provider plugin for Meoo 秒悟 (meoo.com).
//
// 由 dsh-meoo-connect（dsh/DeepSeek Harness 插件）迁移而来，同一套 Meoo
// 官方「AI 服务」链路，换到 Magpie 的 provider 插件平面上：
//
//   登录      OAuth Authorization Code + PKCE（public client，本机 loopback 回调）
//   项目 AK   控制面 /open/v1/cli-compat/...（身份 → 项目 → 云服务 environment）
//   模型目录  网关 {gateway}/models（OpenAI 兼容，Bearer 项目服务 AK）
//   转发      不自己做适配器——声明 @ai-sdk/openai-compatible，由宿主 SDK 走网关
//
// 三种登录方式：
//   1. 浏览器授权：点一次「授权」，之后身份/项目/云服务 AK 全自动解析。
//   2. 复用本机登录态：只读 dsh-meoo-connect（$DSH_HOME/meoo/state.json）或
//      meoo-proxy（~/.meoo-proxy/config.json）已保存的登录态，连授权点击都省了。
//   3. 手填项目服务 AK：meoo_project_service_v1.* 开头，适合不想走 OAuth 的人。
//
// 凭证只存放在宿主的账号记录里（client.auth.set），本插件不落地任何文件。
// 调用消耗 Meoo 账号自身额度，不绕过任何计费；与 Meoo 官方无关联。

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkinViaWeb, cookieExpiry, cookieExpiryViaBrowser, formatLocal, formatRemain, openBrowserWindow } from "./web.mjs"

const PROVIDER_ID = "meoo"
// 外层显示名：Magpie 的插件/供应商列表里露出来的就是这一条短名 "Meoo"；
// 点进去看到的完整包名来自宿主读到的插件 spec —— magpie-meoo-auth。
const PROVIDER_NAME = "Meoo"
// 账号记录里没有用户名时的兜底称呼，保留中文全名，免得两个 Meoo 混淆。
const ACCOUNT_FALLBACK = "Meoo 秒悟"
const NPM = "@ai-sdk/openai-compatible"

const DEFAULT_API_BASE = "https://meoo.com"
const DEFAULT_GATEWAY = "https://api.meoo.host/meoo-ai/compatible-mode/v1"
const PROD_CLIENT_ID = "meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh"
const TEST_CLIENT_ID = "meoo_app_SFNvmHUFNePxyyfGjCd9hyaE"
const OAUTH_SCOPE = "cli.compat"
const CALLBACK_PATH = "/oauth/callback"
// 控制面要求 CLI 客户端标记（与 dsh-meoo-connect 同一套公开契约）。
const CLI_HEADERS = { "x-meoo-client": "cli", "x-meoo-cli-version": "0.5.6" }

const EARLY_MS = 60 * 1000
const LEAD_MS = 5 * 60 * 1000
const KEEP_RENEWED_MS = 60 * 1000
const CATALOG_TTL_MS = 10 * 60 * 1000
// 目录里认不出的新模型先按保守值给，等它也进规格表。
const CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000

/**
 * 模型规格表。网关 /models 只回裸 id，不带上下文/输出上限，所以数字得自己带。
 * 取值来自各家官方文档（2026-11 核对）：
 *   Qwen 3.8/3.7 全家 1M 上下文 / 131072 输出；
 *   DeepSeek V4 全家 1M / 384K；
 *   GLM-5.2 与 GLM-5.2-Fast 1M / 128K；
 *   Qwen VL 262144 / 32768。
 * image 只给官方写明原生多模态的那几个，其余按纯文本，免得让 UI 递图片。
 */
const MODEL_SPECS = [
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash", context: 1_000_000, output: 131_072, image: true },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", context: 1_000_000, output: 131_072, image: true },
  { id: "qwen3.7-max", name: "Qwen3.7-Max", context: 1_000_000, output: 131_072 },
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus", context: 1_000_000, output: 131_072, image: true },
  { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 384_000, image: true },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", context: 1_000_000, output: 384_000 },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", context: 1_000_000, output: 384_000 },
  { id: "glm-5.2-fast-preview", name: "GLM-5.2-Fast", context: 1_000_000, output: 128_000 },
  { id: "glm-5.2", name: "GLM-5.2", context: 1_000_000, output: 128_000 },
  { id: "qwen3-vl-plus", name: "Qwen VL", context: 262_144, output: 32_768, image: true },
]

/**
 * 候选模型：文档里写了、网关 /models 却不一定列出来的 id。
 *
 * 2026-11 实测：Meoo 文档「支持模型介绍」把 Kimi K3 / K3.1 Pro、GLM-5.3 / 5.3-Flash、
 * MiniMax M3.1 Flash、Qwen3.8-Max-0902 都算作平台模型，但项目的 OpenAI 兼容网关
 * （/meoo-ai/compatible-mode/v1）只收 9 个文本 id：
 *   qwen3.8-flash、qwen3.8-max、qwen3.7-max、qwen3.7-plus、deepseek-v4.1-flash-1017、
 *   deepseek-v4-pro-0813、deepseek-v4-flash-0731、glm-5.2-fast-preview、glm-5.2
 * 其余一律 400「当前仅支持配置模型: …」。Kimi / GLM-5.3 / MiniMax 走的是 Meoo 的
 * Agent 产品（/open/v1/projects/<id>/agent/runs），不是这个网关——那是
 * magpie-plugin-meoo-agent 的活。
 *
 * 所以这里逐个探：网关接了才进目录，不接就当它不存在。Meoo 哪天放开，插件下次
 * 拉目录就自动带上，不需要发版。qwen3-vl-plus 就是这样被探出来的（文档写了、
 * /models 不列、网关可调）。
 */
const SUPPLEMENT_MODELS = [
  "qwen3-vl-plus", // 视觉理解：实测可用
  "qwen3.8-max-0902",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k3",
  "kimi-k3.1-pro",
  "minimax-m3.1-flash",
]

/** 用户自己往目录里塞 id：逗号分隔。仍然要过网关那一探，不接的不进目录。 */
const extraModels = () =>
  String(process.env.MEOO_EXTRA_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const MODEL_BY_ID = new Map(MODEL_SPECS.map((m) => [m.id, m]))

/** 目录里出现的未知 id 当纯文本、给保守上限，不把 1M 乱许出去。 */
function specOf(id) {
  return MODEL_BY_ID.get(id) ?? { id, name: id, context: CONTEXT_WINDOW, output: DEFAULT_MAX_TOKENS }
}

const mainOrigin = () => String(process.env.MEOO_MAIN_SITE_URL || DEFAULT_API_BASE).replace(/\/+$/, "")
const gatewayBase = () => String(process.env.MEOO_GATEWAY_BASE_URL || DEFAULT_GATEWAY).replace(/\/+$/, "")
// apiBase 跟着账号记录走（登录用的哪个站点，续期/控制面就打哪个），环境变量只是兜底。
const apiBaseOf = (a) => String(a?.apiBase || mainOrigin()).replace(/\/+$/, "")

function clientIdFor(apiBaseUrl) {
  try {
    return new URL(apiBaseUrl).hostname.toLowerCase() === "meoo.com" ? PROD_CLIENT_ID : TEST_CLIENT_ID
  } catch {
    return TEST_CLIENT_ID
  }
}

const labelOf = (id) => specOf(id).name
const int = (n, fallback = 0) => {
  const v = Math.trunc(Number(n))
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
const vendorError = (json, text) => json?.detail || json?.message || String(text ?? "").slice(0, 160)

/** 最近一批还没用完的积分的到期日（YYYY-MM-DD），给余额卡当提示。 */
function soonestLapse(grants) {
  let best = ""
  for (const g of Array.isArray(grants) ? grants : []) {
    for (const d of g?.grantDetails || []) {
      if (int(d?.remainingAmount) <= 0) continue
      const day = String(d?.expiresDate || "").slice(0, 10)
      if (!day) continue
      if (!best || day < best) best = day
    }
  }
  return best
}

// ---- OAuth（Authorization Code + PKCE，public client）----------------------

async function tokenRequest(apiBaseUrl, params) {
  const res = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) throw new Error(`OAuth 换票失败 HTTP ${res.status}: ${json.error || text.slice(0, 160)}`)
  return json
}

// 单飞续期：同一 refresh token 的并发续期共享一次请求，60 秒内的结果直接复用。
const renewed = new Map()
const renewing = new Map()

async function callRefreshApi(a) {
  const base = apiBaseOf(a)
  const token = await tokenRequest(base, {
    grant_type: "refresh_token",
    client_id: clientIdFor(base),
    refresh_token: a.refresh,
  })
  return {
    access: token.access_token,
    ...(token.refresh_token ? { refresh: token.refresh_token } : {}),
    expires: Date.now() + int(token.expires_in || 3600, 3600) * 1000,
    ...(token.scope ? { scope: token.scope } : {}),
    ...(token.openid ? { openid: token.openid } : {}),
  }
}

async function renewToken(a, save) {
  const key = a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) {
    const merged = { ...a, ...done.next }
    await save?.(merged)
    return merged
  }
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const next = await callRefreshApi(a)
      renewed.set(key, { next, at: Date.now() })
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  const next = await r
  const merged = { ...a, ...next }
  await save?.(merged)
  return merged
}

// Meoo 的 access token 过期时间是登录/续期时给的 expires_in，不是 JWT 声明；
// 没有 expires 就当过期（与 dsh 的 ensureAccessToken 语义一致）。
function isStale(a, marginMs = EARLY_MS) {
  const exp = Number(a?.expires) || 0
  return !(exp > Date.now() + marginMs)
}

async function currentAuth(ctx, auth, force = false) {
  let a = { ...auth }
  for (let i = 0; i < 8 && a.refresh; i++) {
    const d = renewed.get(a.refresh)
    if (!d || Date.now() - d.at >= KEEP_RENEWED_MS) break
    a = { ...a, ...d.next }
  }
  const alreadyRenewed = a.access !== auth.access || a.refresh !== auth.refresh
  if ((alreadyRenewed || !force) && !isStale(a, EARLY_MS)) {
    if (alreadyRenewed) await persistOf(ctx)(a)
    return { a, didRenew: alreadyRenewed }
  }
  if (!a.refresh) {
    if (!force && a.access && !isStale(a, 0)) return { a, didRenew: alreadyRenewed }
    const err = new Error("Meoo 登录态已过期且没有 refresh token，请重新登录")
    err.signIn = "expired"
    throw err
  }
  const next = await renewToken(a, persistOf(ctx))
  return { a: next, didRenew: true }
}

// ---- 控制面：账号 / 项目 / 项目服务 AK --------------------------------------

async function controlCall(apiBase, access, method, apiPath, body) {
  const res = await fetch(`${apiBase}${apiPath}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...CLI_HEADERS,
      authorization: `Bearer ${access}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  // Meoo 的业务错误也走 HTTP 200（{"success":false,"errCode":...}），要在这里拦下来
  if (json && typeof json === "object" && json.success === false) {
    const err = new Error(`${apiPath} 失败: ${json.message || json.errCode || "unknown error"}`)
    err.status = res.status
    err.errCode = json.errCode
    throw err
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 401
        ? `${apiPath} 失败 HTTP 401（登录态已失效，请重新登录）: ${vendorError(json, text)}`
        : `${apiPath} 失败 HTTP ${res.status}: ${vendorError(json, text)}`,
    )
    err.status = res.status
    throw err
  }
  return json?.data !== undefined ? json.data : json
}

/** 运行期控制面调用：先确保 access 新鲜，401 时强制续期重试一次。 */
async function controlRequest(ctx, a, method, apiPath, body) {
  const { a: fresh } = await currentAuth(ctx, a)
  try {
    return await controlCall(apiBaseOf(fresh), fresh.access, method, apiPath, body)
  } catch (e) {
    if (e?.status === 401 && fresh.refresh) {
      const next = await renewToken(fresh, persistOf(ctx))
      return controlCall(apiBaseOf(fresh), next.access, method, apiPath, body)
    }
    throw e
  }
}

async function fetchIdentity(ctx, a) {
  return await controlRequest(ctx, a, "GET", "/open/v1/cli-compat/account/identity")
}

async function listProjects(ctx, a, limit = 50) {
  const data = await controlRequest(ctx, a, "GET", `/open/v1/cli-compat/projects?page_size=${limit}`)
  return data?.list || data?.items || data?.projects || (Array.isArray(data) ? data : [])
}

/**
 * 新账号常常一个项目都没有（项目服务 AK 挂在项目下，没有项目就没有 AK）。
 * 控制面的项目创建接口已验证可用：先试带名字，失败退回空请求体（Meoo 会建
 * 一个 "untitled" 项目）。创建失败返回 null，由调用方决定怎么报错。
 */
async function createProject(ctx, a) {
  try {
    return await controlRequest(ctx, a, "POST", "/open/v1/cli-compat/projects", { name: "AI 服务" })
  } catch {
    try {
      return await controlRequest(ctx, a, "POST", "/open/v1/cli-compat/projects", {})
    } catch {
      return null
    }
  }
}

/**
 * 选中一个项目：显式指定 > 记录里的 projectUrlId > 身份默认项目 > 唯一项目。
 * 多个项目时不替用户做主（计费归属不同），报错并列出可选项。
 */
async function pickProject(ctx, a, explicitUrlId) {
  if (explicitUrlId) return explicitUrlId
  let preferred = a?.projectUrlId || ""
  if (!preferred) {
    try {
      const me = await fetchIdentity(ctx, a)
      preferred = me?.project_url_id || me?.projectUrlId || ""
    } catch {}
  }
  if (preferred) return preferred
  const projects = await listProjects(ctx, a)
  if (!projects.length) {
    const created = await createProject(ctx, a)
    const urlId = created?.url_id || created?.urlId
    if (!urlId) throw new Error("账号下还没有项目，自动创建也失败了：请在 meoo.com 手动建一个项目后重试")
    return urlId
  }
  if (projects.length === 1) {
    const only = projects[0]?.url_id || projects[0]?.urlId
    if (!only) throw new Error("项目列表里没有 url_id，无法定位项目")
    return only
  }
  const options = projects.map((p) => `${p.url_id || p.urlId}（${p.name || "未命名"}）`).join("、")
  const err = new Error(
    `账号下有多个项目，无法自动确定项目服务 AK 的归属。浏览器登录时回调页会列出项目让你选一个；也可以改用「项目服务 AK」登录方式直接指定。可选：${options}`,
  )
  err.code = "MULTIPLE_PROJECTS"
  err.projects = projects
  throw err
}

/** 取项目服务 AK；项目没开云服务时自动开通一次再取。 */
async function resolveServiceAk(ctx, a, { projectUrlId } = {}) {
  const urlId = await pickProject(ctx, a, projectUrlId)
  if (a?.serviceAk && a.serviceAkProjectId === urlId) return { urlId, ak: a.serviceAk }

  const envPath = `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud/environment`
  let ak = null
  try {
    const env = await controlRequest(ctx, a, "GET", envPath)
    ak = env?.meooProjectApiKey || env?.instance?.meooProjectApiKey || null
  } catch {
    ak = null
  }
  let cloudErrMessage = null
  if (!ak) {
    try {
      await controlRequest(ctx, a, "POST", `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud`, {
        description: "magpie-meoo-auth: AI 服务",
      })
      const env = await controlRequest(ctx, a, "GET", envPath)
      ak = env?.meooProjectApiKey || env?.instance?.meooProjectApiKey || null
    } catch (e) {
      cloudErrMessage = e?.message ?? String(e)
      ak = null
    }
  }
  if (!ak) {
    throw new Error(
      `项目 ${urlId} 还没开通 Meoo AI 服务：在 meoo.com 打开该项目，在对话框里发一句「帮我开启云服务」（或让 AI 加一个需要后端/AI 的功能，平台会自动开通并签发 AK），开通后重试` +
        (cloudErrMessage ? `（自动开通失败：${cloudErrMessage}）` : ""),
    )
  }
  return { urlId, ak }
}

/** 运行期取 AK：有缓存就用缓存，否则解析并持久化进账号记录。 */
async function serviceAkOf(ctx, a) {
  const urlId = await pickProject(ctx, a)
  if (a?.serviceAk && a.serviceAkProjectId === urlId) return a.serviceAk
  const { urlId: resolved, ak } = await resolveServiceAk(ctx, a, { projectUrlId: urlId })
  await persistOf(ctx)({ ...a, projectUrlId: resolved, serviceAk: ak, serviceAkProjectId: resolved })
  return ak
}

// ---- 模型目录 ---------------------------------------------------------------

let catalogCache = { origin: "", models: null, at: 0 }

const resetCatalogCache = () => {
  catalogCache = { origin: "", models: null, at: 0 }
}

function parseGatewayModels(payload) {
  const list = payload?.models || payload?.data || (Array.isArray(payload) ? payload : [])
  const seen = new Set()
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    const id = typeof entry === "string" ? entry.trim() : String(entry?.id ?? "").trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const spec = specOf(id)
    out.push({
      id,
      name: (typeof entry === "object" && entry?.name) || spec.name,
      context: int(entry?.context) || spec.context,
      output: int(entry?.max_output || entry?.max_output_tokens || entry?.max_tokens) || spec.output,
      image: !!spec.image,
    })
  }
  return out
}

/**
 * 探一个目录外的模型：1 token 的对话请求，网关接了才算可用。
 * 只用来补 SUPPLEMENT_MODELS，结果随目录一起缓存，10 分钟最多探一次。
 */
async function acceptsModel(ak, id) {
  try {
    const res = await fetch(`${gatewayBase()}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ak}`, "content-type": "application/json" },
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(20_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 并发探多个 id，限速 4 条同时，别把网关打满。 */
async function probeModels(ak, ids) {
  const out = []
  const queue = [...ids]
  const worker = async () => {
    for (;;) {
      const id = queue.shift()
      if (!id) return
      if (await acceptsModel(ak, id)) out.push(id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
  return out
}

async function fetchGatewayModels(ak) {
  const base = gatewayBase()
  if (catalogCache.models && catalogCache.origin === base && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models
  }
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${ak}`, accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`模型目录 HTTP ${res.status}`)
  const models = parseGatewayModels(await res.json())
  if (!models.length) throw new Error("empty catalog")
  const seen = new Set(models.map((m) => m.id))
  // 文档里有、目录里没有的 id 逐个探；接了就补进目录，不接的不进。
  const missing = [...new Set([...SUPPLEMENT_MODELS, ...extraModels()])].filter((id) => !seen.has(id))
  for (const id of await probeModels(ak, missing)) {
    const spec = specOf(id)
    models.push({ id, name: spec.name, context: spec.context, output: spec.output, image: !!spec.image })
  }
  catalogCache = { origin: base, models, at: Date.now() }
  return models
}

// 思考档位：AI SDK 的 openai-compatible 线把 reasoningEffort 映射成请求体的
// reasoning_effort。网关实测（qwen3.8-flash，2026-11）：low/medium/high 都被
// 接受且真的影响思考长度（reasoning tokens：low≈13、medium/high≈30），不带
// 该参数时走上游默认思考。对应 UI 的 快速/适中/极致 三档。
const REASONING_VARIANTS = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
}

function configModel(m) {
  const spec = specOf(m.id)
  const context = m.context ?? spec.context
  const output = m.output ?? spec.output
  const image = m.image ?? spec.image ?? false
  return {
    name: m.name ?? spec.name,
    limit: { context, output },
    tool_call: true,
    reasoning: true,
    attachment: image,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    variants: REASONING_VARIANTS,
  }
}

function configModels() {
  return Object.fromEntries(MODEL_SPECS.map((m) => [m.id, configModel(m)]))
}

function runtimeModel(provider, m) {
  const spec = specOf(m.id)
  const context = m.context ?? spec.context
  const output = m.output ?? spec.output
  const image = m.image ?? spec.image ?? false
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name ?? spec.name,
    api: { id: m.id, url: gatewayBase(), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: REASONING_VARIANTS,
  }
}

// ---- 登录 -------------------------------------------------------------------

/** 换到的 token → 账号记录（后续所有 result 都从这里派生）。 */
function authFromTokens(tokens, apiBase) {
  const access = tokens.access_token
  if (!access) throw new Error("OAuth 响应里没有 access_token")
  return {
    apiBase: apiBase.replace(/\/+$/, ""),
    access,
    refresh: tokens.refresh_token || "",
    expires: Date.now() + int(tokens.expires_in || 3600, 3600) * 1000,
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(tokens.openid ? { openid: tokens.openid } : {}),
  }
}

/** 账号记录 → 宿主 auth 成功结果。 */
function successOf(a) {
  return {
    type: "success",
    access: a.access,
    refresh: a.refresh,
    expires: a.expires,
    accountId: a.username || a.openid || ACCOUNT_FALLBACK,
    ...(a.username ? { username: a.username } : {}),
    ...(a.userId ? { userId: a.userId } : {}),
    ...(a.openid ? { openid: a.openid } : {}),
    ...(a.scope ? { scope: a.scope } : {}),
    apiBase: a.apiBase,
    projectUrlId: a.projectUrlId,
    serviceAk: a.serviceAk,
    serviceAkProjectId: a.serviceAkProjectId,
  }
}

/**
 * 换票后的完整链路：身份 → 项目 → 云服务 AK，产出宿主可直接保存的账号记录。
 *
 * `projectUrlId` 可显式指定（浏览器回调页里选的那一个）。没指定且账号下多个项目时，
 * 抛的错上带 `projects`（以及已解析的身份 `me`），由调用方决定是让用户选还是报错。
 */
async function buildSignedInAuth(tokens, apiBase, { projectUrlId } = {}) {
  const a = authFromTokens(tokens, apiBase)
  const me = await controlCall(apiBase, a.access, "GET", "/open/v1/cli-compat/account/identity")
  if (me?.name) a.username = me.name
  if (me?.user_id) a.userId = me.user_id
  a.projectUrlId = projectUrlId || me?.project_url_id || me?.projectUrlId || ""
  try {
    const { urlId, ak } = await resolveServiceAk({ client: null }, a, { projectUrlId: a.projectUrlId })
    a.projectUrlId = urlId
    a.serviceAk = ak
    a.serviceAkProjectId = urlId
  } catch (e) {
    // 多项目歧义要冒泡给调用方去问用户，顺带把身份带出去（选择页要显示用户名）
    if (e && typeof e === "object") e.me = me
    throw e
  }
  return successOf(a)
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

/**
 * 多项目选择页：授权已经完成，但 AK 挂在项目上（计费也归项目），不能替用户决定。
 * 直接在这一页点选项目或贴一个项目 id，选完由同一个 loopback 请求继续取 AK ——
 * 不用回 Magpie 重新走一遍登录（以前这里直接报错，回去重试还是同一条错）。
 */
function renderProjectPicker({ projects, username, token, error = "" }) {
  const rows = (Array.isArray(projects) ? projects : [])
    .map((p) => {
      const id = String(p?.url_id || p?.urlId || "")
      if (!id) return ""
      const name = String(p?.name || "未命名")
      return `<label class="row"><input type="radio" name="project" value="${escapeHtml(id)}"><span class="name">${escapeHtml(name)}</span><code>${escapeHtml(id)}</code></label>`
    })
    .join("")
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>选择 Meoo 项目</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 40px 20px; background: #f6f7f9; color: #1c1e21 }
 main { max-width: 760px; margin: 0 auto; background: #fff; border-radius: 14px; padding: 28px 32px; box-shadow: 0 1px 3px rgba(0,0,0,.08) }
 h1 { font-size: 20px; margin: 0 0 8px }
 p { margin: 0 0 16px; color: #4b4f56 }
 .warn { background: #fff4f2; border: 1px solid #ffd6cc; color: #a3321b; padding: 10px 12px; border-radius: 8px; margin-bottom: 16px }
 .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #e3e5e8; border-radius: 10px; margin-bottom: 8px; cursor: pointer }
 .row:hover { border-color: #b9c0c7; background: #fafbfc }
 .row input { margin: 0; flex: none }
 .row .name { font-weight: 600 }
 .row code { margin-left: auto; color: #6b7280; font-size: 12px }
 .custom { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap }
 .custom input { flex: 1 1 260px; padding: 9px 10px; border: 1px solid #d7dbe0; border-radius: 8px; font: inherit }
 button { padding: 10px 18px; border: 0; border-radius: 9px; background: #1c1e21; color: #fff; font: inherit; cursor: pointer }
 button:hover { opacity: .9 }
 .hint { margin-top: 18px; font-size: 13px; color: #6b7280 }
</style></head><body><main>
<h1>选择一个项目</h1>
<p>${escapeHtml(username || "该账号")} 下有 ${(Array.isArray(projects) ? projects : []).length} 个项目。项目服务 AK 挂在项目上、计费也归属项目，所以这一步得由你指定。</p>
${error ? `<div class="warn">${escapeHtml(error)}</div>` : ""}
<form method="POST" action="${CALLBACK_PATH}">
<input type="hidden" name="state" value="${escapeHtml(token)}">
${rows}
<div class="custom"><input name="custom" placeholder="或粘贴项目 id（如 proj-a1b2c3d4）" autocomplete="off" spellcheck="false"><button type="submit">用这个项目登录</button></div>
</form>
<p class="hint">项目 id 就是 meoo.com 项目地址里 <code>/p/&lt;id&gt;</code> 那一段。选完这个页面会完成登录，回到 Magpie 即已连上；换项目就重新登录一次再选。</p>
</main></body></html>`
}

/** 方式一：浏览器 PKCE 授权，本机 loopback 自动收回调；多项目时在回调页里选一次。 */
async function browserSignIn(timeoutMs = 10 * 60 * 1000) {
  const apiBase = mainOrigin()
  const clientId = clientIdFor(apiBase)
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(32).toString("base64url")

  let complete, timer, origin, received = false, settled = false
  let pending = null // 授权已完成、但等用户选项目：{ tokens, me, projects }
  const done = new Promise((resolve) => {
    complete = resolve
  })
  const finish = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    complete(result)
    server.close()
    server.closeIdleConnections?.()
  }
  // 等用户选项目时从那一刻重新计时，不占用「授权等待」剩下的秒数
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => finish({ type: "failed", error: pending ? "Meoo 登录超时（项目还没选），请重新登录" : "Meoo 登录超时，请重新登录" }),
      timeoutMs,
    )
    timer.unref?.()
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on("data", (c) => {
        size += c.length
        if (size > 32 * 1024) {
          req.destroy()
          resolve("")
          return
        }
        chunks.push(c)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", () => resolve(""))
    })
  const server = createServer(async (req, res) => {
    const reply = (status, text, html = false) => {
      res.writeHead(status, {
        "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": html ? "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" : "default-src 'none'",
      })
      res.end(text)
    }
    const picker = (error = "") =>
      reply(
        200,
        renderProjectPicker({ projects: pending?.projects, username: pending?.me?.name, token: state, error }),
        true,
      )
    const url = new URL(req.url || "/", "http://127.0.0.1")
    if (req.headers.host !== origin || url.pathname !== CALLBACK_PATH) return reply(404, "Not found")

    // 选项目：同一个 loopback 端口上收表单，接着把 AK 取完
    if (req.method === "POST") {
      const form = new URLSearchParams(await readBody(req))
      if (form.get("state") !== state) return reply(400, "这次选择不属于本次登录，请回到原授权页重试。")
      if (settled) return reply(409, "本次登录已经结束，请回到 Magpie 查看结果。")
      if (!pending) return reply(409, "本次登录没有待选的项目，请回到 Magpie 重新登录。")
      const wanted = String(form.get("custom") || "").trim() || String(form.get("project") || "").trim()
      if (!wanted) return picker("请先在列表里选一个项目，或填一个项目 id。")
      try {
        const success = await buildSignedInAuth(pending.tokens, pending.apiBase, { projectUrlId: wanted })
        if (settled) return reply(408, "登录已超时，请回到 Magpie 重新登录。")
        reply(200, `Meoo 登录成功，已用项目 ${wanted} 取得 AK，可以关闭这个页面回到 Magpie。`)
        finish(success)
      } catch (e) {
        // 项目没开通云服务 / 配额满了之类：留在选择页，换一个项目再试，不用重走登录
        return picker(`项目 ${wanted} 没能取到 AK：${e?.message ?? String(e)}`)
      }
      return
    }
    if (req.method !== "GET") return reply(405, "Method not allowed")

    const q = url.searchParams
    if (q.getAll("state").length !== 1 || q.get("state") !== state) return reply(400, "回调不属于本次登录，请回到原授权页重试。")
    // 已拿到 token 在等选项目：刷新这一页就重新给选择页，不当成重复回调
    if (pending && !settled) return picker("")
    if (settled || received) return reply(409, "本次回调已经处理，请回到 Magpie 查看结果。")
    if (q.get("error")) {
      reply(400, "登录未获授权，请回到 Magpie 重新登录。")
      finish({ type: "failed", error: `授权被取消：${q.get("error")}${q.get("error_description") ? " " + q.get("error_description") : ""}` })
      return
    }
    const code = q.get("code") || ""
    if (q.getAll("code").length !== 1 || !code || code.length > 4096) return reply(400, "回调缺少有效授权码，请回到原授权页重试。")
    received = true
    try {
      const tokens = await tokenRequest(apiBase, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: `http://${origin}${CALLBACK_PATH}`,
        code_verifier: verifier,
      })
      let success
      try {
        success = await buildSignedInAuth(tokens, apiBase)
      } catch (e) {
        // 纯多项目歧义：不是错误，是要用户补一步「选哪个项目」
        if (!e?.projects?.length) throw e
        pending = { tokens, apiBase, me: e.me ?? null, projects: e.projects }
        arm()
        return picker("")
      }
      if (settled) return reply(408, "登录已超时，请回到 Magpie 重新登录。")
      reply(200, "Meoo 登录成功，可以关闭这个页面回到 Magpie。")
      finish(success)
    } catch (e) {
      // 错误详情直接写进回调页：Magpie 卡片上的报错不一定被看到，浏览器这页一定看得到
      reply(502, `登录未完成：${e?.message ?? String(e)}\n\n请返回 Magpie 处理后重新登录。`)
      finish({ type: "failed", error: e?.message ?? String(e) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `127.0.0.1:${server.address().port}`
  const authorize = new URL("/oauth/authorize", apiBase)
  authorize.searchParams.set("client_id", clientId)
  authorize.searchParams.set("redirect_uri", `http://${origin}${CALLBACK_PATH}`)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("scope", OAUTH_SCOPE)
  authorize.searchParams.set("state", state)
  authorize.searchParams.set("code_challenge", challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  arm()
  // 优先用受控浏览器（插件自己的持久 profile）打开授权页：登录一次，OAuth 回调与
  // meoo.com 的网页会话（每日签到要用）都落进同一个 profile；打不开才回退成宿主
  // 打开系统浏览器——那种情况下 cookie 留在用户日常浏览器里，签到会用不了。
  const opener = await openBrowserWindow(authorize.toString())
  return {
    url: opener.ok ? "" : authorize.toString(),
    instructions: opener.ok
      ? "已在本机弹出受控浏览器窗口（插件自己的 profile，不是你的日常浏览器）：登录 Meoo 并点一次「授权」即可。这个窗口里的登录态会保留，插件的每日签到也用它。账号下有多个项目时，回调页会让你选一个。"
      : "在浏览器登录 Meoo 并点一次「授权」后会自动返回此处；身份与 AI 服务 AK 自动解析。账号下有多个项目时，回调页会列出项目让你选一个。",
    method: "auto",
    async callback() {
      try {
        return await done
      } finally {
        await opener.close()
      }
    },
  }
}

// ---- 本机已有登录态（只读复用，不写入任何文件）------------------------------

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh")
}

/**
 * dsh-meoo-connect（$DSH_HOME/meoo/state.json）与 meoo-proxy
 * （~/.meoo-proxy/config.json）保存的登录态，两处都读、dsh 优先、缺的互填。
 */
function readLegacyState(overrides = {}) {
  const dshFile = overrides.dshState || join(dshHome(), "meoo", "state.json")
  const proxyFile = overrides.proxyConfig || join(overrides.proxyHome || process.env.MEOO_PROXY_HOME || join(homedir(), ".meoo-proxy"), "config.json")
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch {
      return null
    }
  }
  const dsh = readJson(dshFile) || {}
  const proxy = readJson(proxyFile) || {}
  const merged = { ...proxy, ...Object.fromEntries(Object.entries(dsh).filter(([, v]) => v !== null && v !== undefined && v !== 0)) }
  if (!merged.refreshToken && !proxy.refreshToken && !merged.serviceAk && !proxy.serviceAk) return null
  return {
    apiBase: merged.apiBaseUrl || DEFAULT_API_BASE,
    accessToken: merged.accessToken || null,
    refreshToken: merged.refreshToken || proxy.refreshToken || null,
    expires: Number(merged.accessExpiresAt) || 0,
    scope: merged.scope || null,
    openid: merged.openid || null,
    username: merged.username || proxy.username || null,
    userId: merged.userId || proxy.userId || null,
    projectUrlId: merged.projectUrlId || proxy.projectUrlId || null,
    serviceAk: merged.serviceAk || proxy.serviceAk || null,
    serviceAkProjectId: merged.serviceAkProjectId || proxy.serviceAkProjectId || null,
  }
}

/** 方式三：复用本机 dsh-meoo-connect / meoo-proxy 的登录态（严格只读）。 */
function reuseSignIn() {
  return {
    url: "",
    instructions: "只读复用本机已有的 Meoo 登录态（dsh-meoo-connect 的 $DSH_HOME/meoo/state.json 或 meoo-proxy 的 ~/.meoo-proxy/config.json），不会写入这两个文件。",
    method: "auto",
    async callback() {
      const legacy = readLegacyState()
      if (!legacy || (!legacy.refreshToken && !legacy.serviceAk)) {
        return {
          type: "failed",
          error: "未找到本机 Meoo 登录态（已查找 $DSH_HOME/meoo/state.json 与 ~/.meoo-proxy/config.json）；请先用浏览器授权登录一次",
        }
      }
      try {
        const a = {
          apiBase: apiBaseOf(legacy),
          access: legacy.accessToken || "",
          refresh: legacy.refreshToken || "",
          expires: legacy.expires || 0,
          ...(legacy.scope ? { scope: legacy.scope } : {}),
          ...(legacy.openid ? { openid: legacy.openid } : {}),
          ...(legacy.username ? { username: legacy.username } : {}),
          ...(legacy.userId ? { userId: legacy.userId } : {}),
          projectUrlId: legacy.projectUrlId || "",
          serviceAk: legacy.serviceAk || "",
          serviceAkProjectId: legacy.serviceAkProjectId || "",
        }
        if (!a.serviceAk && !a.refresh) {
          return { type: "failed", error: "本机登录态既没有项目服务 AK 也没有 refresh token，无法复用；请用浏览器授权重新登录" }
        }
        if (a.refresh) {
          // 过期就续期（只动宿主自己的账号记录，不碰 dsh/meoo-proxy 的文件）
          const { a: fresh } = await currentAuth({ client: null }, a, isStale(a, 0))
          a.access = fresh.access || a.access
          a.expires = fresh.expires || a.expires
          a.refresh = fresh.refresh || a.refresh
        }
        if (!a.serviceAk) {
          const { urlId, ak } = await resolveServiceAk({ client: null }, a)
          a.projectUrlId = urlId
          a.serviceAk = ak
          a.serviceAkProjectId = urlId
        } else if (!a.projectUrlId) {
          a.projectUrlId = a.serviceAkProjectId
        }
        return {
          type: "success",
          access: a.access,
          refresh: a.refresh,
          expires: a.expires,
          accountId: a.username || a.openid || ACCOUNT_FALLBACK,
          ...(a.username ? { username: a.username } : {}),
          ...(a.openid ? { openid: a.openid } : {}),
          ...(a.scope ? { scope: a.scope } : {}),
          apiBase: a.apiBase,
          projectUrlId: a.projectUrlId,
          serviceAk: a.serviceAk,
          serviceAkProjectId: a.serviceAkProjectId,
        }
      } catch (e) {
        return { type: "failed", error: `复用本机登录态失败：${e?.message ?? String(e)}` }
      }
    },
  }
}

/** 方式四：手填项目服务 AK（meoo_project_service_v1.*，meoo.com 项目 → 云服务里复制）。 */
function manualKeySignIn() {
  return {
    url: "",
    instructions: "在 meoo.com 打开项目 → 云服务，复制项目服务 AK（meoo_project_service_v1. 开头）粘贴到下方；确认前会用网关 /models 校验一次。",
    method: "code",
    async callback(input) {
      try {
        const key = String(input ?? "").trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "")
        if (!key) throw new Error("请输入项目服务 AK")
        if (key.startsWith("meoo_ak_")) {
          throw new Error("这是用户 Key（meoo_ak_…），不是项目服务 AK；请填 meoo_project_service_v1. 开头的项目服务 AK")
        }
        const res = await fetch(`${gatewayBase()}/models`, {
          headers: { authorization: `Bearer ${key}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 401 || res.status === 403) {
          throw new Error(`AK 被网关拒绝（HTTP ${res.status}）：确认是项目服务 AK，且该项目已开通云服务`)
        }
        if (!res.ok) throw new Error(`网关校验失败 HTTP ${res.status}`)
        return { type: "success", key, accountId: "Meoo 项目服务 AK" }
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

// ---- 插件出口 ---------------------------------------------------------------

function persistOf(ctx) {
  return async (updated) => {
    try {
      await ctx?.client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: updated })
    } catch {}
  }
}

const PANEL_STATE_FILE = new URL("./panel/state.js", import.meta.url)
let panelPublisherStarted = false

/**
 * 登录态到期报告：面板和「概览」里的用量卡片共用，带缓存和等待上限。
 * - 宿主是 Bun 时读 bun:sqlite，毫秒级；没有 sqlite 才退回受控浏览器（慢）
 * - 卡片最多等 waitMs，超时先给旧值，绝不卡住概览
 */
let expiryCache = null
let expiryCacheAt = 0
let expiryInflight = null

async function expiryReport({ maxAgeMs = 5 * 60 * 1000, waitMs = 1500 } = {}) {
  if (process.env.MEOO_EXPIRY === "0") return null
  if (expiryCache && Date.now() - expiryCacheAt < maxAgeMs) return expiryCache
  if (!expiryInflight) {
    expiryInflight = (async () => {
      let report = await cookieExpiry()
      if (!report.ok && report.reason === "NO_SQLITE") {
        try {
          report = await cookieExpiryViaBrowser()
        } catch {}
      }
      expiryCache = report
      expiryCacheAt = Date.now()
      return report
    })().finally(() => {
      expiryInflight = null
    })
  }
  const pending = expiryInflight.catch(() => null)
  return await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(expiryCache), waitMs))])
}

/** 把「登录态还剩多久」写进面板目录：面板没有网络，只能读插件自己的文件。 */
async function publishPanelState() {
  if (process.env.MEOO_PANEL_STATE === "0") return
  try {
    const report = await expiryReport({ maxAgeMs: 0, waitMs: 5000 })
    if (!report) return
    const view = report.ok
      ? {
          ...report,
          atText: formatLocal(report.at),
          sessionExpiresText: formatLocal(report.sessionExpiresAt),
          sessionRemainText: report.sessionMsLeft == null ? "会话" : formatRemain(report.sessionMsLeft),
          cookies: report.cookies.map((c) => ({
            ...c,
            expiresText: formatLocal(c.expiresAt),
            remainText: c.msLeft == null ? "会话" : formatRemain(c.msLeft),
          })),
        }
      : { ...report, atText: formatLocal(report.at) }
    writeFileSync(fileURLToPath(PANEL_STATE_FILE), `globalThis.__MEOO_SESSION__ = ${JSON.stringify(view)}\n`)
  } catch {}
}

/** 宿主启动（或打开设置）时写一次，之后每 30 分钟刷新；不启动浏览器，开销可忽略。 */
function startPanelStatePublisher() {
  if (panelPublisherStarted) return
  panelPublisherStarted = true
  publishPanelState()
  const timer = setInterval(publishPanelState, 30 * 60 * 1000)
  timer.unref?.()
}

export const MeooAuthPlugin = async ({ client }) => {
  const ctx = { client }

  // 面板数据：面板跑在沙盒里（connect-src 'none'，没有网络），只能读插件自己的文件，
  // 所以由插件把「登录态还剩多久」写成 panel/state.js 递进去。
  // 读 Cookies 库取 expires_utc，不解密、不启动浏览器。
  startPanelStatePublisher()

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: gatewayBase(),
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        try {
          let ak = ""
          if (auth?.type === "api") ak = auth.key || ""
          else if (auth?.type === "oauth" && (auth.access || auth.refresh || auth.serviceAk)) {
            const { a } = await currentAuth(ctx, auth)
            ak = a.serviceAk || (await serviceAkOf(ctx, a))
          }
          if (!ak) return provider.models
          const ms = await fetchGatewayModels(ak)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,
      refreshLead: LEAD_MS,
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.refresh) return undefined
        const { a, didRenew } = await currentAuth(ctx, auth, true)
        if (!didRenew) return undefined
        return {
          access: a.access,
          refresh: a.refresh,
          expires: a.expires,
          ...(a.scope ? { scope: a.scope } : {}),
          ...(a.openid ? { openid: a.openid } : {}),
          ...(a.username ? { username: a.username } : {}),
          ...(a.serviceAk ? { serviceAk: a.serviceAk, serviceAkProjectId: a.serviceAkProjectId, projectUrlId: a.projectUrlId, apiBase: a.apiBase } : {}),
        }
      },
      // 每日签到：Meoo 的每日 2000 积分走网页端 /api/mc/entitlement/init，只认
      // meoo.com 的网页会话 cookie（cli.compat 的 token 打进去是 401 NEED_LOGIN）。
      // 用受控浏览器（登录时那个 profile）在页面里发请求；没登录过就返回 failed 并说明。
      async checkin() {
        const result = await checkinViaWeb()
        publishPanelState() // 签到会刷 cookie，顺手把面板数据更新掉
        return result
      },
      // 余额：Meoo 的积分账户（控制面 /account/points）。预付费钱包按 magpie 的
      // balance 窗口显示——这种窗口不写 used/limit，卡片显示数字而不是百分比条；
      // 再补一条「已用」和最近一批到期日，免得只看得到余额看不到花在哪。
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) throw new Error("还没有连接 Meoo")
        if (auth.type === "api") {
          throw new Error("手填的项目服务 AK 读不到积分账户；要用余额卡，请用浏览器授权登录一次")
        }
        if (auth.type !== "oauth") throw new Error("登录态类型未知，无法读取积分")
        const { a } = await currentAuth(ctx, auth)
        const data = await controlRequest(ctx, a, "GET", "/open/v1/cli-compat/account/points")
        const acc = data?.account || {}
        const left = int(acc.availableBalance)
        const used = int(acc.totalConsumed)
        const frozen = int(acc.frozenBalance)
        const fmt = (n) => new Intl.NumberFormat("en-US").format(n)
        // 钱包窗口：新版 magpie 认 window.balance（不画百分比条、只显示数字）；
        // 旧版会把它当纯文本窗口，所以同时给 display —— 两种宿主都能看到余额。
        const wallet = { name: "积分", balance: left, unit: "积分", display: `${fmt(left)} 积分` }
        const lapse = soonestLapse(data?.activeGrants)
        if (lapse) wallet.runsOutAt = lapse
        const windows = [wallet]
        if (used > 0) windows.push({ name: "已用", display: `${fmt(used)} 积分`, aside: true })
        if (frozen > 0) windows.push({ name: "冻结", display: `${fmt(frozen)} 积分`, aside: true })
        // 概览卡片上的登录态：受控浏览器里 6 个鉴权 cookie 还剩多久。
        // 读 Cookies 库取 expires_utc（不解密、通常不起浏览器），最多等 1.5 秒。
        const expiry = await expiryReport()
        if (expiry?.ok) {
          const expired = expiry.sessionMsLeft != null && expiry.sessionMsLeft <= 0
          const head = expired ? "已过期" : `还剩 ${formatRemain(expiry.sessionMsLeft)}`
          const tail = expiry.missing?.length
            ? `缺 ${expiry.missing.join("/")}`
            : `${formatLocal(expiry.sessionExpiresAt)} 到期`
          windows.push({ name: "登录态", display: `${head}（${tail}）`, aside: true })
        }
        return { user: a.username || "", balance: `${fmt(left)} 积分`, windows }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type === "api") return auth.key ? { baseURL: gatewayBase(), apiKey: auth.key } : {}
        if (auth?.type !== "oauth") return {}
        try {
          const { a } = await currentAuth(ctx, auth)
          const ak = a.serviceAk || (await serviceAkOf(ctx, a))
          if (!ak) return {}
          return { baseURL: gatewayBase(), apiKey: ak }
        } catch (e) {
          const expired = e?.signIn === "expired"
          return {
            baseURL: gatewayBase(),
            apiKey: "meoo",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: e?.message ?? String(e), type: expired ? "authentication_error" : "api_error" } }),
                {
                  status: expired ? 401 : 502,
                  headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": expired ? "expired" : "kept" },
                },
              )
            },
          }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Meoo 账号（浏览器授权，自动取项目 AK）",
          authorize: async () => browserSignIn(),
        },
        {
          type: "oauth",
          label: "复用本机登录态（dsh-meoo-connect / meoo-proxy）",
          authorize: async () => reuseSignIn(),
        },
        {
          type: "api",
          label: "项目服务 AK（meoo_project_service_v1.…）",
          placeholder: "meoo_project_service_v1.…",
          authorize: async () => manualKeySignIn(),
        },
      ],
    },
  }
}

export const _internal = {
  tokenRequest,
  renewToken,
  currentAuth,
  isStale,
  controlCall,
  controlRequest,
  fetchIdentity,
  listProjects,
  createProject,
  pickProject,
  resolveServiceAk,
  serviceAkOf,
  parseGatewayModels,
  fetchGatewayModels,
  resetCatalogCache,
  configModels,
  runtimeModel,
  buildSignedInAuth,
  browserSignIn,
  reuseSignIn,
  manualKeySignIn,
  readLegacyState,
  clientIdFor,
  apiBaseOf,
  gatewayBase,
}
