/**
 * .sema/settings.json 文件结构（各模块共用，允许扩展字段）
 *
 * 分层：用户级 ~/.sema/settings.json < 项目级 <project>/.sema/settings.json
 */
export interface SemaSettings {
  /** 注入到终端执行/后台任务/hooks 子进程的环境变量，项目级覆盖用户级；修改后重启 sema 生效 */
  env?: Record<string, string>
  /** 禁用的 MCP Server 名称列表（用户级 + 项目级取并集生效） */
  disabledMcpServers?: string[]
  /** 禁用的 Skill 名称列表（用户级 + 项目级取并集生效；插件 Skill 用 插件名:skill名 全名） */
  disabledSkills?: string[]
  /** MCP Server 启用的工具列表 */
  enabledMcpServerUseTools?: Record<string, string[]>
  /** 禁用的定时任务 id 列表 */
  disabledCronTasks?: string[]
  /** 插件启用状态 */
  enabledPlugins?: { [pluginKey: string]: boolean }
  [key: string]: any
}

/** settings 文件分层（local 仅插件启用状态历史使用，env 不读取该层） */
export type SettingsScope = 'user' | 'project' | 'local'
