/**
 * 中文文案（基准语言）：key 集合以本文件为准，其他语言须覆盖全部 key
 */
export const zh = {
  // ---- 权限面板 ----
  'permission.agree': '确认',
  'permission.refuse': '拒绝',
  'permission.approve': '同意',
  'permission.allowShellPrefix': '确认，本项目不再询问 `{prefix}` 开头的命令',
  'permission.allowShellExact': '确认，本项目不再询问 `{command}` 命令',
  'permission.allowShellThis': '确认，本项目不再询问此命令',
  'permission.allowEdit': '确认, 本次会话不再询问文件编辑',
  'permission.allowReadDir': '确认，本次会话不再询问 {dir} 目录下的读取',
  'permission.allowSkill': '确认，本项目不再询问 {skill} Skill',
  'permission.allowSkillAny': '确认，本项目不再询问 Skill 工具',
  'permission.allowMcp': '确认，本项目不再询问 {tool} 工具',
  'permission.allowFetchDomain': '确认，本项目不再询问 {domain} 域名',
  'permission.allowFetchThis': '确认，本项目不再询问此域名',
  'permission.allowGeneric': '同意，本项目不再询问 {tool} 权限',
  'permission.autoApproved': '模型安全判断放行 · 自动模式',

  // ---- Plan 模式 ----
  'plan.startEditing': '直接开始编码',
  'plan.clearContextAndStart': '重置上下文后开始编码',
  'plan.implementPrompt': '按照以下计划进行实现：',

  // ---- 会话错误（session:error 等） ----
  'error.unknown': '未知错误',
  'error.apiAuth': 'API认证失败，请检查API密钥是否正确',
  'error.apiForbidden': 'API权限不足，请检查API密钥权限',
  'error.apiRateLimit': 'API调用频率超限，请稍后重试',
  'error.apiParse': 'API响应格式错误，无法解析数据',
  'error.network': '网络连接错误，请检查网络连接',
  'error.contextTooLong': '上下文长度超出限制',
  'error.truncatedToolArgs': 'API输出超长导致工具参数截断，可尝试调整模型最大输出token',
  'error.truncatedContent': 'API输出超长导致内容截断，可尝试调整模型最大输出token',
  'error.emptyResponse': 'API返回空响应：模型暂时没有返回有效内容，请重试一次。若多次重试仍失败，请稍后再试。',
  'error.noModels': '未配置任何模型，请先添加模型配置',
  'error.modelResolve': '解析模型失败: {pointer}',
  'error.modelConfLoad': '模型配置文件加载失败，可尝试删除模型配置文件后重新添加模型',
  'error.compactFailed': '压缩失败: {error}',
  'error.compactEmptyHistory': '历史为空，跳过压缩',
  'error.compactNoSummary': '压缩未生成有效摘要: {kind}',
  'error.streamTimeout': 'LLM流式请求超时({minutes}min)',
  'error.streamIdleTimeout': 'LLM流式请求空闲超时({minutes}min无新数据)',
  'error.toolValidation': '工具调用验证失败',
  'error.promptBlockedByHook': '输入被 UserPromptSubmit hook 拦截',

  // ---- 会话管理 ----
  'session.busyRewind': '会话忙，请等待空闲后再撤销',
  'session.busyFork': '会话忙，请等待空闲后再分支',
  'session.msgNotFound': '未找到消息: {uuid}',
  'session.notRewindable': '该消息不是可回退的用户输入: {uuid}',
  'session.notForkable': '该消息不是可分支的用户输入: {uuid}',
  'session.noForkHistory': '没有可分支的历史',
  'session.limitReached': '已达到会话数量上限 ({max})，请先关闭已有会话',
  'session.initFailed': '会话初始化失败: {error}',

  // ---- Hook 通知 ----
  'hook.timeout': 'hook 执行超时（{seconds}s）已终止: {command}',
  'hook.blockIgnored': '{event} 事件不支持阻断，hook 的 block 输出已忽略: {command}',

  // ---- 模型配置 ----
  'model.testSuccess': '✓ 连接测试成功！API 配置正确。',
  'model.testNoYes': '✗ API 响应异常，未找到 YES 标识。响应: {response}',
  'model.testHttpError': '✗ API 返回错误 ({status}): {body}',
  'model.connectFailed': '连接失败: {error}',
  'model.responseTimeout': '模型响应超时，请检查网络与模型服务状态',
  'model.listEmpty': '获取模型列表为空',
  'model.listFailed': '获取模型列表失败 ({status})',
  'model.testFailed': 'API连接测试失败: {error}',
  'model.debugCommand': '调试命令：',
  'model.validateError': 'API校验过程中出现错误: {error}',
  'model.invalidProvider': '服务商名称不合法: {error}',
  'model.providerNameLength': '长度需为 2~20 个字符',
  'model.providerNameFormat': '仅支持小写字母、数字和短横线(-)，需以字母开头且不能以短横线结尾',
  'model.invalidName': '模型名称格式错误: {name}. 期望格式: "modelName[provider]"',
  'model.notFound': '模型不存在: {name}',
  'model.inUseByPointer': '模型正在被模型指针使用，无法删除: {pointers}',
  'model.mainNotFound': 'main模型不存在: {name}',
  'model.quickNotFound': 'quick模型不存在: {name}',
  'model.saveFailed': '保存模型配置失败',

  // ---- MCP ----
  'mcp.connectTimeout': '连接超时 ({seconds}s)',
  'mcp.capabilitiesTimeout': '获取能力超时 ({seconds}s)',
  'mcp.closeTimeout': '关闭客户端超时',
  'mcp.notConnected': 'MCP Server [{name}] 未连接',
  'mcp.stdioNeedsCommand': 'stdio 传输需要配置 command',
  'mcp.sseNeedsUrl': 'sse 传输需要配置 url',
  'mcp.httpNeedsUrl': 'http 传输需要配置 url',
  'mcp.unsupportedTransport': '不支持的传输类型: {transport}',

  // ---- 插件市场 ----
  'plugin.gitCloneFailed': 'git clone 失败 [{repo}]: {stderr}',
  'plugin.gitPullFailed': 'git pull 失败 [{dir}]: {stderr}',
  'plugin.marketplaceNameFromRepo': '无法从 {repo} 获取市场名称，请确认 marketplace.json 存在',
  'plugin.marketplaceNameMissing': '无法获取市场名称，请确认 marketplace.json 存在',
  'plugin.dirNotFound': '目录不存在: {dir}',
  'plugin.marketplaceNotFound': '市场不存在: {name}',
  'plugin.marketplaceNotGithub': '市场 [{name}] 不是 github 来源，无法更新',
  'plugin.marketplaceUnreadable': '无法读取市场信息: {name}',
  'plugin.notInMarketplace': '插件 [{plugin}] 不存在于市场 [{name}]',
  'plugin.gitClonePluginFailed': 'git clone 插件失败 [{url}]: {stderr}',

  // ---- Agent / Command 管理 ----
  'agent.addMissingFields': '添加 Agent 失败: 缺少必需字段 name、prompt 或 description',
  'agent.addInvalidLocate': "添加 Agent 失败: locate 必须为 'project' 或 'user'",
  'command.addMissingFields': '添加 Command 失败: 缺少必需字段 name、description 或 prompt',
  'command.addInvalidLocate': "添加 Command 失败: locate 必须为 'project' 或 'user'",
} as const

export type I18nKey = keyof typeof zh
