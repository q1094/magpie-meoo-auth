// 面板渲染：数据由插件主进程写在同目录的 state.js 里。
// 面板跑在 sandbox 里（connect-src 'none'），没有网络，只能读插件自己的文件。
// 注意这是经典脚本（<script src>），不能写顶层 await，包一层 async IIFE。
void (async () => {
  await magpie.ready

  const root = document.getElementById("root")
  const data = globalThis.__MEOO_SESSION__

  const el = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  const only = (text) => {
    root.replaceChildren(el("p", "muted", text))
  }

  if (!data) {
    only("还没有数据：在 magpie 里登录一次 Meoo，再打开这里就能看到登录态还剩多少天。")
    return
  }

  if (!data.ok) {
    const reasons = {
      NO_PROFILE: "还没有用受控浏览器登录过 Meoo；登录一次就会生成 profile，这里随之出现有效期。",
      NO_COOKIES_DB: "受控浏览器的 profile 里没有 Cookies 库（可能被清理过），重新登录一次即可。",
      NO_SQLITE: "宿主运行时读不了 Cookies 库（需要 bun:sqlite 或 node:sqlite）。登录态本身不受影响。",
    }
    only(reasons[data.reason] || `读取失败：${data.reason}`)
    return
  }

  const head = el("div", "head")
  head.append(
    el("div", `big${data.sessionMsLeft != null && data.sessionMsLeft < 3 * 86400000 ? " warn" : ""}`, data.sessionRemainText || "会话"),
    el("div", "sub", `到 ${data.sessionExpiresText} · 采集于 ${data.atText}`),
  )
  root.replaceChildren(head)

  const table = el("table")
  const thead = el("thead")
  const headRow = el("tr")
  for (const label of ["cookie", "到期", "剩余"]) headRow.append(el("th", null, label))
  thead.append(headRow)

  const tbody = el("tbody")
  for (const c of data.cookies || []) {
    const row = el("tr", c.msLeft != null && c.msLeft <= 0 ? "expired" : null)
    row.append(el("td", "name", c.name), el("td", null, c.expiresText), el("td", "num", c.remainText))
    tbody.append(row)
  }
  table.append(thead, tbody)
  root.append(table)

  if (data.missing?.length) {
    root.append(el("p", "hint", `缺少 ${data.missing.join("、")}，登录态可能已经失效。`))
  }
  root.append(el("p", "hint", "只统计参与鉴权的 6 个 cookie；每天打开一次 meoo.com 会顺延上面的到期时间。"))
})()
