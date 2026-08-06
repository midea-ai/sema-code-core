/**
 * 统一的 .sema/settings.json 加载器
 *
 * 分层：用户级 ~/.sema/settings.json < 项目级 <project>/.sema/settings.json
 * 各模块（MCP/Cron/Plugins/env）共用此处的路径解析与读写
 */
import * as fs from 'fs'
import * as path from 'path'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { logError, logWarn } from '../../util/log'
import { SemaSettings, SettingsScope } from '../../types/settings'

/**
 * 获取指定层级的 settings 文件路径
 * @param projectPath 项目目录，缺省用进程初始工作目录
 */
export function getSettingsPath(scope: SettingsScope, projectPath?: string): string {
  switch (scope) {
    case 'user':
      return path.join(getSemaRootDir(), 'settings.json')
    case 'project':
      return path.join(projectPath || readInitialCwd(), '.sema', 'settings.json')
    case 'local':
      return path.join(projectPath || readInitialCwd(), '.sema', 'settings.local.json')
  }
}

/**
 * 读取 settings 文件，文件不存在或解析失败返回 {}
 */
export function readSettingsFile(filePath: string): SemaSettings {
  try {
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SemaSettings
  } catch (err) {
    logError(`读取 settings 文件失败 [${filePath}]: ${err}`)
    return {}
  }
}

/**
 * 写入 settings 文件（整体写入，调用方先读后改以保留其他字段），失败抛出异常
 */
export function writeSettingsFile(filePath: string, data: SemaSettings): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    logError(`写入 settings 文件失败 [${filePath}]: ${err}`)
    throw err
  }
}

/**
 * 按层级读取 settings
 */
export function readSettings(scope: SettingsScope, projectPath?: string): SemaSettings {
  return readSettingsFile(getSettingsPath(scope, projectPath))
}

/**
 * 按层级写入 settings，失败抛出异常
 */
export function writeSettings(scope: SettingsScope, data: SemaSettings, projectPath?: string): void {
  writeSettingsFile(getSettingsPath(scope, projectPath), data)
}

// ==================== 环境变量注入 ====================

let cachedEffectiveEnv: NodeJS.ProcessEnv | null = null

/**
 * 获取子进程生效环境：process.env < 用户级 env < 项目级 env（后者覆盖前者）
 *
 * 首次调用时计算并缓存，修改 settings 后需重启 sema 生效
 */
export function getEffectiveEnv(): NodeJS.ProcessEnv {
  if (!cachedEffectiveEnv) {
    cachedEffectiveEnv = {
      ...process.env,
      ...normalizeEnv(readSettings('user').env, 'user'),
      ...normalizeEnv(readSettings('project').env, 'project'),
    }
  }
  return cachedEffectiveEnv
}

/**
 * 校验 env 字段：值仅接受字符串/数字/布尔（统一转为字符串），其余忽略并告警
 */
function normalizeEnv(env: unknown, scope: string): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value)
    } else {
      logWarn(`[settings] ${scope} 级 env.${key} 的值不是字符串，已忽略`)
    }
  }
  return result
}
