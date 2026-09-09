// 桥接进程到原生宿主的套接字客户端：按需连接，请求带唯一 id，60 秒超时，连不上立刻报未连接。
// 每次连上先发一条 hello：扩展据此把"立即停止"复位（宿主应用重启了）。
import net from 'node:net'
import { PROTOCOL_VERSION, REQUEST_TIMEOUT_MS, socketPath } from './protocol.js'
import { createLineReader } from './framing.js'

export const NOT_CONNECTED_MESSAGE =
  'Chrome extension is not connected. Ask the user to open Chrome and make sure the "Sema Browser Control" extension is enabled, then retry.'

export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

export class HostClient {
  constructor() {
    this.sock = null
    this.connecting = null
    this.pending = new Map()
    this.counter = 0
    // 多个桥接进程共用一个宿主，宿主把扩展的响应广播给所有桥接进程，id 必须全局唯一
    this.prefix = `${process.pid}-${Date.now().toString(36)}`
    this.greeted = false
  }

  async request(method, params) {
    let sock
    try {
      sock = await this.connect()
    } catch {
      throw new BridgeError('not_connected', NOT_CONNECTED_MESSAGE)
    }
    if (!this.greeted) {
      this.greeted = true
      try {
        await this.send(sock, 'hello', { pid: process.pid })
      } catch (e) {
        // 旧扩展不认识 hello，照常工作；连接层错误留给下面的请求自己报
        if (!(e instanceof BridgeError && e.code === 'unsupported')) this.greeted = false
      }
    }
    return this.send(sock, method, params)
  }

  send(sock, method, params) {
    const id = `${this.prefix}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('timeout', `No response from the extension within ${REQUEST_TIMEOUT_MS / 1000}s for ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      sock.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`)
    })
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock)
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath())
      let connected = false
      sock.on('connect', () => {
        connected = true
        this.sock = sock
        this.connecting = null
        resolve(sock)
      })
      sock.on('data', createLineReader((line) => this.onLine(line)))
      sock.on('error', (e) => {
        if (!connected) {
          this.connecting = null
          reject(e)
        }
      })
      sock.on('close', () => {
        if (this.sock === sock) this.sock = null
        this.greeted = false
        this.failAll(new BridgeError('not_connected', NOT_CONNECTED_MESSAGE))
      })
    })
    return this.connecting
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || msg.id === undefined || msg.id === null) return
    const entry = this.pending.get(msg.id)
    if (!entry) return // 其他桥接进程的响应
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      const err = msg.error
      entry.reject(new BridgeError(err.code || 'internal', err.message || 'unknown error', err.data))
    } else {
      entry.resolve(msg.result)
    }
  }

  failAll(err) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
  }
}
