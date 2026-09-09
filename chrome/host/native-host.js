#!/usr/bin/env node
// Sema 浏览器控制：原生宿主。由 Chrome 按清单拉起，生命周期等于扩展与它之间的消息端口。
// 一头按 Chrome 原生消息格式读写 stdio，另一头是本机套接字服务端。只转发，不解析：
// 桥接进程发来的每一行原样发给扩展，扩展的每条消息原样广播给所有桥接进程（id 由桥接进程保证唯一）。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { semaChromeDir, socketPath } from './lib/protocol.js'
import { createFrameReader, createLineReader, frame } from './lib/framing.js'

const dir = semaChromeDir()
const sock = socketPath()
const clients = new Set()
const NEWLINE = Buffer.from('\n')

// stdout 是与 Chrome 的通道，日志只能写文件
function log(...parts) {
  try {
    fs.appendFileSync(path.join(dir, 'native-host.log'), `${localTime()} ${parts.join(' ')}\n`)
  } catch {
    // 忽略
  }
}

// 本地时间带时区偏移，如 2026-09-08 11:27:52.795+08:00
function localTime() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

process.stdin.on(
  'data',
  createFrameReader((payload) => {
    const line = Buffer.concat([payload, NEWLINE])
    for (const c of clients) c.write(line)
  }),
)
process.stdin.on('end', () => shutdown('stdin closed'))
process.stdin.on('error', (e) => shutdown(`stdin error: ${e.message}`))

const server = net.createServer((conn) => {
  clients.add(conn)
  conn.on(
    'data',
    createLineReader((line) => {
      process.stdout.write(frame(Buffer.from(line, 'utf8')))
    }),
  )
  conn.on('close', () => clients.delete(conn))
  conn.on('error', () => {})
})
server.on('error', (e) => shutdown(`server error: ${e.message}`))

fs.mkdirSync(dir, { recursive: true })
// 上一个宿主留下的套接字文件由新宿主清掉；退出时不删，避免误删接替者的
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(sock)
  } catch {
    // 不存在
  }
}
server.listen(sock, () => {
  if (process.platform !== 'win32') fs.chmodSync(sock, 0o600)
  log('listening', sock)
})

// 不调 server.close()：node 会顺手删掉套接字文件，可能删到接替者的；留下的旧文件由下一个宿主清理
function shutdown(reason) {
  log('exit:', reason)
  for (const c of clients) c.destroy()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
