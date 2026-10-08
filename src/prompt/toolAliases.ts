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

// ==================== 运行时工具调用兜底（应对模型幻觉） ====================
//
// 部分模型受训练数据影响，会把其他产品的工具名/参数名当成本工具的（如把 view_file 写成 read_file、
// 把 write_file 的 file_content 写成 content）。这里在模型响应进入执行链路前做一次纯配置驱动的
// 规范化，省掉一次报错往返。只做精确匹配；工具名沿用上面的 ALIAS_SOURCE，参数名用下表。

// 参数别名：内置工具名 → { 规范参数名: [模型可能幻觉出的参数名...] }
// 只收录语义一致的键；run_shell（command）、search_files / search_content（pattern）与主流产品同名，无需映射
const PARAM_ALIAS_SOURCE: Record<string, Record<string, string[]>> = {
  [TOOL_NAME_VIEW_FILE]: {
    file_path: ['path', 'filePath'],
    start_line: ['offset'],
    max_lines: ['limit'],
  },
  [TOOL_NAME_WRITE_FILE]: {
    file_path: ['path', 'filePath'],
    file_content: ['content', 'contents', 'file_text'],
  },
  [TOOL_NAME_PATCH_FILE]: {
    file_path: ['path', 'filePath'],
    search_text: ['old_string', 'old_str', 'old_text', 'oldText'],
    replacement: ['new_string', 'new_str', 'new_text', 'newText'],
    global_replace: ['replace_all', 'replaceAll'],
  },
}

// 内置工具名 → Map<幻觉参数名, 规范参数名>
const PARAM_ALIAS_LOOKUP: Map<string, Map<string, string>> = new Map(
  Object.entries(PARAM_ALIAS_SOURCE).map(([toolName, params]) => [
    toolName,
    new Map(
      Object.entries(params).flatMap(([canonical, aliases]) =>
        aliases.map(alias => [alias, canonical] as const)
      )
    ),
  ])
)

export interface ToolUseFixup {
  /** 工具名修正：原名 -> 规范名 */
  name?: { from: string; to: string }
  /** 参数名修正：原键 -> 规范键 */
  params: Array<{ from: string; to: string }>
}

/**
 * 对模型返回的单个 tool_use 块做规范化（原地修改），返回修正记录；无修正返回 null。
 *
 * 守卫（保证不影响正常调用）：
 * - 工具名仅在「原名不在当前工具列表、规范名在当前工具列表」时改写，MCP 工具与受限工具集不受影响
 * - 参数仅在「规范键缺失、幻觉键存在」时搬移，搬完删除幻觉键（patch_file 是 strictObject，多余键会报错）
 * - 改写后仍走原有 zod 校验，最坏情况与不改写时相同
 */
export function normalizeToolUseBlock(
  block: { name: string; input: unknown },
  availableToolNames: ReadonlySet<string>,
): ToolUseFixup | null {
  const fixup: ToolUseFixup = { params: [] }

  if (!availableToolNames.has(block.name)) {
    const canonical = ALIAS_LOOKUP.get(block.name)
    if (canonical && availableToolNames.has(canonical)) {
      fixup.name = { from: block.name, to: canonical }
      block.name = canonical
    }
  }

  const paramLookup = PARAM_ALIAS_LOOKUP.get(block.name)
  const input = block.input
  if (paramLookup && input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const [alias, canonical] of paramLookup) {
      if (alias in record && !(canonical in record)) {
        record[canonical] = record[alias]
        delete record[alias]
        fixup.params.push({ from: alias, to: canonical })
      }
    }
  }

  return fixup.name || fixup.params.length ? fixup : null
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
