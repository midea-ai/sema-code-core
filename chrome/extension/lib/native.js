// 与原生宿主的连接：一条原生消息端口，断开后重连，工具栏角标显示连接状态。
// 也管"立即停止"：停止后进行中的请求立刻回 user_stopped、结果丢弃，之后的请求直接拒绝，
// 直到用户在弹窗点"允许继续"，或有桥接进程新连上来发 hello（宿主应用重启）。
import { NATIVE_HOST, PROTOCOL_VERSION, RECONNECT_MS, stoppedError } from './protocol.js'

const MAX_RECONNECT_MS = 30_000
// 端口存活超过这个时间就认为连接是健康的，重连间隔复位
const HEALTHY_AFTER_MS = 10_000
const STOPPED_KEY = 'stopped' // 存 session，后台被回收后仍在
// 停止状态下仍然放行的方法：hello 用来复位，ping 只是探测
const PASS_WHEN_STOPPED = new Set(['hello', 'ping'])

export class NativeLink {
  constructor(onRequest) {
    this.onRequest = onRequest
    this.port = null
    this.delay = RECONNECT_MS
    this.timer = null
    this.reason = null
    this.stopped = false
    this.inflight = new Map() // id -> { method, controller }
  }

  async restore() {
    const r = await chrome.storage.session.get(STOPPED_KEY)
    this.stopped = r[STOPPED_KEY] === true
    this.badge()
  }

  connect() {
    if (this.port) return
    clearTimeout(this.timer)
    const port = chrome.runtime.connectNative(NATIVE_HOST)
    this.port = port
    const healthy = setTimeout(() => {
      if (this.port === port) this.delay = RECONNECT_MS
    }, HEALTHY_AFTER_MS)
    port.onMessage.addListener((msg) => {
      this.delay = RECONNECT_MS
      this.handle(msg)
    })
    port.onDisconnect.addListener(() => {
      clearTimeout(healthy)
      this.reason = chrome.runtime.lastError?.message || 'native host disconnected'
      this.port = null
      this.badge()
      this.timer = setTimeout(() => this.connect(), this.delay)
      this.delay = Math.min(this.delay * 2, MAX_RECONNECT_MS)
    })
    this.reason = null
    this.badge()
  }

  async handle(msg) {
    // 没有 id 的是通知，不处理
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return
    const method = typeof msg.method === 'string' ? msg.method : ''
    // 桥接进程新连上来：宿主应用重启了，上一次的停止不再作数
    if (method === 'hello') await this.resume()
    if (this.stopped && !PASS_WHEN_STOPPED.has(method)) {
      this.send({ v: PROTOCOL_VERSION, id: msg.id, error: stoppedError().toJSON() })
      return
    }
    const controller = new AbortController()
    this.inflight.set(msg.id, { method, controller })
    const reply = await this.onRequest(msg, controller.signal)
    // 停止时已经答复过的，结果丢弃
    if (!this.inflight.delete(msg.id)) return
    this.send({ v: PROTOCOL_VERSION, id: msg.id, ...reply })
  }

  async stop() {
    this.stopped = true
    await chrome.storage.session.set({ [STOPPED_KEY]: true })
    for (const [id, { method, controller }] of this.inflight) {
      this.send({ v: PROTOCOL_VERSION, id, error: stoppedError(method).toJSON() })
      controller.abort()
    }
    this.inflight.clear()
    this.badge()
  }

  async resume() {
    if (!this.stopped) return
    this.stopped = false
    await chrome.storage.session.set({ [STOPPED_KEY]: false })
    this.badge()
  }

  status() {
    return {
      connected: Boolean(this.port),
      reason: this.port ? null : this.reason || 'connecting',
      stopped: this.stopped,
      inflight: [...this.inflight.values()].map((e) => e.method),
    }
  }

  send(msg) {
    try {
      this.port?.postMessage(msg)
    } catch (e) {
      console.warn('[sema] postMessage to native host failed', e)
    }
  }

  badge() {
    const connected = Boolean(this.port)
    let text = ''
    let color = '#d13438'
    let title = 'Sema 浏览器控制：已连接原生宿主'
    if (!connected) {
      text = '!'
      title = `Sema 浏览器控制：未连接（${this.reason || 'connecting'}）`
    } else if (this.stopped) {
      text = '停'
      color = '#b45309'
      title = 'Sema 浏览器控制：已停止，点开弹窗允许继续'
    }
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color })
    chrome.action.setTitle({ title })
  }
}
