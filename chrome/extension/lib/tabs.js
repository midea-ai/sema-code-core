// 标签页归属、Sema 标签组、加载等待与动作回执。
import { ErrorCode, GROUP_TITLE, LOAD_TIMEOUT_MS, RpcError } from './protocol.js'

const AGENT_TABS_KEY = 'agentTabs' // number[]，存 session，后台被回收后仍在

export async function agentTabIds() {
  const r = await chrome.storage.session.get(AGENT_TABS_KEY)
  return new Set(r[AGENT_TABS_KEY] || [])
}

export async function isAgentTab(tabId) {
  return (await agentTabIds()).has(tabId)
}

export async function markAgentTab(tabId) {
  const ids = await agentTabIds()
  ids.add(tabId)
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: [...ids] })
}

export async function unmarkAgentTab(tabId) {
  const ids = await agentTabIds()
  if (ids.delete(tabId)) await chrome.storage.session.set({ [AGENT_TABS_KEY]: [...ids] })
}

export async function requireTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'tab_id must be an integer; call tabs_list to get one')
  }
  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    throw new RpcError(ErrorCode.TAB_NOT_FOUND, `Tab ${tabId} does not exist; call tabs_list to refresh`)
  }
  if (tab.incognito) {
    throw new RpcError(
      ErrorCode.SITE_NOT_AUTHORIZED,
      `Tab ${tabId} is in an incognito window; incognito windows are never controlled`,
    )
  }
  return tab
}

// 选一个非隐身的普通窗口放 Agent 的标签，优先当前聚焦的
export async function pickWindow() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] })
  const normal = wins.filter((w) => !w.incognito)
  return normal.find((w) => w.focused) || normal[0] || null
}

export async function addToSemaGroup(tab) {
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE })
  if (groups.length) {
    await chrome.tabs.group({ tabIds: tab.id, groupId: groups[0].id })
    return
  }
  const groupId = await chrome.tabs.group({ tabIds: tab.id })
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' })
}

// 等标签页加载完成。resolve 为 { ok, sawLoading }，超时 ok 为 false；返回值带 cancel()。
export function waitForLoad(tabId, { loading = false, timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  let finish
  const promise = new Promise((resolve) => {
    let sawLoading = loading
    const onUpdated = (id, info) => {
      if (id !== tabId) return
      if (info.status === 'loading') sawLoading = true
      else if (info.status === 'complete' && sawLoading) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    // 1 秒兜底：同文档导航或 bfcache 回退可能不发 loading，快页面的 complete 也可能在挂监听前就发过了，
    // 都按标签当前状态判断
    const grace = setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (!tab) finish(false)
      else if (tab.status === 'complete') finish(true)
      else sawLoading = true
    }, 1000)
    finish = (ok) => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      clearTimeout(timer)
      clearTimeout(grace)
      resolve({ ok, sawLoading })
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
  promise.cancel = () => finish(false)
  return promise
}

// 动作类工具统一回执。dialog 是页面世界脚本接管的原生对话框记录 {type, message, count}，没有为 null。
export async function receipt(tabId, navigated, dialog = null) {
  const tab = await chrome.tabs.get(tabId)
  return { tab_id: tab.id, title: tab.title || '', url: tab.url || '', navigated, dialog: dialog || null }
}
