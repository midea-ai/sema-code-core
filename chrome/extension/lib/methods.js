// 方法实现：ping、hello、tabs_list、tabs_open、tabs_close、navigate、read_page、get_text、click、fill、press、scroll，
// 排障用的 console、network、screenshot、eval_js，以及文件上传的 upload_begin、upload_chunk、upload_commit。
// 每个方法收 (params, ctx)，ctx.signal 在用户点"立即停止"时触发：等待中的立刻失败，还没派发的动作不再派发。
import {
  CAPTURE_SETTLE_MS,
  CONTENT_TIMEOUT_MS,
  ErrorCode,
  EVAL_MAX_CHARS,
  NAV_SETTLE_MS,
  PROTOCOL_VERSION,
  RpcError,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_SCREENS,
  SCREENSHOT_SETTLE_MS,
  abortable,
  throwIfAborted,
} from './protocol.js'
import { ensureAuthorized, hostOf } from './auth.js'
import { ensureContentScript, isControlled, markControlled, withEarlyHook } from './inject.js'
import { readConsole, readNetwork } from './capture.js'
import { addChunk, beginUpload, takeUpload } from './upload.js'
import {
  addToSemaGroup,
  agentTabIds,
  isAgentTab,
  markAgentTab,
  pickWindow,
  receipt,
  requireTab,
  unmarkAgentTab,
  waitForLoad,
} from './tabs.js'

const NAV_COMMANDS = new Set(['back', 'forward', 'reload'])
const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right'])
const READ_PAGE_MAX_CHARS = { min: 1000, max: 200_000, def: 20_000 }
const LOG_LIMIT = { min: 1, max: 1000, def: 100 }
// 截前先激活标签，等一帧让页面画出来
const ACTIVATE_SETTLE_MS = 150

