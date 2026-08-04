/**
 * Hook 相关类型定义
 *
 * 事件名、stdin payload、输出协议与业界通用 hooks 格式一致（详见 test/hook.md）。
 * 基础功能支持 8 个事件，配置文件为 ~/.sema/hooks/hooks.json 与 <workingDir>/.sema/hooks/hooks.json。
 */

// 基础功能支持的 hook 事件
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

// 工具类事件（matcher 仅对这些事件生效）
export const TOOL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
])

// ==================== hooks.json 原始形状（宽松类型，解析期校验） ====================

export interface RawHookCommand {
  type?: string
  command?: string
  timeout?: number // 秒
  failClosed?: boolean // sema 扩展：hook 执行失败时按阻断处理，缺省 false（fail-open）
  if?: string // 条件过滤字段（暂不支持），含此字段的条目整条跳过
  [k: string]: unknown
}

export interface RawHookMatcherGroup {
  matcher?: string
  hooks?: RawHookCommand[]
  [k: string]: unknown
}

export interface RawHooksFile {
  hooks?: Record<string, RawHookMatcherGroup[]>
  [k: string]: unknown
}

// ==================== 合并后的可执行条目（内部） ====================

export interface LoadedHookEntry {
  event: string // 原样保留（未知事件名标 invalid 但保留在视图中）
  source: 'user' | 'project'
  matcher?: string
  command: string
  timeoutMs: number // 已应用默认值 60s 与 clamp
  timeoutRaw?: number // 配置原值（秒），未配则 undefined
  failClosed: boolean
  status: 'ok' | 'skipped' | 'invalid'
  statusReason?: string
}

// ==================== 公开查询视图（经 src/types/index.ts re-export） ====================

export interface HookEntryInfo {
  event: string
  source: 'user' | 'project'
  matcher?: string
  command: string
  timeout?: number // 配置原值（秒），未配则 undefined（运行时默认 60s）
  status: 'ok' | 'skipped' | 'invalid'
  statusReason?: string // 如 "unsupported type: http" / "contains 'if' condition"
  filePath?: string // 所属配置文件定位，"绝对路径:起始行-结束行"（事件块粒度），定位失败为纯路径
}

export interface HooksInfo {
  userConfigPath: string // ~/.sema/hooks/hooks.json
  projectConfigPath: string // <workingDir>/.sema/hooks/hooks.json
  userConfigExists: boolean
  projectConfigExists: boolean
  parseErrors: Array<{ source: 'user' | 'project'; message: string }>
  events: Record<string, HookEntryInfo[]> // 按事件分组，用户级在前、项目级追加
}

// ==================== 执行结果（内部） ====================

export interface HookExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  failedToSpawn: boolean
  durationMs: number
}

// 单条 hook 输出解析结果
export interface HookOutcome {
  kind: 'pass' | 'block' | 'error'
  decision?: 'allow' | 'deny' | 'ask' // 仅 PreToolUse / PermissionRequest
  reason?: string // block / deny 的原因
  additionalContext?: string
  systemMessage?: string
  suppressOutput?: boolean
  blockIgnored?: boolean // 不可阻断事件上收到 block 输出被忽略（用于向用户告警配置不生效）
}
