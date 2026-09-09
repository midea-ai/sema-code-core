// file_upload：桥接进程读本地文件，按 upload_begin / upload_chunk / upload_commit 三步送给扩展。
// 文件内容不经过模型。总量 10 MB 在读文件前按 stat 校验。
import fs from 'node:fs'
import path from 'node:path'
import { BridgeError } from './client.js'
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './protocol.js'

const MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

export async function runUpload(client, { tab_id, ref, paths } = {}) {
  const files = inspect(paths)
  const { upload_id } = await client.request('upload_begin', {
    tab_id,
    ref,
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
  })
  for (const [i, f] of files.entries()) {
    const buf = fs.readFileSync(f.path)
    if (buf.length !== f.size) {
      throw new BridgeError('bad_request', `${f.path} changed while reading (expected ${f.size} bytes, got ${buf.length})`)
    }
    for (let off = 0, index = 0; off < buf.length; off += UPLOAD_CHUNK_BYTES, index++) {
      await client.request('upload_chunk', {
        upload_id,
        file: i,
        index,
        data: buf.subarray(off, off + UPLOAD_CHUNK_BYTES).toString('base64'),
      })
    }
  }
  return client.request('upload_commit', { upload_id })
}

function inspect(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new BridgeError('bad_request', 'paths must be a non-empty array of absolute file paths')
  }
  if (paths.length > UPLOAD_MAX_FILES) {
    throw new BridgeError('bad_request', `At most ${UPLOAD_MAX_FILES} files per upload; ${paths.length} given`)
  }
  const files = paths.map((p) => {
    if (typeof p !== 'string' || !p.trim()) throw new BridgeError('bad_request', 'Each path must be a non-empty string')
    if (!path.isAbsolute(p)) throw new BridgeError('bad_request', `Path must be absolute: ${p}`)
    let st
    try {
      st = fs.statSync(p)
    } catch {
      throw new BridgeError('bad_request', `File not found: ${p}`)
    }
    if (!st.isFile()) throw new BridgeError('bad_request', `Not a regular file: ${p}`)
    return { path: p, name: path.basename(p), size: st.size, type: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' }
  })
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > UPLOAD_MAX_BYTES) {
    const detail = files.map((f) => `${f.name} (${mb(f.size)} MB)`).join(', ')
    throw new BridgeError(
      'bad_request',
      `Files total ${mb(total)} MB, over the ${mb(UPLOAD_MAX_BYTES)} MB upload limit: ${detail}`,
    )
  }
  return files
}

export function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}
