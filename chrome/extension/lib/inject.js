// 内容脚本与页面世界脚本的注入。
// 内容脚本 content.js（隔离世界）负责读树与执行动作；页面世界脚本 page.js 接管对话框、常驻钩住控制台与网络，
// 记录以 sema:log 事件交内容脚本转发后台。注入过的标签记为"受控"，之后每次主框架导航提交都立即重注。
// Agent 自己发起的导航（tabs_open、navigate）另在导航前按目标 URL 临时注册 document_start 的 page.js，
// 钩子保证赶在页面脚本前：提交时再注入对本地快页面来说已经晚了，内联脚本先跑完了。
import { ErrorCode, LOAD_ARM_MS, RpcError } from './protocol.js'
import { hostOf, isAuthorized } from './auth.js'

const CONTROLLED_KEY = 'controlledTabs' // number[]，存 session，后台被回收后仍在
const EARLY_PREFIX = 'sema-early-'
let earlySeq = 0

export async function controlledTabIds() {
  const r = await chrome.storage.session.get(CONTROLLED_KEY)
  return new Set(r[CONTROLLED_KEY] || [])
}

export async function isControlled(tabId) {
  return (await controlledTabIds()).has(tabId)
}

// Agent 自己开的标签在 tabs_open 时就标为受控，首次加载的对话框与控制台报错才接得住
export async function markControlled(tabId) {
  const ids = await controlledTabIds()
  if (ids.has(tabId)) return
  ids.add(tabId)
  await chrome.storage.session.set({ [CONTROLLED_KEY]: [...ids] })
}

export async function unmarkControlled(tabId) {
  const ids = await controlledTabIds()
  if (ids.delete(tabId)) await chrome.storage.session.set({ [CONTROLLED_KEY]: [...ids] })
}

// 按需注入：先 ping，没人应答再注入。导航后旧脚本随页面消失，onCommitted 没赶上的话这里兜底。
// 返回是否刚注入了脚本，调用方据此决定要不要等钩子的首条记录送达。
export async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'sema', op: 'ping', params: {} })
    if (r?.ok) return false
  } catch {
    // 没有接收端，走注入
  }
  try {
    await inject(tabId, 0)
  } catch (e) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Cannot access the page in tab ${tabId}: ${e.message}`)
  }
  return true
}

// 主框架导航提交：受控且域名已授权（不弹窗）就立即重注，接管加载期间的对话框，控制台钩子也尽早装上
export async function reinjectOnCommit(tabId, url) {
  if (!(await isControlled(tabId))) return
  let host
  try {
    host = hostOf(url)
  } catch {
    return
  }
  if (!(await isAuthorized(host))) return
  try {
    await inject(tabId, LOAD_ARM_MS)
  } catch (e) {
    console.warn('[sema] reinject failed', tabId, e.message)
  }
}

// 先注内容脚本再注页面世界脚本（同一文档只装一次，早注册的已在则跳过），再按需武装对话框接管
async function inject(tabId, armMs) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], injectImmediately: true })
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page.js'], injectImmediately: true })
  if (armMs > 0) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      injectImmediately: true,
      func: (ms) => {
        if (window.__semaPage) window.__semaPage.arm({ ms })
      },
      args: [armMs],
    })
  }
  await markControlled(tabId)
}

// Agent 自己发起的导航：先对目标 URL 注册 document_start 的 page.js，跑完导航与等待再注销。
// 只匹配这一个 URL，存活不过一次加载；这段时间用户自己恰好打开同一 URL 也会装上钩子，但没有内容脚本，记录攒 300 条即止。
export async function withEarlyHook(url, run) {
  const pattern = matchPatternFor(url)
  if (!pattern) return run()
  const id = `${EARLY_PREFIX}${Date.now().toString(36)}-${++earlySeq}`
  try {
    await chrome.scripting.registerContentScripts([
      { id, js: ['page.js'], matches: [pattern], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: false },
    ])
  } catch (e) {
    console.warn('[sema] early hook registration failed', pattern, e.message)
    return run()
  }
  try {
    return await run()
  } finally {
    chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {})
  }
}

// 后台启动时清掉上次没来得及注销的临时注册
export async function cleanupEarlyHooks() {
  const all = await chrome.scripting.getRegisteredContentScripts().catch(() => [])
  const ids = all.filter((s) => s.id.startsWith(EARLY_PREFIX)).map((s) => s.id)
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids }).catch(() => {})
}

// 精确到路径与查询串的匹配模式；片段去掉。路径里的 * 会被当通配符，多匹配也无害
function matchPatternFor(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'file:') return `file://${u.pathname}`
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return `${u.protocol}//${u.host}${u.pathname}${u.search}`
}
