// 扩展 ↔ 桥接进程之间的协议常量。原生宿主只转发，不解析。
// 线上格式：请求 {v, id, method, params}，响应 {v, id, result} 或 {v, id, error:{code, message, data?}}。

export const PROTOCOL_VERSION = 1

// 原生消息宿主名，必须与桥接进程写入的清单文件名一致
export const NATIVE_HOST = 'com.sema.chrome'

export const GROUP_TITLE = 'Sema'
export const LOAD_TIMEOUT_MS = 30_000
// 桥接进程每个请求 60 秒超时，授权窗口略短，保证"站点未授权"能在桥接超时前送达
export const AUTH_TIMEOUT_MS = 55_000
export const RECONNECT_MS = 2_000
// 内容脚本一次调用的上限：页面被 beforeunload 之类的原生对话框卡住时靠它报错
export const CONTENT_TIMEOUT_MS = 30_000
// 动作后等这么久看有没有提交导航（webNavigation.onCommitted）
export const NAV_SETTLE_MS = 300
// 导航提交后页面世界脚本接管原生对话框的时长，覆盖加载期间的 alert
export const LOAD_ARM_MS = 10_000
// 控制台与网络记录：每个标签各存这么多条，满了丢最旧的
export const CAPTURE_MAX_ENTRIES = 1000
// 刚注入钩子后等首条记录（meta）送达再读缓冲
export const CAPTURE_SETTLE_MS = 100
// 整页截图最多拼几屏；每屏滚动后等这么久再截（captureVisibleTab 每秒限 2 次）
export const SCREENSHOT_MAX_SCREENS = 5
export const SCREENSHOT_SETTLE_MS = 500
export const SCREENSHOT_JPEG_QUALITY = 0.8
// eval_js 返回值上限
export const EVAL_MAX_CHARS = 20_000
// 文件上传：总量上限、单条分片的 base64 上限（宿主到扩展单条消息 1 MB）、没 commit 的上传保留时长
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const UPLOAD_MAX_FILES = 20
export const UPLOAD_CHUNK_MAX_CHARS = 1_000_000
export const UPLOAD_TTL_MS = 60_000

export const ErrorCode = {
  SITE_NOT_AUTHORIZED: 'site_not_authorized',
  TAB_NOT_FOUND: 'tab_not_found',
  TAB_NOT_OWNED: 'tab_not_owned',
  REF_INVALID: 'ref_invalid',
  TIMEOUT: 'timeout',
  BAD_REQUEST: 'bad_request',
  UNSUPPORTED: 'unsupported',
  USER_STOPPED: 'user_stopped',
  INTERNAL: 'internal',
}

// 用户在弹窗点了"立即停止"。进行中的请求与之后的请求都用这个错误，直到用户点"允许继续"或有桥接进程新连上来
export function stoppedError(method) {
  const during = method ? ` while ${method} was running` : ''
  return new RpcError(
    ErrorCode.USER_STOPPED,
    `The user pressed Stop in the Sema extension${during}. End your turn now and report what was in progress. Do not retry: browser tools stay blocked until the user clicks "允许继续" (Resume) in the extension popup.`,
  )
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw stoppedError()
}

// 等待期间被停止就立刻以 user_stopped 失败；原 promise 继续跑完无害，结果会被丢弃
export function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(stoppedError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stoppedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }

  toJSON() {
    const out = { code: this.code, message: this.message }
    if (this.data !== undefined) out.data = this.data
    return out
  }
}
