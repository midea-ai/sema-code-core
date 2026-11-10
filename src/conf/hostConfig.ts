/**
 * host 域内容、生效域与加密密钥的唯一存放处。
 *
 * ConfManager.setCoreConfig 开头调用 setHostConfig 做校验并存下来，之后各管理器只读这里：
 * - 模型 / MCP / hook / skill / 子代理 / 命令管理器按 isScopeEnabled 决定读哪些来源，host 内容从 getHostConfig 取
 * - 写接口用 assertScopeEnabled 拒绝没生效的域
 * - 密钥只在这里持有：不进 coreConfig（getCoreConfig 拿不到）、不写文件、不进日志
 *
 * 管理器都是进程单例，各自在首次构造时读取这里的内容；宿主一个进程只应构造一次 SemaCore，要换就重启进程。
 */

import type { SemaCoreConfig } from '../types/index'
import type {
  AgentsInput,
  CommandsInput,
  HooksInput,
  MCPServerInput,
  ModelsInput,
  ScopesConfig,
  SkillsInput,
} from '../types/host'
import { SemaError } from '../util/errors'

export type ScopeKind = keyof ResolvedScopes

export interface ResolvedScopes {
  models: string[]
  mcp: string[]
  hooks: string[]
  skills: string[]
  agents: string[]
  commands: string[]
  plugins: string[]
}

/** 各类允许的域；不写 scopes 时全部生效 */
const ALL_SCOPES: ResolvedScopes = {
  models: ['host', 'user'],
  mcp: ['host', 'user', 'project'],
  hooks: ['host', 'user', 'project'],
  skills: ['host', 'builtin', 'user', 'project'],
  agents: ['host', 'builtin', 'user', 'project'],
  commands: ['host', 'user', 'project'],
  plugins: ['user', 'project', 'local'],
}

const KEY_BYTES = 32

export interface HostEncryption {
  key: Buffer
  keyId: string
}

export interface HostConfig {
  models: ModelsInput | null
  mcpServers: MCPServerInput[]
  hooks: HooksInput | null
  skills: SkillsInput
  agents: AgentsInput
  commands: CommandsInput
  scopes: ResolvedScopes
  encryption: HostEncryption | null
}

function emptyHostConfig(): HostConfig {
  return {
    models: null,
    mcpServers: [],
    hooks: null,
    skills: {},
    agents: {},
    commands: {},
    scopes: { ...ALL_SCOPES },
    encryption: null,
  }
}

let current: HostConfig = emptyHostConfig()

// ==================== 校验 ====================

function invalid(message: string): SemaError {
  return new SemaError('CONFIG_INVALID', message)
}

function resolveScopes(scopes: ScopesConfig | undefined): ResolvedScopes {
  const resolved: ResolvedScopes = { ...ALL_SCOPES }
  if (scopes === undefined) return resolved
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw invalid('scopes must be an object')
  for (const [kind, values] of Object.entries(scopes)) {
    if (!(kind in ALL_SCOPES)) throw invalid(`scopes.${kind} is not a known kind`)
    if (values === undefined) continue
    if (!Array.isArray(values)) throw invalid(`scopes.${kind} must be an array`)
    const allowed = ALL_SCOPES[kind as ScopeKind]
    for (const v of values) {
      if (!allowed.includes(v)) throw invalid(`scopes.${kind} contains unknown value '${v}' (allowed: ${allowed.join(', ')})`)
    }
    resolved[kind as ScopeKind] = [...values]
  }
  return resolved
}

function resolveEncryption(encryption: SemaCoreConfig['encryption']): HostEncryption | null {
  if (encryption === undefined || encryption === null) return null
  if (typeof encryption !== 'object' || typeof encryption.key !== 'string') throw invalid('encryption.key must be a base64 string')
  const key = Buffer.from(encryption.key, 'base64')
  if (key.length !== KEY_BYTES) throw invalid(`encryption.key must decode to ${KEY_BYTES} bytes, got ${key.length}`)
  const keyId = encryption.keyId ?? ''
  if (typeof keyId !== 'string' || keyId.includes(':') || /[\r\n]/.test(keyId)) throw invalid("encryption.keyId must be a string without ':' or line breaks")
  return { key, keyId }
}

type NamedItem = Record<string, unknown>

/** 模型没有 name 字段，按内核给 profile 起名的规则 modelName[provider] 去重 */
const modelKey = (item: NamedItem): string => `${item.modelName}[${item.provider}]`
const nameKey = (item: NamedItem): string => String(item.name ?? '')

function requireNamedItems(label: string, items: unknown, fields: string[], keyOf: (item: NamedItem) => string = nameKey): void {
  if (items === undefined) return
  if (!Array.isArray(items)) throw invalid(`${label} must be an array`)
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object') throw invalid(`${label} entries must be objects`)
    for (const f of fields) {
      if (typeof (item as NamedItem)[f] !== 'string' || !(item as NamedItem)[f]) {
        throw invalid(`${label} entry '${keyOf(item as NamedItem)}' is missing '${f}'`)
      }
    }
    const key = keyOf(item as NamedItem)
    if (seen.has(key)) throw invalid(`${label} has duplicate entry '${key}'`)
    seen.add(key)
  }
}

function requireStringArray(label: string, value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) throw invalid(`${label} must be an array of non-empty strings`)
}

