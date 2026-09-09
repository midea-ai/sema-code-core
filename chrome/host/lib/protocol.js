// 桥接进程与扩展共用的协议常量，需与 extension/lib/protocol.js 保持一致。
import os from 'node:os'
import path from 'node:path'

export const PROTOCOL_VERSION = 1
export const NATIVE_HOST_NAME = 'com.sema.chrome'
// 扩展 ID：商店分配，manifest 里的 key 就是商店公钥，仓库目录解压加载得到同一个 ID
export const EXTENSION_ID = 'pjofgjgagohldpbcnkgnfjeehealejie'
export const REQUEST_TIMEOUT_MS = 60_000
// 文件上传：总量上限；每片原始 700 KiB，base64 后约 956 KB，加信封仍在宿主到扩展单条 1 MB 以内
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const UPLOAD_MAX_FILES = 20
export const UPLOAD_CHUNK_BYTES = 700 * 1024

// 原生宿主与桥接进程的落脚目录：包装脚本、套接字、日志都在这里
export function semaChromeDir() {
  return path.join(os.homedir(), '.sema', 'chrome')
}

// Chrome 从 Dock 启动时的环境变量和终端不一样，套接字不放 $TMPDIR，放用户目录下固定位置
export function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\sema-chrome-${os.userInfo().username}`
  return path.join(semaChromeDir(), 'host.sock')
}

export function extensionIds() {
  const extra = (process.env.SEMA_CHROME_EXTENSION_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([EXTENSION_ID, ...extra])]
}
