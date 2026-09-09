// 两种线格式：Chrome 原生消息（4 字节小端长度 + UTF-8 JSON）与套接字上的 JSON 行。
import { StringDecoder } from 'node:string_decoder'

export function createFrameReader(onPayload) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      onPayload(buf.subarray(4, 4 + len))
      buf = buf.subarray(4 + len)
    }
  }
}

export function frame(payload) {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(payload.length, 0)
  return Buffer.concat([head, payload])
}

export function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  return (chunk) => {
    rest += decoder.write(chunk)
    let idx
    while ((idx = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, idx)
      rest = rest.slice(idx + 1)
      if (line.trim()) onLine(line)
    }
  }
}
