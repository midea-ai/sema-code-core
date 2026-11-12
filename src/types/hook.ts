/**
 * Hook 相关类型定义
 *
 * 事件名、stdin payload、输出协议与业界通用 hooks 格式一致（详见 test/hook.md）。
 * 支持 11 个事件，配置文件为 ~/.sema/hooks/hooks.json 与 <workingDir>/.sema/hooks/hooks.json。
 */

// 支持的 hook 事件
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
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

// hook 条目来源：宿主构造时传入 / 用户级 / 项目级配置文件，或已启用插件自带的 hooks/hooks.json
export type HookSource = 'host' | 'user' | 'project' | 'plugin'

// ==================== 合并后的可执行条目（内部） ====================

export interface LoadedHookEntry {
  id: string // 条目标识，见 HookEntryInfo.id
  enabled: boolean // 见 HookEntryInfo.enabled
  event: string // 原样保留（未知事件名标 invalid 但保留在视图中）
  source: HookSource
  pluginName?: string // 仅 source === 'plugin'
  configPath: string // 所属配置文件绝对路径；host 条目为 ''
  matcher?: string
  command: string // 插件条目已展开 ${SEMA_PLUGIN_ROOT}
  timeoutMs: number // 已应用默认值 60s 与 clamp
  timeoutRaw?: number // 配置原值（秒），未配则 undefined
  failClosed: boolean
  status: 'ok' | 'skipped' | 'invalid'
  statusReason?: string
}

// ==================== 公开查询视图（经 src/types/index.ts re-export） ====================

export interface HookEntryInfo {
  // 条目标识（hook 没有名字）：由 来源 + 插件名 + 事件 + matcher + 配置里的原始命令 算出，removeHook / enableHook / disableHook 的入参。
  // 改了事件、matcher 或命令即视为新条目；同一来源里内容完全相同的重复条目共用一个 id
  id: string
  enabled: boolean // 是否启用（settings 的 disabledHooks 控制，用户级 + 项目级并集；host 条目恒为启用）；与 status 独立，都满足才会执行
  event: string
  source: HookSource
  pluginName?: string // 仅 source === 'plugin'：所属插件名
  matcher?: string
  command: string
  timeout?: number // 配置原值（秒），未配则 undefined（运行时默认 60s）
  status: 'ok' | 'skipped' | 'invalid'
  statusReason?: string // 如 "unsupported type: http" / "contains 'if' condition"
  filePath?: string // 所属配置文件定位，"绝对路径:起始行-结束行"（事件块粒度），定位失败为纯路径；host 条目无此字段
}

// addHook 入参：写入 scope 对应层的 hooks.json
export interface HookConfig {
  scope: 'user' | 'project'
  event: HookEventName
  matcher?: string // 仅工具类事件生效；缺省匹配全部工具
  command: string
  timeout?: number // 秒，缺省 60
  failClosed?: boolean // hook 执行失败时按阻断处理，缺省 false
}

export interface HooksInfo {
  userConfigPath: string // ~/.sema/hooks/hooks.json；user 域没生效时为 ''
  projectConfigPath: string // <workingDir>/.sema/hooks/hooks.json；project 域没生效时为 ''
  userConfigExists: boolean // user 域没生效时恒为 false
  projectConfigExists: boolean // project 域没生效时恒为 false
  parseErrors: Array<{ source: HookSource; pluginName?: string; message: string }>
  events: Record<string, HookEntryInfo[]> // 按事件分组，插件在前、用户级其次、项目级追加
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
