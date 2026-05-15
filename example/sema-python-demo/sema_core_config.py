from dataclasses import dataclass
from typing import List, Optional


@dataclass
class SemaCoreConfig:
    """SemaCore 初始化配置，对应 sema-core 的 SemaCoreConfig 接口"""

    working_dir: Optional[str] = None
    """ Agent 操作的目标代码仓库绝对路径 """

    log_level: Optional[str] = None
    """ 日志级别，默认 info """

    stream: Optional[bool] = None
    """ 流式输出 AI 响应，默认 True """

    thinking: Optional[bool] = None
    """ 输出思考过程，默认 False """

    system_prompt: Optional[str] = None
    """ 系统提示词 """

    custom_rules: Optional[str] = None
    """ 用户自定义规则 """

    skip_file_edit_permission: Optional[bool] = None
    """ 跳过文件编辑权限检查，默认 False """

    skip_shell_exec_permission: Optional[bool] = None
    """ 跳过 Shell 执行权限检查，默认 False """

    skip_skill_permission: Optional[bool] = None
    """ 跳过 Skill 权限检查，默认 False """

    skip_mcp_tool_permission: Optional[bool] = None
    """ 跳过 MCP 工具权限检查，默认 False """

    skip_fetch_url_permission: Optional[bool] = None
    """ 跳过 fetch_url 权限检查，默认 False """

    enable_llm_cache: Optional[bool] = None
    """ 开启 LLM 缓存，默认 False，建议只在重复测试时使用 """

    use_tools: Optional[List[str]] = None
    """ 限定使用的工具列表（白名单），None 表示使用所有工具 """

    disabled_tools: Optional[List[str]] = None
    """ 禁用的工具列表（黑名单），None 表示不禁用。与 use_tools 同时传时优先生效 """

    agent_mode: Optional[str] = None
    """ Agent 模式：Agent 或 Plan，默认 Agent """

    disable_topic_detection: Optional[bool] = None
    """ 是否禁用话题检测，默认 False """

    disable_background_tasks: Optional[bool] = None
    """ 是否禁止后台任务，默认 False """

    def to_dict(self) -> dict:
        mapping = {
            "workingDir":              self.working_dir,
            "logLevel":                self.log_level,
            "stream":                  self.stream,
            "thinking":                self.thinking,
            "systemPrompt":            self.system_prompt,
            "customRules":             self.custom_rules,
            "skipFileEditPermission":  self.skip_file_edit_permission,
            "skipShellExecPermission": self.skip_shell_exec_permission,
            "skipSkillPermission":     self.skip_skill_permission,
            "skipMCPToolPermission":   self.skip_mcp_tool_permission,
            "skipFetchUrlPermission":  self.skip_fetch_url_permission,
            "enableLLMCache":          self.enable_llm_cache,
            "useTools":                self.use_tools,
            "disabledTools":           self.disabled_tools,
            "agentMode":               self.agent_mode,
            "disableTopicDetection":   self.disable_topic_detection,
            "disableBackgroundTasks":  self.disable_background_tasks,
        }
        return {k: v for k, v in mapping.items() if v is not None}