export const methods = {
  async ping() {
    return { protocol: PROTOCOL_VERSION, extension_version: chrome.runtime.getManifest().version }
  },

  // 桥接进程连上套接字后先发一次。复位"立即停止"的动作在连接层做，这里只回版本
  async hello() {
    return { protocol: PROTOCOL_VERSION, extension_version: chrome.runtime.getManifest().version }
  },

  async tabs_list() {
    const [tabs, agent] = await Promise.all([chrome.tabs.query({}), agentTabIds()])
    const own = chrome.runtime.getURL('')
    return tabs
      .filter((t) => t.id !== undefined && !t.incognito && !(t.url || '').startsWith(own))
      .map((t) => ({ tab_id: t.id, title: t.title || '', url: t.url || '', agent: agent.has(t.id) }))
  },

  async tabs_open({ url } = {}, { signal } = {}) {
    const target = url ? normalizeUrl(url) : 'about:blank'
    if (url) await ensureAuthorized(hostOf(target), signal)
    throwIfAborted(signal)

    const win = await pickWindow()
    // 带 url 时先对目标 URL 注册 document_start 钩子，首次加载的报错与请求就能捕获
    return withEarlyHook(url ? target : null, async () => {
      const tab = win
        ? await chrome.tabs.create({ windowId: win.id, url: target, active: true })
        : (await chrome.windows.create({ url: target, focused: true })).tabs[0]
      await markAgentTab(tab.id)
      // 自己开的标签从一开始就受控：导航提交即注脚本，加载期的对话框才接得住
      if (url) await markControlled(tab.id)
      await addToSemaGroup(tab)

      let ok = true
      if (url) ok = (await awaitLoad(waitForLoad(tab.id, { loading: tab.status === 'loading' }), signal)).ok
      const r = await receipt(tab.id, Boolean(url))
      if (!ok) throw new RpcError(ErrorCode.TIMEOUT, `Page did not finish loading within 30s: ${target}`, r)
      return r
    })
  },

  async tabs_close({ tab_id } = {}) {
    const tab = await requireTab(tab_id)
    if (!(await isAgentTab(tab.id))) {
      throw new RpcError(
        ErrorCode.TAB_NOT_OWNED,
        `Tab ${tab.id} was opened by the user; only tabs opened by the agent can be closed`,
      )
    }
    await chrome.tabs.remove(tab.id)
    await unmarkAgentTab(tab.id)
    return { tab_id: tab.id, closed: true }
  },

  async navigate({ tab_id, url } = {}, { signal } = {}) {
    const tab = await requireTab(tab_id)
    const cmd = typeof url === 'string' ? url.trim().toLowerCase() : ''
    let target
    if (NAV_COMMANDS.has(cmd)) {
      await ensureAuthorized(hostOf(tab.url), signal)
    } else {
      target = normalizeUrl(url)
      await ensureAuthorized(hostOf(target), signal)
    }
    throwIfAborted(signal)

    // 目标 URL 已知（地址或 reload）时先注册 document_start 钩子；back、forward 不知道去哪，只靠提交时重注
    const early = cmd === 'reload' ? tab.url : NAV_COMMANDS.has(cmd) ? null : target
    return withEarlyHook(early, async () => {
      const loaded = awaitLoad(waitForLoad(tab.id), signal)
      try {
        if (cmd === 'back') await chrome.tabs.goBack(tab.id)
        else if (cmd === 'forward') await chrome.tabs.goForward(tab.id)
        else if (cmd === 'reload') await chrome.tabs.reload(tab.id)
        else await chrome.tabs.update(tab.id, { url: target })
      } catch (e) {
        loaded.cancel()
        throw new RpcError(ErrorCode.BAD_REQUEST, `Cannot navigate: ${e.message}`)
      }
      const { ok, sawLoading } = await loaded
      const navigated = cmd === 'reload' || sawLoading || urlChanged(tab.url, target)
      if (!ok) {
        throw new RpcError(
          ErrorCode.TIMEOUT,
          'Page did not finish loading within 30s (the navigation was not rolled back)',
          await receipt(tab.id, navigated),
        )
      }
      // 受控标签在加载期间接管了对话框，顺手带回
      return receipt(tab.id, navigated, await drainDialogs(tab.id))
    })
  },

  async click({ tab_id, ref, dialog, dialog_input } = {}, { signal } = {}) {
    return performAction(tab_id, 'click', { ref: refParam(ref), dialog: dialogParam(dialog, dialog_input) }, signal)
  },

  async fill({ tab_id, ref, value, dialog, dialog_input } = {}, { signal } = {}) {
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
      throw new RpcError(ErrorCode.BAD_REQUEST, 'value must be a string (or a boolean for checkboxes)')
    }
    return performAction(tab_id, 'fill', { ref: refParam(ref), value, dialog: dialogParam(dialog, dialog_input) }, signal)
  },

  async press({ tab_id, keys, dialog, dialog_input } = {}, { signal } = {}) {
    if (typeof keys !== 'string' || !keys.trim()) {
      throw new RpcError(ErrorCode.BAD_REQUEST, 'keys is required, e.g. "Enter", "Escape", "cmd+a"')
    }
    return performAction(tab_id, 'press', { keys: keys.trim(), dialog: dialogParam(dialog, dialog_input) }, signal)
  },

  async scroll({ tab_id, ref, direction } = {}, { signal } = {}) {
    const dir = typeof direction === 'string' ? direction.trim().toLowerCase() : ''
    if (dir && !SCROLL_DIRECTIONS.has(dir)) {
      throw new RpcError(ErrorCode.BAD_REQUEST, 'direction must be one of: up, down, left, right')
    }
    if (!dir && !(typeof ref === 'string' && ref)) {
      throw new RpcError(ErrorCode.BAD_REQUEST, 'Pass ref (scroll an element into view) or direction (scroll one screen)')
    }
    return performAction(
      tab_id,
      'scroll',
      { ref: typeof ref === 'string' && ref ? ref : null, direction: dir || null },
      signal,
    )
  },

  async read_page({ tab_id, interactive_only = true, max_chars, ref } = {}, { signal } = {}) {
    const tab = await requireTab(tab_id)
    await ensureAuthorized(hostOf(tab.url), signal)
    return callContent(
      tab.id,
      'read_page',
      {
        interactive_only: interactive_only !== false,
        max_chars: clampInt(max_chars, READ_PAGE_MAX_CHARS),
        ref: typeof ref === 'string' && ref ? ref : null,
      },
      signal,
    )
  },

  async get_text({ tab_id } = {}, { signal } = {}) {
    const tab = await requireTab(tab_id)
    await ensureAuthorized(hostOf(tab.url), signal)
    return callContent(tab.id, 'get_text', {}, signal)
  },

  // ---------- 文件上传 ----------

  // 先校验目标是文件输入框，再收分片，免得传完 10 MB 才发现 ref 不对
  async upload_begin({ tab_id, ref, files } = {}, { signal } = {}) {
    const tab = await requireTab(tab_id)
    await ensureAuthorized(hostOf(tab.url), signal)
    const r = refParam(ref)
    const count = Array.isArray(files) ? files.length : 0
    await callContent(tab.id, 'upload_check', { ref: r, count }, signal)
    return { upload_id: beginUpload(tab.id, r, files) }
  },

  async upload_chunk({ upload_id, file, index, data } = {}, { signal } = {}) {
    throwIfAborted(signal)
    return addChunk(upload_id, file, index, data)
  },

  // 把分片交给内容脚本构造 File 赋给输入框；页面可能因此自动提交，所以走动作的公共路径等导航
  async upload_commit({ upload_id } = {}, { signal } = {}) {
    throwIfAborted(signal)
    const entry = takeUpload(upload_id)
    const files = entry.files.map((f) => ({ name: f.name, type: f.type, parts: f.parts }))
    return performAction(entry.tabId, 'upload', { ref: entry.ref, files, dialog: dialogParam() }, signal)
  },

  // ---------- 排障 ----------

  async console({ tab_id, pattern, only_errors, limit, clear } = {}, { signal } = {}) {
    const re = regexParam(pattern, 'pattern')
    const tab = await hookedTab(tab_id, signal)
    const r = readConsole(tab.id, {
      re,
      onlyErrors: only_errors === true,
      limit: clampInt(limit, LOG_LIMIT),
      clear: clear === true,
    })
    return { tab_id: tab.id, url: tab.url || '', ...r }
  },

  async network({ tab_id, url_pattern, limit, clear } = {}, { signal } = {}) {
    const re = regexParam(url_pattern, 'url_pattern')
    const tab = await hookedTab(tab_id, signal)
    const r = readNetwork(tab.id, { re, limit: clampInt(limit, LOG_LIMIT), clear: clear === true })
    return { tab_id: tab.id, url: tab.url || '', ...r }
  },

  async screenshot({ tab_id, full_page } = {}, { signal } = {}) {
    const tab = await requireTab(tab_id)
    await ensureAuthorized(hostOf(tab.url), signal)
    throwIfAborted(signal)
    await activateTab(tab)
    const full = full_page === true
    const shots = full ? await captureFullPage(tab, signal) : await captureViewport(tab)
    const image = await stitch(shots.frames, shots.width, shots.height)
    const fresh = await chrome.tabs.get(tab.id)
    return {
      tab_id: tab.id,
      title: fresh.title || '',
      url: fresh.url || '',
      mime: 'image/jpeg',
      width: image.width,
      height: image.height,
      screens: shots.frames.length,
      truncated: shots.truncated,
      data: image.data,
    }
  },

  async eval_js({ tab_id, code } = {}, { signal } = {}) {
    if (typeof code !== 'string' || !code.trim()) {
      throw new RpcError(ErrorCode.BAD_REQUEST, 'code is required')
    }
    const tab = await requireTab(tab_id)
    await ensureAuthorized(hostOf(tab.url), signal)
    await ensureContentScript(tab.id)
    // 代码里的 alert/confirm 会卡住页面，执行期间按取消策略接管
    await callContent(tab.id, 'arm', { dialog: { accept: false, input: null } }, signal)

    let results
    let timer
    try {
      results = await abortable(
        Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: evalInPage,
            args: [code, EVAL_MAX_CHARS],
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new RpcError(ErrorCode.TIMEOUT, 'eval timeout')), CONTENT_TIMEOUT_MS)
          }),
        ]),
        signal,
      )
    } catch (e) {
      if (e instanceof RpcError && e.code === ErrorCode.USER_STOPPED) throw e
      if (e instanceof RpcError) {
        throw new RpcError(
          ErrorCode.TIMEOUT,
          `The script did not finish within ${CONTENT_TIMEOUT_MS / 1000}s. It may be awaiting something that never resolves, or a native dialog is blocking the page.`,
          await receipt(tab.id, false).catch(() => undefined),
        )
      }
      throw new RpcError(ErrorCode.BAD_REQUEST, `Cannot run script in tab ${tab.id}: ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
    const r = results?.[0]?.result
    if (!r || typeof r !== 'object') throw new RpcError(ErrorCode.INTERNAL, 'Script returned no result')
    const dialog = await drainDialogs(tab.id)
    if (!r.ok) {
      let msg = `Script error: ${r.error}`
      if (dialog) msg += `. The script also raised a ${dialog.type} dialog ${JSON.stringify(dialog.message)}, which was auto-dismissed`
      throw new RpcError(ErrorCode.BAD_REQUEST, msg)
    }
    return { tab_id: tab.id, url: tab.url || '', value: r.value, truncated: r.truncated, dialog }
  },
}

// console 与 network 的公共前置：授权，保证钩子在；刚注入的话等首条记录送达再读
async function hookedTab(tabId, signal) {
  const tab = await requireTab(tabId)
  await ensureAuthorized(hostOf(tab.url), signal)
  throwIfAborted(signal)
  if (await ensureContentScript(tab.id)) await sleep(CAPTURE_SETTLE_MS)
  return tab
}

// 等页面加载，被停止时撤掉监听并以 user_stopped 失败
function awaitLoad(loaded, signal) {
  const p = abortable(loaded, signal)
  p.catch(() => loaded.cancel?.())
  p.cancel = () => loaded.cancel?.()
  return p
}

function regexParam(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new RpcError(ErrorCode.BAD_REQUEST, `${name} must be a string (regular expression)`)
  try {
    return new RegExp(value, 'i')
  } catch (e) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `${name} is not a valid regular expression: ${e.message}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- 截图 ----------

// captureVisibleTab 只截活动标签：激活它，窗口最小化的话还原，但不抢焦点
async function activateTab(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId)
    if (win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' })
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true })
  } catch (e) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Cannot activate tab ${tab.id}: ${e.message}`)
  }
  await sleep(ACTIVATE_SETTLE_MS)
}

async function captureBitmap(windowId) {
  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  } catch (e) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Cannot capture the tab: ${e.message}`)
  }
  const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
}

