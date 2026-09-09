// Sema 浏览器控制：扩展后台（MV3 service worker）。
// 连原生宿主，收到 {v, id, method, params} 就分发到 methods，回 {v, id, result|error}。
// 弹窗经 runtime 消息问状态、撤销授权、立即停止与允许继续。
import { ErrorCode, RpcError } from './lib/protocol.js'
import { NativeLink } from './lib/native.js'
import { methods } from './lib/methods.js'
import { handleAuthorizeReply, handleWindowRemoved, listAuthorizations, revokeAuthorization } from './lib/auth.js'
import { agentTabIds, unmarkAgentTab } from './lib/tabs.js'
import { cleanupEarlyHooks, reinjectOnCommit, unmarkControlled } from './lib/inject.js'
import { clearOnCommit, forgetTab, recordEntries } from './lib/capture.js'

async function dispatch(msg, signal) {
  const name = typeof msg.method === 'string' ? msg.method : ''
  const fn = Object.prototype.hasOwnProperty.call(methods, name) ? methods[name] : null
  if (!fn) {
    const version = chrome.runtime.getManifest().version
    return {
      error: {
        code: ErrorCode.UNSUPPORTED,
        message: `Method "${name}" is not supported by Sema extension ${version}; update the extension`,
      },
    }
  }
  try {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    return { result: await fn(params, { signal }) }
  } catch (e) {
    if (e instanceof RpcError) return { error: e.toJSON() }
    console.error('[sema]', name, e)
    return { error: { code: ErrorCode.INTERNAL, message: String(e?.message || e) } }
  }
}

const link = new NativeLink(dispatch)
link.restore().finally(() => link.connect())
// 上次导航前临时注册的 document_start 脚本若没来得及注销，这里清掉
cleanupEarlyHooks()
chrome.runtime.onStartup.addListener(() => link.connect())
chrome.runtime.onInstalled.addListener(() => link.connect())

// 弹窗的请求
async function handlePopup(msg) {
  switch (msg.op) {
    case 'stop':
      await link.stop()
      break
    case 'resume':
      await link.resume()
      break
    case 'revoke':
      if (typeof msg.host === 'string' && msg.host) await revokeAuthorization(msg.host)
      break
    default:
      break
  }
  const [auth, agent] = await Promise.all([listAuthorizations(), agentTabIds()])
  return { ...link.status(), auth, agent_tabs: agent.size, version: chrome.runtime.getManifest().version }
}

// 授权页与弹窗的消息只认扩展自己的页面
const ownOrigin = chrome.runtime.getURL('')
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const own = (sender.url || '').startsWith(ownOrigin)
  if (msg?.type === 'sema:authorize' && own) handleAuthorizeReply(msg)
  else if (msg?.type === 'sema:popup' && own) {
    handlePopup(msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }))
    return true
  }
  // 内容脚本转发的控制台与网络记录，只认主框架
  else if (msg?.type === 'sema:log' && sender.tab?.id !== undefined && sender.frameId === 0) {
    recordEntries(sender.tab.id, sender.url || '', msg.entries)
  }
  return undefined
})
chrome.windows.onRemoved.addListener(handleWindowRemoved)
chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkAgentTab(tabId)
  unmarkControlled(tabId)
  forgetTab(tabId)
})
// 受控标签的主框架导航一提交就重注脚本，新页面的对话框、控制台和元素树都接得上；跨域时清空记录
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return
  clearOnCommit(d.tabId, d.url)
  reinjectOnCommit(d.tabId, d.url)
})
