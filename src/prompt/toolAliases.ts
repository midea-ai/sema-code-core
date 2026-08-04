/**
 * 工具名别名映射
 *
 * 用于兼容其他代码助手（如 Claude Code、Codex、Cursor、OpenHands、Cline、Windsurf、Trae）的工具名，加载自定义 agent 时把
 * 别名规范化为内置工具名。仅覆盖语义对齐度高的搜索、文件读写 和 终端
 * 等参数差异较大的工具不做映射，避免出现"名字对得上、参数对不上"的隐患。
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
