// 控制台与网络记录的环形缓冲。按标签页存在后台内存里，每类最多 CAPTURE_MAX_ENTRIES 条。
// 只保留当前域名：跨域导航或记录来自别的域名时清空；同源导航保留，在控制台里插一条 nav 标记行。
// 后台 worker 与原生端口同生命周期，worker 重启缓冲即空。
import { CAPTURE_MAX_ENTRIES } from './protocol.js'
import { hostOf } from './auth.js'

const buffers = new Map() // tabId -> { host, console: [], network: [], coverage, since }

function bufferFor(tabId, host) {
  let b = buffers.get(tabId)
  if (!b || b.host !== host) {
    b = { host, console: [], network: [], coverage: null, since: null }
    buffers.set(tabId, b)
  }
  return b
}

function push(list, entry) {
  list.push(entry)
  if (list.length > CAPTURE_MAX_ENTRIES) list.splice(0, list.length - CAPTURE_MAX_ENTRIES)
}

// 内容脚本转发来的一批记录。kind 为 console、network 或 meta（钩子刚装上，带页面阶段）
export function recordEntries(tabId, url, entries) {
  if (!Array.isArray(entries)) return
  let host
  try {
    host = hostOf(url)
  } catch {
    return
  }
  const b = bufferFor(tabId, host)
  for (const item of entries) {
    if (!item || typeof item !== 'object' || !item.entry) continue
    const { kind, entry } = item
    if (kind === 'meta') {
      // loading 表示钩子在页面脚本前装上，加载期的报错与请求都能捕获；否则加载期的已经错过
      b.coverage = entry.ready_state === 'loading' ? 'load' : 'partial'
      if (!b.since) b.since = entry.ts
      push(b.console, {
        ts: entry.ts,
        level: 'nav',
        text: `navigated to ${entry.url} (capture ${b.coverage === 'load' ? 'covers page load' : 'started after the page loaded'})`,
      })
    } else if (kind === 'console') push(b.console, entry)
    else if (kind === 'network') push(b.network, entry)
  }
}

// 主框架导航提交：换了域名就清空
export function clearOnCommit(tabId, url) {
  const b = buffers.get(tabId)
  if (!b) return
  let host
  try {
    host = hostOf(url)
  } catch {
    buffers.delete(tabId)
    return
  }
  if (host !== b.host) buffers.delete(tabId)
}

export function forgetTab(tabId) {
  buffers.delete(tabId)
}

// 读控制台。re 是已编译的正则或 null；onlyErrors 只留 error 级（nav 标记行一律保留）；limit 取最新的；clear 读完清空
export function readConsole(tabId, { re, onlyErrors, limit, clear }) {
  const b = buffers.get(tabId)
  const all = b ? b.console : []
  const matched = all.filter((e) => {
    if (e.level === 'nav') return true
    if (onlyErrors && e.level !== 'error') return false
    return !re || re.test(e.text)
  })
  const entries = matched.slice(Math.max(0, matched.length - limit))
  if (clear && b) b.console = []
  const count = (list) => list.filter((e) => e.level !== 'nav').length
  return { coverage: b ? b.coverage : null, since: b ? b.since : null, stored: count(all), matched: count(matched), entries }
}

export function readNetwork(tabId, { re, limit, clear }) {
  const b = buffers.get(tabId)
  const all = b ? b.network : []
  const matched = re ? all.filter((e) => re.test(e.url)) : all
  const entries = matched.slice(Math.max(0, matched.length - limit))
  if (clear && b) b.network = []
  return { coverage: b ? b.coverage : null, since: b ? b.since : null, stored: all.length, matched: matched.length, entries }
}