// 视口截图不依赖内容脚本，内部页只要能截就截；宽高按标签的 CSS 像素尺寸
async function captureViewport(tab) {
  const bmp = await captureBitmap(tab.windowId)
  // 激活后标签才有尺寸，重新取一次
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab)
  const width = fresh.width || bmp.width
  const height = fresh.height || bmp.height
  return { frames: [{ y: 0, bmp }], width, height, truncated: false }
}

// 整页：逐屏滚动、截图，最多 SCREENSHOT_MAX_SCREENS 屏，按实际滚动位置拼接，末屏不足一屏自然重叠。最后滚回原位。
async function captureFullPage(tab, signal) {
  const m = await callContent(tab.id, 'metrics', {}, signal)
  const vh = Math.max(1, m.viewport_height)
  const screens = Math.min(SCREENSHOT_MAX_SCREENS, Math.max(1, Math.ceil(m.scroll_height / vh)))
  const truncated = m.scroll_height > SCREENSHOT_MAX_SCREENS * vh
  const frames = []
  try {
    for (let i = 0; i < screens; i++) {
      const { scroll_y } = await callContent(tab.id, 'scroll_to', { y: i * vh }, signal)
      if (frames.length && scroll_y <= frames[frames.length - 1].y) break // 滚不动了
      await sleep(SCREENSHOT_SETTLE_MS)
      frames.push({ y: scroll_y, bmp: await captureBitmap(tab.windowId) })
    }
  } finally {
    await callContent(tab.id, 'scroll_to', { y: m.scroll_y }).catch(() => {})
  }
  const last = frames[frames.length - 1]
  return { frames, width: m.viewport_width, height: Math.min(m.scroll_height, last.y + vh), truncated }
}

