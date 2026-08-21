/**
 * 协议常量：会话事件清单 / action 表。
 * 事件名与 sema-core/event 一一对应，服务端按清单逐个 session.on 转发。
 */

export const SESSION_EVENTS = [
  'session:ready', 'session:error', 'session:interrupted', 'session:cleared',
  'state:update',
  'input:received', 'input:processing',
  'message:text:chunk', 'message:thinking:chunk', 'message:complete',
  'tool:permission:request', 'tool:permission:auto',
  'tool:execution:complete', 'tool:execution:chunk', 'tool:execution:error',
  'task:agent:start', 'task:agent:end', 'task:start', 'task:end', 'task:transfer',
  'todos:update', 'topic:update',
  'pick:option:request', 'plan:exit:request', 'plan:implement',
  'compact:exec', 'compact:micro',
  'conversation:usage', 'file:reference',
  'permissionLevel:update', 'quickchat:response',
  'hook:notice',
] as const;

export const PROCESS_EVENTS = ['cron:update', 'mcp:server:status'] as const;

/** 服务端合成事件（进程级帧，无 sessionId） */
export const SERVER_EVENTS = {
  registryUpdate: 'registry:update',
  modelUpdate: 'model:update',
  settingsUpdate: 'settings:update',
  /** 会话事件缓冲不足，前端需重新拉快照 */
  sessionResync: 'session:resync',
} as const;

/** 进程级（core.*）action：直接映射 SemaCore 同名方法 */
export const CORE_ACTIONS = [
  'core.getModelData',
  'core.switchModel',
  'core.addModel',
  'core.delModel',
  'core.applyTaskModel',
  'core.testApiConnection',
  'core.fetchAvailableModels',
  'core.getToolInfos',
  'core.getModelAdapter',
  'core.getCommandsInfo',
] as const;

/** 会话级（session.*）action：映射 SemaSession 同名方法 */
export const SESSION_ACTIONS = [
  'session.subscribe',
  'session.unsubscribe',
  'session.warm',
  'session.processUserInput',
  'session.interrupt',
  'session.respondToToolPermission',
  'session.respondToPickOption',
  'session.respondToPlanExit',
  'session.updateAgentMode',
  'session.updatePermissionLevel',
  'session.getForkPreview',
  'session.fork',
  'session.getCommandsInfo',
  'session.getCronTasks',
  'session.deleteCronTask',
  'session.enableCronTask',
  'session.disableCronTask',
] as const;

export const MAIN_AGENT_ID = 'main';

/** 编辑类工具：其执行结果汇入"文件改动卡片" */
export const FILE_EDIT_TOOLS = new Set(['write_file', 'patch_file', 'edit_notebook']);
export const SHELL_TOOL = 'run_shell';
/** 定时任务增删工具：成功结果落成"定时任务卡片"（list_crons 只读，保留普通工具行） */
export const CRON_TOOLS = new Set(['create_cron', 'del_cron']);