function resolveModels(models: ModelsInput | undefined): ModelsInput | null {
  if (models === undefined) return null
  if (!models || typeof models !== 'object') throw invalid('models must be an object')
  requireNamedItems('models.profiles', models.profiles, ['provider', 'modelName'], modelKey)
  if (!Array.isArray(models.profiles)) throw invalid('models.profiles must be an array')
  requireNamedItems('models.imageProfiles', models.imageProfiles, ['provider', 'modelName'], modelKey)
  for (const p of ['main', 'quick', 'image'] as const) {
    if (models[p] !== undefined && typeof models[p] !== 'string') throw invalid(`models.${p} must be a string`)
  }
  return models
}

function resolveMcpServers(servers: MCPServerInput[] | undefined): MCPServerInput[] {
  if (servers === undefined) return []
  requireNamedItems('mcpServers', servers, ['name', 'transport'])
  return servers
}

function resolveHooks(hooks: HooksInput | undefined): HooksInput | null {
  if (hooks === undefined) return null
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw invalid('hooks must be an object keyed by event name')
  return hooks
}

function resolveItemsAndDirs<T extends { items?: unknown[]; dirs?: string[] }>(label: string, input: T | undefined, fields: string[]): T {
  if (input === undefined) return {} as T
  if (!input || typeof input !== 'object') throw invalid(`${label} must be an object`)
  requireNamedItems(`${label}.items`, input.items, fields)
  requireStringArray(`${label}.dirs`, input.dirs)
  return input
}

// ==================== 读写 ====================

/**
 * 校验并存下 host 域内容、生效域与密钥；校验不通过抛 SemaError(CONFIG_INVALID)。
 * 由 ConfManager.setCoreConfig 调用，构造参数里不传任何相关字段时等价于全部生效、不加密。
 *
 * host 域与其他域同一条规则：某类的 scopes 不含 'host' 时，宿主传入的该类内容照常校验但不存下来，
 * 各管理器从 getHostConfig 读到的就是空，不用各自再判断。
 */
export function setHostConfig(config: SemaCoreConfig): void {
  const encryption = resolveEncryption(config.encryption)
  const models = resolveModels(config.models)
  const mcpServers = resolveMcpServers(config.mcpServers)
  const hooks = resolveHooks(config.hooks)
  const skills = resolveItemsAndDirs('skills', config.skills, ['name', 'description', 'prompt'])
  const agents = resolveItemsAndDirs('agents', config.agents, ['name', 'description', 'prompt'])
  const commands = resolveItemsAndDirs('commands', config.commands, ['name', 'description', 'prompt'])
  const scopes = resolveScopes(config.scopes)
  const hostOn = (kind: ScopeKind): boolean => scopes[kind].includes('host')
  current = {
    models: hostOn('models') ? models : null,
    mcpServers: hostOn('mcp') ? mcpServers : [],
    hooks: hostOn('hooks') ? hooks : null,
    skills: hostOn('skills') ? skills : {},
    agents: hostOn('agents') ? agents : {},
    commands: hostOn('commands') ? commands : {},
    scopes,
    encryption,
  }
}

export function getHostConfig(): HostConfig {
  return current
}

export function isScopeEnabled(kind: ScopeKind, scope: string): boolean {
  return current.scopes[kind].includes(scope)
}

/** 域没生效抛 SemaError(SCOPE_DISABLED)，供写接口使用 */
export function assertScopeEnabled(kind: ScopeKind, scope: string): void {
  if (!isScopeEnabled(kind, scope)) {
    throw new SemaError('SCOPE_DISABLED', `Scope '${scope}' of ${kind} is not enabled`)
  }
}

/** 加密密钥；没传 encryption 返回 null */
export function getEncryptionKey(): HostEncryption | null {
  return current.encryption
}

// ==================== 日志脱敏 ====================

const MASK = '***'

function maskValues(obj: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!obj) return obj
  return Object.fromEntries(Object.keys(obj).map(k => [k, MASK]))
}

function describeText(text: unknown): string {
  return typeof text === 'string' ? `<${text.length} chars>` : String(text)
}

function maskItems<T extends { prompt?: unknown; files?: Record<string, string> }>(input: { items?: T[]; dirs?: string[] } | undefined) {
  if (!input) return input
  return {
    ...input,
    items: input.items?.map(item => ({
      ...item,
      prompt: describeText(item.prompt),
      ...(item.files ? { files: Object.fromEntries(Object.entries(item.files).map(([k, v]) => [k, describeText(v)])) } : {}),
    })),
  }
}

/**
 * 构造参数的日志视图：密钥、apiKey、MCP 的 env / headers 值打码，skill / 子代理 / 命令正文只留长度
 */
export function maskForLog(config: SemaCoreConfig | undefined): Record<string, unknown> | undefined {
  if (!config) return config
  const out: Record<string, unknown> = { ...config }
  if (config.encryption) out.encryption = { ...config.encryption, key: MASK }
  if (config.models) {
    out.models = {
      ...config.models,
      profiles: config.models.profiles?.map(p => ({ ...p, apiKey: MASK })),
      ...(config.models.imageProfiles ? { imageProfiles: config.models.imageProfiles.map(p => ({ ...p, apiKey: MASK })) } : {}),
    }
  }
  if (config.mcpServers) {
    out.mcpServers = config.mcpServers.map(s => ({ ...s, env: maskValues(s.env), headers: maskValues(s.headers) }))
  }
  if (config.skills) out.skills = maskItems(config.skills)
  if (config.agents) out.agents = maskItems(config.agents)
  if (config.commands) out.commands = maskItems(config.commands)
  return out
}