// 按 CSS 像素尺寸拼成一张 JPEG：Retina 缩回一倍，省上下文；再大的压缩交内核
async function stitch(frames, width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  for (const f of frames) {
    const scale = width / f.bmp.width
    ctx.drawImage(f.bmp, 0, f.y, width, Math.round(f.bmp.height * scale))
    f.bmp.close()
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_JPEG_QUALITY })
  return { width, height, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) }
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes) {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

// ---------- eval_js ----------

// 在页面世界执行。会被序列化后注入，不能引用本模块的任何变量。
// 先按单个表达式编译（支持顶层 await），语法不通再按语句体编译，多语句要自己 return。
// 返回值在页面里序列化成文本再截断，异常也在这里捕获成 {ok:false, error}。
function evalInPage(code, maxChars) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const describe = (v) => {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    const t = typeof v
    if (t === 'string') return v
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v)
    if (t === 'function') return `[Function ${v.name || 'anonymous'}]`
    if (v instanceof Error) return v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}`
    if (typeof Document !== 'undefined' && v instanceof Document) return v.documentElement ? v.documentElement.outerHTML : '#document'
    if (typeof Element !== 'undefined' && v instanceof Element) return v.outerHTML
    if (typeof Node !== 'undefined' && v instanceof Node) return v.textContent || `#${v.nodeName}`
    if (typeof NodeList !== 'undefined' && v instanceof NodeList) v = [...v]
    if (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection) v = [...v]
    try {
      const json = JSON.stringify(v, (_k, val) => {
        if (typeof val === 'bigint') return String(val)
        if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
        if (val instanceof Error) return `${val.name}: ${val.message}`
        if (typeof Element !== 'undefined' && val instanceof Element) return val.outerHTML
        if (typeof Node !== 'undefined' && val instanceof Node) return val.textContent
        if (val instanceof Map) return Object.fromEntries(val)
        if (val instanceof Set) return [...val]
        return val
      })
      return json === undefined ? String(v) : json
    } catch {
      return String(v)
    }
  }
  const errorText = (e) => {
    if (!(e instanceof Error)) return String(e)
    let s = `${e.name}: ${e.message}`
    if (e.name === 'EvalError') s += " (the page's Content Security Policy forbids eval; eval_js cannot run on this page)"
    else if (typeof e.stack === 'string') {
      const frames = e.stack.split('\n').slice(1, 4).join('\n')
      if (frames) s += `\n${frames}`
    }
    return s
  }
  return (async () => {
    let fn
    try {
      fn = new AsyncFunction(`return (${code}\n)`)
    } catch {
      try {
        fn = new AsyncFunction(code)
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    }
    try {
      const text = describe(await fn())
      const truncated = text.length > maxChars
      return { ok: true, value: truncated ? text.slice(0, maxChars) : text, truncated }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  })()
}

function urlChanged(before, target) {
  return Boolean(target) && before !== target
}

// 对话框策略：缺省取消，accept 时 confirm 返回 true、prompt 返回 dialog_input 或默认值
function dialogParam(dialog, input) {
  const mode = typeof dialog === 'string' && dialog ? dialog.trim().toLowerCase() : 'dismiss'
  if (mode !== 'dismiss' && mode !== 'accept') {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'dialog must be "dismiss" (default) or "accept"')
  }
  if (input !== undefined && input !== null && typeof input !== 'string') {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'dialog_input must be a string')
  }
  // 模型常把没用到的参数传成空串，空串等同没传，prompt 仍返回它自己的默认值
  return { accept: mode === 'accept', input: typeof input === 'string' && input !== '' ? input : null }
}

