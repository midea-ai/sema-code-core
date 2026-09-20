/**
 * 外部产品兼容别名映射（工具名、插件根目录变量）
 *
 * 用于兼容其他代码助手（如 Claude Code、Codex、Cursor、OpenHands、Cline、Windsurf、Trae）的工具名，加载自定义 agent 时把
 * 别名规范化为内置工具名。仅覆盖语义对齐度高的搜索、文件读写 和 终端
 * 等参数差异较大的工具不做映射，避免出现"名字对得上、参数对不上"的隐患。
 *
 * 插件根目录变量别名见文件末尾：使按其他产品插件规范编写的 hooks / .mcp.json 无需改动即可定位自带脚本。
 */

import {
  TOOL_NAME_FETCH_URL,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_SEARCH_CONTENT,
  TOOL_NAME_SEARCH_FILES,
  TOOL_NAME_SUB_AGENT,
  TOOL_NAME_VIEW_FILE,
  TOOL_NAME_WRITE_FILE,
} from './tool'

const ALIAS_SOURCE: Record<string, string[]> = {
  [TOOL_NAME_VIEW_FILE]: ['Read', 'read_file', 'view_files'],
  [TOOL_NAME_WRITE_FILE]: ['Write', 'write_to_file'],
  [TOOL_NAME_PATCH_FILE]: [
    'Edit',
    'replace_in_file',
    'str_replace_based_edit_tool',
    'str_replace_editor',
  ],
  [TOOL_NAME_RUN_SHELL]: [
    'Bash',
    'run_terminal_cmd',
    'run_command',
    'execute_command',
    'shell',
    'execute_bash',
  ],
  [TOOL_NAME_SEARCH_FILES]: ['Glob', 'file_search', 'find_by_name'],
  [TOOL_NAME_SEARCH_CONTENT]: ['Grep', 'grep_search', 'search_by_regex'],
}

const ALIAS_LOOKUP: Map<string, string> = new Map(
  Object.entries(ALIAS_SOURCE).flatMap(([canonical, aliases]) =>
    aliases.map(alias => [alias, canonical] as const)
  )
)

/**
 * 把外部工具名规范化为内置工具名；未命中则原样返回。
 */
export function normalizeToolName(name: string): string {
  return ALIAS_LOOKUP.get(name) ?? name
}

/**
 * 是否命中别名（用于决定是否打 debug 日志）
 */
export function isToolAlias(name: string): boolean {
  return ALIAS_LOOKUP.has(name)
}

// 内置工具名 → 通用工具名（正向表，仅供 hook 层的 tool_name 输出与 matcher 匹配使用；
// 不进 ALIAS_LOOKUP 反向表，避免影响 agent 加载时的别名规范化）
const GENERIC_NAME_MAP: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ALIAS_SOURCE).map(([canonical, aliases]) => [canonical, aliases[0]])
  ),
  [TOOL_NAME_FETCH_URL]: 'WebFetch',
  [TOOL_NAME_SUB_AGENT]: 'Task',
}

/**
 * 把内置工具名映射为通用工具名；无对应者（含 MCP 工具 mcp__server__tool）原样返回。
 */
export function toGenericToolName(name: string): string {
  return GENERIC_NAME_MAP[name] ?? name
}

// ==================== 插件根目录变量别名 ====================

// 规范变量名：插件的 hooks/hooks.json 与 .mcp.json 里用 ${SEMA_PLUGIN_ROOT} 引用插件安装目录
export const PLUGIN_ROOT_VAR = 'SEMA_PLUGIN_ROOT'

// 其他代码助手的插件规范里表示"插件安装目录"的变量名，展开时与规范名等价
const PLUGIN_ROOT_VAR_ALIASES = ['CLAUDE_PLUGIN_ROOT']

const PLUGIN_ROOT_VARS: ReadonlySet<string> = new Set([PLUGIN_ROOT_VAR, ...PLUGIN_ROOT_VAR_ALIASES])

/**
 * 是否为插件根目录变量（规范名或别名）
 */
export function isPluginRootVar(name: string): boolean {
  return PLUGIN_ROOT_VARS.has(name)
}

/**
 * 把文本中的 ${插件根目录变量} 字面量替换为实际目录；其余 ${VAR} 不动（hook 命令交给 shell 展开）。
 */
export function expandPluginRoot(text: string, root: string): string {
  let out = text
  for (const name of PLUGIN_ROOT_VARS) {
    out = out.split('${' + name + '}').join(root)
  }
  return out
}
