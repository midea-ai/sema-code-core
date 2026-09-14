// 站点访问控制：黑名单优先拦下；"首次访问询问"开关默认关，全部放行；
// 开关打开时按域名记录授权，第一次访问弹窗让用户选"仅本次 / 总是允许 / 拒绝"。弹窗里可撤销。
import { AUTH_TIMEOUT_MS, ErrorCode, RpcError, abortable, stoppedError } from './protocol.js'

const LOCAL_KEY = 'siteAuth' // { host: 'always' }，持久
const SESSION_KEY = 'siteAuthSession' // { host: 'once' }，浏览器关闭即失效
const ASK_KEY = 'siteAsk' // boolean，是否首次访问弹窗询问，默认 false
const BLOCK_KEY = 'siteBlock' // string[]，禁止访问的域名，含其子域
const DENY_TTL_MS = 5 * 60_000

const denied = new Map() // host -> 拒绝到期时间，避免模型重试时反复弹窗
const pending = new Map() // host -> { id, promise, resolve, windowId, timer, done }

const INTERNAL_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
])

export function hostOf(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Invalid URL: ${url || '(empty)'}`)
  }
  if (INTERNAL_SCHEMES.has(u.protocol)) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Browser-internal page cannot be accessed: ${url}`)
  }
  if (u.protocol === 'file:') return 'file://'
  return u.hostname.toLowerCase()
}

// 域名相等或是黑名单项的子域即命中
export async function isBlocked(host) {
  const list = await readBlockList()
  return list.some((b) => host === b || host.endsWith(`.${b}`))
}

export async function isAskEnabled() {
  return (await chrome.storage.local.get(ASK_KEY))[ASK_KEY] === true
}

// 只查存储，不弹窗。导航后重注脚本时用它判断能不能碰新页面
export async function isAuthorized(host) {
  if (await isBlocked(host)) return false
  if (!(await isAskEnabled())) return true
  if ((await read(chrome.storage.local, LOCAL_KEY))[host] === 'always') return true
  return (await read(chrome.storage.session, SESSION_KEY))[host] === 'once'
}

// signal：等用户选择期间被"立即停止"就关掉授权窗口，以 user_stopped 失败，不缓存为拒绝
export async function ensureAuthorized(host, signal) {
  if (await isBlocked(host)) throw blocked(host)
  if (await isAuthorized(host)) return
  const until = denied.get(host)
  if (until && until > Date.now()) throw notAuthorized(host)
  denied.delete(host)

  let decision
  try {
    decision = await abortable(ask(host), signal)
  } catch (e) {
    if (e instanceof RpcError && e.code === ErrorCode.USER_STOPPED) cancelAsk(host)
    throw e
  }
  if (decision === 'always') await remember(chrome.storage.local, LOCAL_KEY, host, 'always')
  else if (decision === 'once') await remember(chrome.storage.session, SESSION_KEY, host, 'once')
  else if (decision === 'cancel') throw stoppedError()
  else {
    denied.set(host, Date.now() + DENY_TTL_MS)
    throw notAuthorized(host)
  }
}

// 弹窗用：开关状态、黑名单、已授权的域名（分持久与仅本次）
export async function listAuthorizations() {
  const always = Object.keys(await read(chrome.storage.local, LOCAL_KEY)).sort()
  const once = Object.keys(await read(chrome.storage.session, SESSION_KEY)).sort()
  return { ask: await isAskEnabled(), block: await readBlockList(), always, once }
}

export async function setAskEnabled(on) {
  await chrome.storage.local.set({ [ASK_KEY]: on === true })
}

// 输入允许带协议、路径或大小写，统一归一成域名；空或非法则忽略
export async function blockHost(input) {
  const host = normalizeHost(input)
  if (!host) return
  const list = await readBlockList()
  if (list.includes(host)) return
  list.push(host)
  list.sort()
  await chrome.storage.local.set({ [BLOCK_KEY]: list })
}

export async function unblockHost(host) {
  const list = (await readBlockList()).filter((h) => h !== host)
  await chrome.storage.local.set({ [BLOCK_KEY]: list })
}

function normalizeHost(input) {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return ''
  if (s === 'file://' || s.startsWith('file:')) return 'file://'
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname
  } catch {
    return ''
  }
}

async function readBlockList() {
  const list = (await chrome.storage.local.get(BLOCK_KEY))[BLOCK_KEY]
  return Array.isArray(list) ? list : []
}

// 撤销后下一次访问该域名重新弹窗
export async function revokeAuthorization(host) {
  await forget(chrome.storage.local, LOCAL_KEY, host)
  await forget(chrome.storage.session, SESSION_KEY, host)
  denied.delete(host)
}

function cancelAsk(host) {
  const entry = pending.get(host)
  if (entry) settle(host, entry.id, 'cancel')
}

// 授权页点了按钮
export function handleAuthorizeReply({ host, id, decision }) {
  settle(host, id, decision)
}

// 用户直接关掉了授权窗口
export function handleWindowRemoved(windowId) {
  for (const [host, entry] of pending) {
    if (entry.windowId === windowId) settle(host, entry.id, 'deny')
  }
}

function ask(host) {
  const existing = pending.get(host)
  if (existing) return existing.promise

  const entry = { id: crypto.randomUUID(), done: false }
  entry.promise = new Promise((resolve) => {
    entry.resolve = resolve
  })
  pending.set(host, entry)

  const query = `host=${encodeURIComponent(host)}&id=${entry.id}&timeout=${AUTH_TIMEOUT_MS}`
  chrome.windows
    .create({
      url: chrome.runtime.getURL(`authorize.html?${query}`),
      type: 'popup',
      width: 460,
      height: 320,
      focused: true,
    })
    .then((win) => {
      entry.windowId = win.id
      if (entry.done) closeWindow(win.id)
    })
    .catch(() => settle(host, entry.id, 'deny'))
  entry.timer = setTimeout(() => settle(host, entry.id, 'deny'), AUTH_TIMEOUT_MS)
  return entry.promise
}

function settle(host, id, decision) {
  const entry = pending.get(host)
  if (!entry || entry.id !== id) return
  pending.delete(host)
  entry.done = true
  clearTimeout(entry.timer)
  if (entry.windowId !== undefined) closeWindow(entry.windowId)
  entry.resolve(decision === 'always' || decision === 'once' || decision === 'cancel' ? decision : 'deny')
}

function closeWindow(windowId) {
  chrome.windows.remove(windowId).catch(() => {})
}

function notAuthorized(host) {
  return new RpcError(
    ErrorCode.SITE_NOT_AUTHORIZED,
    `Site "${host}" is not authorized. Ask the user to allow it in the Sema extension prompt, then retry.`,
    { host, reason: 'not_authorized' },
  )
}

function blocked(host) {
  return new RpcError(
    ErrorCode.SITE_NOT_AUTHORIZED,
    `Site "${host}" is blocked by the user in the Sema extension settings. Do not retry; tell the user.`,
    { host, reason: 'blocked' },
  )
}

async function read(area, key) {
  return (await area.get(key))[key] || {}
}

async function remember(area, key, host, value) {
  const map = await read(area, key)
  map[host] = value
  await area.set({ [key]: map })
}

async function forget(area, key, host) {
  const map = await read(area, key)
  if (!(host in map)) return
  delete map[host]
  await area.set({ [key]: map })
}
