/**
 * 英文文案：须覆盖 zh.ts 的全部 key（satisfies 保证缺 key 编译报错）
 */
import type { I18nKey } from './zh'

export const en = {
  // ---- 权限面板 ----
  'permission.agree': 'Allow',
  'permission.refuse': 'Deny',
  'permission.approve': 'Approve',
  'permission.allowShellPrefix': "Allow, and don't ask again for commands starting with `{prefix}` in this project",
  'permission.allowShellExact': "Allow, and don't ask again for `{command}` in this project",
  'permission.allowShellThis': "Allow, and don't ask again for this command in this project",
  'permission.allowEdit': "Allow, and don't ask again for file edits in this session",
  'permission.allowReadDir': "Allow, and don't ask again for reads under {dir} in this session",
  'permission.allowSkill': "Allow, and don't ask again for the {skill} skill in this project",
  'permission.allowSkillAny': "Allow, and don't ask again for the Skill tool in this project",
  'permission.allowMcp': "Allow, and don't ask again for {tool} in this project",
  'permission.allowFetchDomain': "Allow, and don't ask again for {domain} in this project",
  'permission.allowFetchThis': "Allow, and don't ask again for this domain in this project",
  'permission.allowGeneric': "Approve, and don't ask again for {tool} in this project",
  'permission.autoApproved': 'Allowed by model check · auto mode',

  // ---- Plan 模式 ----
  'plan.startEditing': 'Start coding now',
  'plan.clearContextAndStart': 'Reset context and start coding',
  'plan.implementPrompt': 'Implement the following plan:',

  // ---- 会话错误 ----
  'error.unknown': 'Unknown error',
  'error.apiAuth': 'API authentication failed. Check that the API key is correct',
  'error.apiForbidden': "API permission denied. Check the API key's permissions",
  'error.apiRateLimit': 'API rate limit exceeded. Try again later',
  'error.apiParse': 'Malformed API response. Unable to parse data',
  'error.network': 'Network error. Check your connection',
  'error.contextTooLong': 'Context length exceeded',
  'error.truncatedToolArgs': "Output hit the max output tokens and tool arguments were truncated. Try raising the model's max output tokens",
  'error.truncatedContent': "Output hit the max output tokens and the content was truncated. Try raising the model's max output tokens",
  'error.emptyResponse': 'The API returned an empty response. Retry once; if it keeps failing, try again later.',
  'error.noModels': 'No model configured. Add a model first',
  'error.modelResolve': 'Failed to resolve model: {pointer}',
  'error.modelConfLoad': 'Failed to load the model config file. Try deleting it and adding the model again',
  'error.compactFailed': 'Compaction failed: {error}',
  'error.compactEmptyHistory': 'Empty history, skip compact',
  'error.compactNoSummary': 'Compact did not produce a valid summary: {kind}',
  'error.streamTimeout': 'LLM streaming request timed out ({minutes}min)',
  'error.streamIdleTimeout': 'LLM streaming request idle timeout ({minutes}min without new data)',
  'error.toolValidation': 'Tool input validation failed',
  'error.promptBlockedByHook': 'Input blocked by the UserPromptSubmit hook',

  // ---- 会话管理 ----
  'session.busyRewind': 'Session is busy. Wait until it is idle before rewinding',
  'session.busyFork': 'Session is busy. Wait until it is idle before forking',
  'session.msgNotFound': 'Message not found: {uuid}',
  'session.notRewindable': 'This message is not a rewindable user input: {uuid}',
  'session.notForkable': 'This message is not a forkable user input: {uuid}',
  'session.noForkHistory': 'No history to fork',
  'session.limitReached': 'Session limit reached ({max}). Close an existing session first',
  'session.initFailed': 'Session initialization failed: {error}',

  // ---- Hook 通知 ----
  'hook.timeout': 'Hook timed out ({seconds}s) and was terminated: {command}',
  'hook.blockIgnored': "The {event} event cannot be blocked; the hook's block output was ignored: {command}",

  // ---- 模型配置 ----
  'model.testSuccess': '✓ Connection test passed. The API configuration is correct.',
  'model.testNoYes': '✗ Unexpected API response, no YES marker found. Response: {response}',
  'model.testHttpError': '✗ API returned an error ({status}): {body}',
  'model.connectFailed': 'Connection failed: {error}',
  'model.responseTimeout': 'Model response timed out. Check the network and model service',
  'model.listEmpty': 'The model list is empty',
  'model.listFailed': 'Failed to fetch the model list ({status})',
  'model.testFailed': 'API connection test failed: {error}',
  'model.debugCommand': 'Debug command:',
  'model.validateError': 'Error during API validation: {error}',
  'model.invalidProvider': 'Invalid provider name: {error}',
  'model.providerNameLength': 'Must be 2–20 characters',
  'model.providerNameFormat': 'Only lowercase letters, digits and hyphens; must start with a letter and not end with a hyphen',
  'model.invalidName': 'Invalid model name: {name}. Expected "modelName[provider]"',
  'model.notFound': 'Model not found: {name}',
  'model.inUseByPointer': 'Model is in use by pointer(s) {pointers} and cannot be deleted',
  'model.mainNotFound': 'main model not found: {name}',
  'model.quickNotFound': 'quick model not found: {name}',
  'model.saveFailed': 'Failed to save model config',

  // ---- MCP ----
  'mcp.connectTimeout': 'Connection timed out ({seconds}s)',
  'mcp.capabilitiesTimeout': 'Fetching capabilities timed out ({seconds}s)',
  'mcp.closeTimeout': 'Client close timed out',
  'mcp.notConnected': 'MCP server [{name}] is not connected',
  'mcp.stdioNeedsCommand': 'stdio transport requires "command"',
  'mcp.sseNeedsUrl': 'sse transport requires "url"',
  'mcp.httpNeedsUrl': 'http transport requires "url"',
  'mcp.unsupportedTransport': 'Unsupported transport: {transport}',

  // ---- 插件市场 ----
  'plugin.gitCloneFailed': 'git clone failed [{repo}]: {stderr}',
  'plugin.gitPullFailed': 'git pull failed [{dir}]: {stderr}',
  'plugin.marketplaceNameFromRepo': 'Cannot read the marketplace name from {repo}. Make sure marketplace.json exists',
  'plugin.marketplaceNameMissing': 'Cannot read the marketplace name. Make sure marketplace.json exists',
  'plugin.dirNotFound': 'Directory not found: {dir}',
  'plugin.marketplaceNotFound': 'Marketplace not found: {name}',
  'plugin.marketplaceNotGithub': 'Marketplace [{name}] is not a GitHub source and cannot be updated',
  'plugin.marketplaceUnreadable': 'Cannot read marketplace info: {name}',
  'plugin.notInMarketplace': 'Plugin [{plugin}] not found in marketplace [{name}]',
  'plugin.gitClonePluginFailed': 'git clone of plugin failed [{url}]: {stderr}',

  // ---- Agent / Command 管理 ----
  'agent.addMissingFields': 'Failed to add agent: missing required field name, prompt or description',
  'agent.addInvalidLocate': "Failed to add agent: locate must be 'project' or 'user'",
  'command.addMissingFields': 'Failed to add command: missing required field name, description or prompt',
  'command.addInvalidLocate': "Failed to add command: locate must be 'project' or 'user'",
} as const satisfies Record<I18nKey, string>