function refParam(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'ref is required, e.g. "e12" from read_page')
  }
  return ref.trim()
}

// 动作类方法的公共路径：授权 → 内容脚本执行 → 看有没有导航 → 有就等加载完 → 回执。
// scroll 不会引起导航，跳过等待。upload 的回执多带 uploaded。
async function performAction(tabId, op, params, signal) {
  const tab = await requireTab(tabId)
  await ensureAuthorized(hostOf(tab.url), signal)
  throwIfAborted(signal)
  const before = tab.url || ''
  // 导航提交监听和加载监听都在动作前挂好：快页面在动作返回后几毫秒内就能 complete，事后再挂会错过
  const nav = op === 'scroll' ? null : watchCommit(tab.id)
  const load = op === 'scroll' ? null : waitForLoad(tab.id)

  let result
  try {
    result = await callContent(tab.id, op, params, signal)
  } catch (e) {
    // 动作触发的导航可能在回复送达前就卸载了页面，看到提交就当成功
    if (nav && nav.seen() && !(e instanceof RpcError && e.code === ErrorCode.USER_STOPPED)) result = { dialog: null }
    else {
      nav?.cancel()
      load?.cancel()
      throw e
    }
  }

  let committed = false
  let loaded = true
  if (nav) {
    committed = await nav.wait(NAV_SETTLE_MS)
    if (committed) loaded = (await awaitLoad(load, signal)).ok
    else load.cancel()
  }
  const r = await receipt(tab.id, false, result?.dialog)
  if (result?.uploaded) r.uploaded = result.uploaded
  r.navigated = committed || r.url !== before
  if (!loaded) {
    throw new RpcError(
      ErrorCode.TIMEOUT,
      'The page navigated after the action but did not finish loading within 30s. A native browser dialog (for example beforeunload) may be blocking it; ask the user to handle it in Chrome.',
      r,
    )
  }
  return r
}

