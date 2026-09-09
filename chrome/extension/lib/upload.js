// 文件上传的分片暂存。桥接进程 upload_begin 报文件清单，upload_chunk 逐片送 base64，upload_commit 交给内容脚本。
// 分片按文件顺序、片序号顺序到达；总量 10 MB；60 秒没有新片或没 commit 的上传丢弃。只在后台内存里。
import {
  ErrorCode,
  RpcError,
  UPLOAD_CHUNK_MAX_CHARS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TTL_MS,
} from './protocol.js'

const uploads = new Map() // upload_id -> { tabId, ref, files: [{ name, type, size, received, parts: [] }], timer }
const NAME_MAX = 255

export function beginUpload(tabId, ref, files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new RpcError(ErrorCode.BAD_REQUEST, 'files must be a non-empty array of {name, type, size}')
  }
  if (files.length > UPLOAD_MAX_FILES) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `At most ${UPLOAD_MAX_FILES} files per upload; ${files.length} given`)
  }
  let total = 0
  const list = files.map((f, i) => {
    const name = typeof f?.name === 'string' ? f.name.trim() : ''
    if (!name || name.length > NAME_MAX || name.includes('/') || name.includes('\\')) {
      throw new RpcError(ErrorCode.BAD_REQUEST, `files[${i}].name must be a plain file name`)
    }
    if (!Number.isInteger(f.size) || f.size < 0) {
      throw new RpcError(ErrorCode.BAD_REQUEST, `files[${i}].size must be a non-negative integer`)
    }
    total += f.size
    return { name, type: typeof f.type === 'string' ? f.type : '', size: f.size, received: 0, parts: [] }
  })
  if (total > UPLOAD_MAX_BYTES) {
    throw new RpcError(
      ErrorCode.BAD_REQUEST,
      `Files total ${mb(total)} MB, over the ${mb(UPLOAD_MAX_BYTES)} MB upload limit`,
    )
  }
  const id = crypto.randomUUID()
  const entry = { tabId, ref, files: list, timer: null }
  uploads.set(id, entry)
  touch(id, entry)
  return id
}

export function addChunk(uploadId, fileIndex, index, data) {
  const entry = get(uploadId)
  const file = entry.files[fileIndex]
  if (!Number.isInteger(fileIndex) || !file) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `file must be an index into the files of upload ${uploadId}`)
  }
  if (index !== file.parts.length) {
    throw new RpcError(
      ErrorCode.BAD_REQUEST,
      `Chunk ${index} of file ${fileIndex} arrived out of order; expected chunk ${file.parts.length}`,
    )
  }
  if (typeof data !== 'string' || data.length > UPLOAD_CHUNK_MAX_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `data must be base64 of at most ${UPLOAD_CHUNK_MAX_CHARS} characters`)
  }
  const bytes = decodedLength(data)
  if (file.received + bytes > file.size) {
    throw new RpcError(
      ErrorCode.BAD_REQUEST,
      `File ${fileIndex} (${file.name}) received more bytes than its declared size ${file.size}`,
    )
  }
  file.parts.push(data)
  file.received += bytes
  touch(uploadId, entry)
  return { file: fileIndex, received: file.received, size: file.size }
}

// 取走并删除；每个文件的字节数必须与声明一致
export function takeUpload(uploadId) {
  const entry = get(uploadId)
  for (const [i, f] of entry.files.entries()) {
    if (f.received !== f.size) {
      throw new RpcError(
        ErrorCode.BAD_REQUEST,
        `File ${i} (${f.name}) is incomplete: ${f.received} of ${f.size} bytes received`,
      )
    }
  }
  clearTimeout(entry.timer)
  uploads.delete(uploadId)
  return entry
}

function get(uploadId) {
  const entry = typeof uploadId === 'string' ? uploads.get(uploadId) : null
  if (!entry) {
    throw new RpcError(ErrorCode.BAD_REQUEST, `Unknown or expired upload ${uploadId}; start again with upload_begin`)
  }
  return entry
}

function touch(id, entry) {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => uploads.delete(id), UPLOAD_TTL_MS)
}

function decodedLength(b64) {
  let pad = 0
  if (b64.endsWith('==')) pad = 2
  else if (b64.endsWith('=')) pad = 1
  return Math.floor((b64.length * 3) / 4) - pad
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}
