/**
 * 带稳定错误码的错误。
 *
 * createSession 的失败结果与写接口抛出的错误都带 code，宿主据此区分原因；
 * 文案随 lang 变化，code 不变。没有 code 的普通 Error 照旧只有文案。
 */

export const ERROR_CODES = {
  /** 构造参数或运行期更新的配置校验不通过 */
  CONFIG_INVALID: 'CONFIG_INVALID',
  /** 要写的域没有生效（scopes 未包含） */
  SCOPE_DISABLED: 'SCOPE_DISABLED',
  /** 要改的是宿主传入的 host 域条目 */
  HOST_READONLY: 'HOST_READONLY',
  /** 文件是密文但没传密钥 */
  HISTORY_KEY_REQUIRED: 'HISTORY_KEY_REQUIRED',
  /** 密钥不对或密文损坏 */
  HISTORY_DECRYPT_FAILED: 'HISTORY_DECRYPT_FAILED',
} as const

export type SemaErrorCode = keyof typeof ERROR_CODES

export class SemaError extends Error {
  readonly code: SemaErrorCode

  constructor(code: SemaErrorCode, message: string) {
    super(message)
    this.name = 'SemaError'
    this.code = code
  }
}

/** 取错误上的 code（SemaError 之外返回 undefined） */
export function errorCodeOf(error: unknown): SemaErrorCode | undefined {
  return error instanceof SemaError ? error.code : undefined
}

/** 要写的域没生效 */
export function scopeDisabledError(kind: string, scope: string): SemaError {
  return new SemaError('SCOPE_DISABLED', `Scope '${scope}' of ${kind} is not enabled`)
}

/** 目标是 host 域条目 */
export function hostReadonlyError(kind: string, name: string): SemaError {
  return new SemaError('HOST_READONLY', `${kind} '${name}' is provided by the host and is read-only`)
}