// 监听主框架导航提交。先挂再动作，避免漏掉动作触发的导航。
function watchCommit(tabId) {
  let seen = false
  let settle = null
  const listener = (d) => {
    if (d.tabId !== tabId || d.frameId !== 0) return
    seen = true
    settle?.(true)
  }
  chrome.webNavigation.onCommitted.addListener(listener)
  const stop = () => chrome.webNavigation.onCommitted.removeListener(listener)
  return {
    seen: () => seen,
    cancel: stop,
    wait(ms) {
      return new Promise((resolve) => {
        if (seen) {
          stop()
          resolve(true)
          return
        }
        let done = false
        settle = (value) => {
          if (done) return
          done = true
          stop()
          resolve(value)
        }
        setTimeout(() => settle(false), ms)
      })
    },
  }
}

// 受控标签才有页面世界脚本，才可能有对话框记录；没受控不为此注入
async function drainDialogs(tabId) {
  if (!(await isControlled(tabId))) return null
  try {
    const r = await callContent(tabId, 'dialogs', {})
    return r?.dialog || null
  } catch {
    return null
  }
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'url is required')
  }
  let s = raw.trim()
  // "localhost:4567/x" 里的冒号不是协议：只有带 // 的或 file: 才算写了协议
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^file:/i.test(s)
  if (!hasScheme) s = `https://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Invalid URL: ${raw}`)
  }
  if (u.protocol === 'javascript:' || u.protocol === 'data:') {
    throw new RpcError(ErrorCode.BAD_REQUEST, `URL scheme ${u.protocol} is not allowed`)
  }
  // 本机回环地址没有证书，省略协议时补 http
  if (!hasScheme && isLoopback(u.hostname)) u.protocol = 'http:'
  return u.href
}

function isLoopback(hostname) {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

function clampInt(value, { min, max, def }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// 调内容脚本。页面被原生对话框（beforeunload 等）卡住时 sendMessage 不会回来，靠超时报错。
// 已被停止就不再派发；等回复期间被停止立刻失败。
async function callContent(tabId, op, params, signal) {
  throwIfAborted(signal)
  await ensureContentScript(tabId)
  throwIfAborted(signal)
  let reply
  let timer
  try {
    reply = await abortable(
      Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'sema', op, params }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RpcError(ErrorCode.TIMEOUT, 'content timeout')), CONTENT_TIMEOUT_MS)
        }),
      ]),
      signal,
    )
  } catch (e) {
    if (e instanceof RpcError && e.code === ErrorCode.USER_STOPPED) throw e
    if (e instanceof RpcError && e.code === ErrorCode.TIMEOUT) {
      throw new RpcError(
        ErrorCode.TIMEOUT,
        `The page did not respond to ${op} within ${CONTENT_TIMEOUT_MS / 1000}s. A native browser dialog (for example beforeunload) may be blocking it; ask the user to dismiss it in Chrome.`,
        await receipt(tabId, false).catch(() => undefined),
      )
    }
    throw new RpcError(ErrorCode.INTERNAL, `Content script did not respond: ${e.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!reply || typeof reply !== 'object') {
    throw new RpcError(ErrorCode.INTERNAL, 'Content script returned an empty reply')
  }
  if (!reply.ok) throw new RpcError(reply.error?.code || ErrorCode.INTERNAL, reply.error?.message || 'unknown error')
  return reply.result
}
