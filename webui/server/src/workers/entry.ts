/**
 * core worker 入口：一个 workingDir 一个 worker，持有 SemaCore 与会话池。
 * 缺省以 worker_threads 线程运行；SEMA_WEBUI_WORKER_MODE=process 时由 pool fork 为子进程运行。两种形态只差入参与通道：
 *   线程：入参来自 workerData，帧经 parentPort 以 JSON 字符串收发，退出由 dispose 帧触发（process.exit 只结束本线程）
 *   进程：入参来自 env，帧经 IPC 收发，退出由 disconnect 触发
 * 帧：
 *   主→子  { type:'req', id, action, sessionId?, payload } | { type:'dispose' }
 *   子→主  { type:'res', id, ok, data|error }
 *          { type:'event', sessionId, event, data }        会话级事件
 *          { type:'proc-event', event, data }              进程级事件
 *          { type:'ready' }                                 SemaCore 构造完成
 *          { type:'error', message }                        启动失败原因（随后退出）
 */
import fs from 'fs';
import { isMainThread, parentPort, threadId, workerData } from 'worker_threads';
import type { SemaCore as SemaCoreType, SemaSession } from 'sema-core';
import { SESSION_EVENTS, PROCESS_EVENTS } from '../../../shared/protocol';
import type { CommandsInfo, ExtensionsInfo, ExtSkill, ExtCommand, ExtAgent, ExtMcp, ExtHooks, ExtTool } from '../../../shared/types';
import { logErr } from '../errlog';

const IN_THREAD = !isMainThread && !!parentPort;
const send = (msg: any) => {
  if (IN_THREAD) parentPort!.postMessage(JSON.stringify(msg));
  else if (process.send) process.send(msg);
};

interface WorkerInput { workingDir: string; coreConfig: Record<string, any> }
const input: WorkerInput = IN_THREAD
  ? (workerData as WorkerInput)
  : { workingDir: process.env.SEMA_WEBUI_WORKING_DIR || '', coreConfig: JSON.parse(process.env.SEMA_WEBUI_CORE_CONFIG || '{}') };
const workingDir = input.workingDir || '';
const coreConfig = input.coreConfig || {};
/** 使用统计的产品标识：所有 worker（含配置 worker）同一标识，桌面版与网页版共用；「使用情况」页按此过滤 */
const USAGE_PRODUCT = 'sema-work-webui';

/** 启动失败：把原因发给主进程再退出（worker 的 stdout/stderr 被 pool 丢弃，只能走帧；pool 收到后记 error.log；两种形态的 process.exit 都只结束自己） */
function fail(message: string): never {
  send({ type: 'error', message });
  process.exit(2);
}
// 先校验工作目录可进入（目录被删/移入废纸篓/无权限时建会话会直接崩）。线程里不能 process.chdir，统一改为探测可读；
// 进程模式 fork 时已传 cwd，本来也不需要 chdir。core 只在加载时读一次进程 cwd 作兜底，实际工作目录由 SemaCore 配置传入
if (!workingDir || !fs.existsSync(workingDir)) fail(`工作目录不存在: ${workingDir}`);
try { fs.opendirSync(workingDir).closeSync(); } catch (e: any) {
  const hint = process.platform === 'darwin' && /EPERM|EACCES/.test(String(e?.message))
    ? '。macOS 提示：请在「系统设置 → 隐私与安全性 → 文件与文件夹」中允许你的终端访问「文稿」文件夹，或改用 ~/Documents 之外的项目目录'
    : '';
  fail(`无法进入工作目录 ${workingDir}: ${e?.message || e}${hint}`);
}
// 目录校验通过后再加载 core（不能用静态 import：会被提升到最前面）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SemaCore } = require('sema-core') as { SemaCore: typeof SemaCoreType };

const core = new SemaCore({ workingDir, ...coreConfig, logLevel: coreConfig.logLevel || 'warn', usageProduct: USAGE_PRODUCT });
const sessions = new Map<string, SemaSession>();

for (const ev of PROCESS_EVENTS) {
  core.on(ev, (data: any) => send({ type: 'proc-event', event: ev, data }));
}

function bindSession(session: SemaSession) {
  for (const ev of SESSION_EVENTS) {
    session.on(ev, (data: any) => {
      // session:ready 补上 core 侧当前长期目标（core 已在恢复历史时把 running 降为 paused），前端据此回填状态条
      if (ev === 'session:ready') data = { ...data, goal: session.getGoal() };
      send({ type: 'event', sessionId: session.sessionId, event: ev, data });
    });
  }
}

/** 模型配置回传脱敏：不把 apiKey 送到前端 */
function sanitize(data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitize);
  const out: any = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'apiKey') out[k] = v ? '***' : v;
    else out[k] = typeof v === 'object' ? sanitize(v) : v;
  }
  return out;
}

async function getCommandsInfo(): Promise<CommandsInfo> {
  const [commands, skills, agents] = await Promise.all([
    core.getCommandsInfo(true).catch(() => []),
    core.getSkillsInfo(true).catch(() => []),
    core.getAgentsInfo(true).catch(() => []),
  ]);
  return {
    commands: (commands || []).map((c: any) => ({ name: c.name, description: c.description || '', category: 'command' as const, argumentHint: Array.isArray(c.argumentHint) ? c.argumentHint.join(' ') : c.argumentHint })),
    // 禁用的 skill（settings 的 disabledSkills）不进斜杠列表
    skills: (skills || []).filter((c: any) => c.status !== false).map((c: any) => ({ name: c.name, description: c.description || '', category: 'skill' as const })),
    agents: (agents || []).filter((a: any) => a.locate !== 'builtin').map((c: any) => ({ name: c.name, description: c.description || '', category: 'agent' as const })),
  };
}

/** 界面层作用域：宿主注入（host）与 core 内置（builtin）都算「内置」 */
const uiScope = <T extends string>(s: T | 'host' | undefined, fallback: T): T | 'builtin' => s === 'host' ? 'builtin' : (s || fallback);

/** 扩展标签的技能行：内置（含宿主注入）也列，无文件不可开关；enabled 为 core 按两层 settings 并集算出的 status */
const mapSkills = (list: any[]): ExtSkill[] => (list || [])
  .map(s => ({ name: s.name, description: s.description || '', locate: uiScope(s.locate, 'user'), filePath: s.filePath, enabled: s.status !== false }));

/** 扩展标签的命令行：argumentHint 数组拼成一行 */
const mapCommands = (list: any[]): ExtCommand[] => (list || []).map(c => ({
  name: c.name, description: c.description || '', locate: uiScope(c.locate, 'user'), filePath: c.filePath,
  argumentHint: Array.isArray(c.argumentHint) ? c.argumentHint.join(' ') : c.argumentHint || undefined,
}));

/** 扩展标签的子代理行：内置的也列（标内置，无文件不可跳）；tools 非数组一律视为全部 */
const mapAgents = (list: any[]): ExtAgent[] => (list || []).map(a => ({
  name: a.name, description: a.description || '', locate: uiScope(a.locate, 'user'), filePath: a.filePath, model: a.model,
  tools: Array.isArray(a.tools) ? a.tools : '*',
}));

/** 扩展标签的 MCP 行：summary 为 stdio 命令行 / 远程 url；tools 仅在 core 已拿到 capabilities 时有值 */
const mapMcp = (list: any[]): ExtMcp[] => (list || []).map(i => ({
  name: i.config?.name,
  scope: uiScope(i.config?.scope || i.scope, 'user'),
  summary: i.config?.url ? String(i.config.url) : [i.config?.command, ...(Array.isArray(i.config?.args) ? i.config.args : [])].filter(Boolean).join(' '),
  enabled: i.status !== false,
  connectStatus: i.connectStatus || 'disconnected',
  error: i.error,
  filePath: i.filePath,
  tools: i.capabilities?.tools ? i.capabilities.tools.map((t: any) => ({ name: t.name, description: t.description })) : undefined,
  useTools: i.config?.useTools ?? null,
}));

/**
 * 「扩展」标签：当前目录 core 实际生效的规则 / 记忆 / 技能 / 命令 / 子代理 / MCP / Hooks。
 * refresh：全部重扫（MCP 先按配置重连有变动的 server）；否则技能 / 命令 / 子代理 / hooks / MCP 走缓存，
 * 规则与记忆固定重读文件（小文件且常被本轮对话改动）
 */
async function getExtensionsInfo(refresh: boolean): Promise<ExtensionsInfo> {
  if (refresh) await core.refreshMCPServerInfo().catch(() => undefined);
  const [rule, memory, skills, commands, agents, mcp, hooks] = await Promise.all([
    core.getRuleInfo(true).catch(() => null),
    core.getMemoryInfo(true).catch(() => null),
    core.getSkillsInfo(true, refresh).catch(() => []),
    core.getCommandsInfo(true, refresh).catch(() => []),
    core.getAgentsInfo(true, refresh).catch(() => []),
    core.getMCPServerInfo().catch(() => []),
    core.getHooksInfo(refresh).catch(() => null),
  ]);
  // 内置工具：当前环境可用的（如 generate_image 需配图像模型），状态按 coreConfig 的白名单（由 disabledTools 黑名单换算）
  const builtinTools: ExtTool[] = (core.getToolInfos() || []).map(tl => ({ name: tl.name, description: tl.description || '', enabled: tl.status !== 'disable' }));
  return {
    rule: rule?.filePath ? { locate: rule.locate === 'user' ? 'user' : 'project', filePath: rule.filePath, prompt: rule.prompt } : null,
    memory: memory ? { prompt: memory.prompt, FilePath: memory.FilePath, refFilePath: memory.refFilePath } : null,
    skills: mapSkills(skills),
    commands: mapCommands(commands),
    agents: mapAgents(agents),
    builtinTools,
    mcp: mapMcp(mcp),
    hooks: mapHooks(hooks),
  };
}

/** 扩展标签的钩子：core 按事件分组的视图拍平成条目列表，宿主注入的归为「内置」 */
function mapHooks(hooks: Awaited<ReturnType<typeof core.getHooksInfo>> | null): ExtHooks {
  return {
    entries: Object.entries(hooks?.events || {}).flatMap(([event, list]) => (list || []).map(h => ({
      id: h.id, enabled: h.enabled !== false,
      event, source: uiScope(h.source, 'user'), pluginName: h.pluginName, matcher: h.matcher, command: h.command, timeout: h.timeout,
      status: h.status, statusReason: h.statusReason, filePath: h.filePath,
    }))),
    parseErrors: (hooks?.parseErrors || []).map(e => ({ ...e, source: uiScope(e.source, 'user') })),
    userConfigPath: hooks?.userConfigPath || '',
    projectConfigPath: hooks?.projectConfigPath || '',
    userConfigExists: !!hooks?.userConfigExists,
    projectConfigExists: !!hooks?.projectConfigExists,
  };
}

async function handle(action: string, sessionId: string | undefined, payload: any): Promise<any> {
  const p = payload || {};
  // ---------- 进程级 ----------
  switch (action) {
    case 'core.getModelData': return core.getModelData();
    case 'core.switchModel': return core.switchModel(p.modelName);
    case 'core.addModel': return core.addModel(p.config, p.skipValidation);
    case 'core.delModel': return core.delModel(p.modelName);
    // 编辑模型：读磁盘上的完整 profile（含 apiKey）回填表单，只读不进 CORE_WRITE_ACTIONS
    case 'core.getModelProfile': return core.getModelProfile(p.provider, p.modelName);
    case 'core.applyTaskModel': return core.applyTaskModel(p.config);
    // 图像模型：modelName 传空串表示停用；getImageModelProfile 同 getModelProfile，含 apiKey 供编辑回填
    case 'core.addImageModel': return core.addImageModel(p.config);
    case 'core.delImageModel': return core.delImageModel(p.modelName);
    case 'core.switchImageModel': return core.switchImageModel(p.modelName ?? '');
    case 'core.getImageModelProfile': return core.getImageModelProfile(p.provider, p.modelName);
    case 'core.testApiConnection': return sanitize(await core.testApiConnection(p.params));
    case 'core.fetchAvailableModels': return sanitize(await core.fetchAvailableModels(p.params));
    case 'core.getToolInfos': return core.getToolInfos();
    // 生态页读实时 MCP 连接状态（内存缓存，不触发重连）；配置变更后广播刷新（仅重连有变动的 server）
    case 'core.getMCPServerInfo': return core.getMCPServerInfo();
    case 'core.refreshMCPServerInfo': await core.refreshMCPServerInfo(); return true;
    // 生态页 MCP 启停：core 写 settings + 断/连完成后才返回完整 server info，响应即权威状态
    case 'core.enableMCPServer': return core.enableMCPServer(p.name);
    case 'core.disableMCPServer': return core.disableMCPServer(p.name);
    // 生态市场装/卸 skill 后清缓存重扫（SkillsManager 有进程内缓存，否则常驻 worker 感知不到）
    case 'core.refreshSkills': await core.getSkillsInfo(true, true); return true;
    // 扩展标签启停 hook 后其他 worker 重读配置（HooksManager 有进程内缓存），下一次 hook 触发即按新状态
    case 'core.refreshHooks': await core.getHooksInfo(true); return true;
    // 浏览器控制开关（http/browserControl）：与 IDE 插件 BrowserControlManager 调用同一组 core 方法，均走配置 worker
    case 'core.getSkillsInfo': return core.getSkillsInfo(true, !!p.refresh);
    case 'core.removeSkillConf': return core.removeSkillConf(p.name);
    case 'core.addMCPServer': return core.addMCPServer(p.config);
    case 'core.removeMCPServer': return core.removeMCPServer(p.name);
    case 'core.getModelAdapter': return core.getModelAdapter(p.provider, p.modelName, p.baseURL) ?? null;
    case 'core.updateCoreConfig': core.updateCoreConfig(p.config); return true;
    // 内置工具黑名单（settings.disabledTools）：PUT /api/settings 落盘后广播到全部 worker，core 内部换算成 useTools 白名单
    case 'core.updateDisabledTools': core.updateDisabledTools(p.toolNames ?? null); return true;
    case 'core.deleteProjectHistory': core.deleteProjectHistory(p.projectPath); return true;
    case 'core.deleteSessionHistory': core.deleteSessionHistory(p.sessionId, p.projectPath); return true;
    // 使用统计：读时先落盘本 worker 的内存增量再聚合全部文件；其他 worker 最近 10 秒内的增量要等其自行落盘
    case 'core.getUsageStats': return core.getUsageStats({ product: USAGE_PRODUCT });
    case 'core.clearUsageStats': await core.clearUsageStats(USAGE_PRODUCT); return true;
    case 'core.getCommandsInfo':
    case 'session.getCommandsInfo':
      // 命令/技能/子代理清单是项目作用域（cwd/.sema + ~/.sema）：session.* 变体由该会话目录的 worker 回答；core.* 变体走配置 worker（草稿页占位）
      return getCommandsInfo();
    // 定时任务是项目级（workingDir 作用域）：以 session.* 形态路由到该会话目录的 worker，再调 core 全局接口
    case 'session.getCronTasks': return core.getCronTasks();
    // 记忆同为项目级（<workingDir>/.sema/memory）：由该目录的 worker 回答，refresh 清缓存重新加载
    case 'session.getMemoryInfo': return core.getMemoryInfo(p.refresh);
    // 「扩展」标签（项目作用域）：session.* 由该会话目录的 worker 回答；ext.* 是 project.* 变体（项目草稿页）经 server 改名后的形态
    case 'ext.getExtensionsInfo':
    case 'session.getExtensionsInfo': return getExtensionsInfo(!!p.refresh);
    // 启停写入哪层 settings 由 core 按所在层决定：项目级项写项目级，用户级 / 插件项写用户级（全局生效）；返回最新列表作权威状态
    case 'ext.toggleSkill':
    case 'session.toggleSkill': return mapSkills(await (p.enabled ? core.enableSkill(p.name) : core.disableSkill(p.name)));
    case 'ext.toggleMcp':
    case 'session.toggleMcp': return mapMcp(await (p.enabled ? core.enableMCPServer(p.name) : core.disableMCPServer(p.name)));
    case 'ext.toggleHook':
    case 'session.toggleHook': return mapHooks(await (p.enabled ? core.enableHook(p.id) : core.disableHook(p.id)));
    // 单工具开关：toolNames null = 全部可用；写入层同启停
    case 'ext.updateMcpUseTools':
    case 'session.updateMcpUseTools': return mapMcp(await core.updateMCPUseTools(p.name, p.toolNames ?? null));
    case 'session.deleteCronTask': return core.deleteCronTask(p.id);
    case 'session.enableCronTask': return core.enableCronTask(p.id);
    case 'session.disableCronTask': return core.disableCronTask(p.id);
    case 'session.create': {
      const r = await core.createSession({
        sessionId: p.sessionId, agentMode: p.agentMode, permissionLevel: p.permissionLevel,
        mainModel: p.mainModel, quickModel: p.quickModel,
      });
      if (!r.ok) throw new Error(r.error);
      sessions.set(r.session.sessionId, r.session);
      bindSession(r.session);
      return { sessionId: r.session.sessionId };
    }
    case 'session.close': {
      if (sessionId) { core.closeSession(sessionId); sessions.delete(sessionId); }
      return true;
    }
    case 'worker.stats': {
      // runningTasks：各会话运行中的后台任务数，供池在淘汰 worker 前确认（有任务则跳过）
      const runningTasks: Record<string, number> = {};
      for (const [id, s] of sessions) {
        try { runningTasks[id] = (s.getTaskList() || []).filter(t => t.status === 'running').length; }
        catch { runningTasks[id] = 0; }
      }
      // cron：worker 的"守护义务"——非持久化任务绑定会话/进程，丢了即丢；持久化任务只需临近触发时进程活着
      const cron = { active: 0, nonPersisted: {} as Record<string, number>, nextFireAt: null as number | null };
      try {
        for (const t of await core.getCronTasks()) {
          if (!t.status || !t.nextFireAt?.length) continue;
          cron.active++;
          if (cron.nextFireAt == null || t.nextFireAt[0] < cron.nextFireAt) cron.nextFireAt = t.nextFireAt[0];
          if (!t.persist && t.sessionId) cron.nonPersisted[t.sessionId] = (cron.nonPersisted[t.sessionId] || 0) + 1;
        }
      } catch { /* 视为无任务 */ }
      return { sessions: [...sessions.keys()], runningTasks, cron };
    }
  }

  // ---------- 会话级 ----------
  const s = sessionId ? sessions.get(sessionId) : undefined;
  if (!s) throw new Error(`session not found in worker: ${sessionId}`);
  switch (action) {
    case 'session.processUserInput': s.processUserInput(p.input, p.originalInput, p.attachments); return true;
    case 'session.interrupt': s.interrupt(); return true;
    case 'session.respondToToolPermission': s.respondToToolPermission(p.response); return true;
    case 'session.respondToPickOption': s.respondToPickOption(p.response); return true;
    case 'session.respondToPlanExit': s.respondToPlanExit(p.response); return true;
    case 'session.updateAgentMode': s.updateAgentMode(p.mode); return true;
    case 'session.updatePermissionLevel': s.updatePermissionLevel(p.level); return true;
    case 'session.getForkPreview': return s.getForkPreview(p.messageUuid);
    case 'session.fork': return s.fork(p.messageUuid, p.options);
    case 'session.branch': return s.branch(p.beforeMessageUuid);
    case 'session.getTaskList': return s.getTaskList();
    case 'session.stopTask': return s.stopTask(p.taskId);
    case 'session.stopAllTasks': return s.stopAllTasks();
    case 'session.getGoal': return s.getGoal();
    case 'session.updateGoal': return s.updateGoal(p.text);
    case 'session.pauseGoal': return s.pauseGoal();
    case 'session.clearGoal': s.clearGoal(); return true;
    case 'session.resumeGoal': return s.resumeGoal();
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function onFrame(msg: any) {
  if (!msg) return;
  if (msg.type === 'dispose') { void shutdown(); return; }
  if (msg.type !== 'req') return;
  try {
    const data = await handle(msg.action, msg.sessionId, msg.payload);
    send({ type: 'res', id: msg.id, ok: true, data });
  } catch (e: any) {
    send({ type: 'res', id: msg.id, ok: false, error: e?.message || String(e) });
  }
}

/** 优雅退出：dispose 卡死兜底 3 秒后强制结束（unref：正常路径下不阻止退出）；线程模式 process.exit 只结束本线程 */
async function shutdown() {
  const t = setTimeout(() => process.exit(0), 3000);
  t.unref?.();
  try { await core.dispose(); } catch { /* ignore */ }
  process.exit(0);
}

if (IN_THREAD) {
  parentPort!.on('message', (raw: unknown) => { void onFrame(typeof raw === 'string' ? JSON.parse(raw) : raw); });
} else {
  process.on('message', (msg: any) => { void onFrame(msg); });
  // 主进程退出或主动 kill：IPC 断开即优雅关闭（主进程被 SIGKILL 时同样触发）
  process.on('disconnect', () => { void shutdown(); });
}

send({ type: 'ready', pid: process.pid, threadId: IN_THREAD ? threadId : undefined, workingDir });

// 运行期兜底（ready 之后才装：启动阶段的同步异常仍按原样结束 worker，让 pool 的 ready 失败）：
// core 内漏掉的异步异常（子进程 error 事件无监听、未处理的 rejection 等）在线程 / 进程里都会直接结束 worker（code 1），
// 这里改为只记 error.log 不退出。同一条错误 60 秒内只记第一次，循环触发时不刷屏；stdout/stderr 被 pool 丢弃，只能直接写文件
const recentErrors = new Map<string, number>();
function trap(kind: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const key = `${kind}:${msg.split('\n', 1)[0].slice(0, 160)}`;
  const now = Date.now();
  if (now - (recentErrors.get(key) || 0) < 60_000) return;
  if (recentErrors.size > 200) recentErrors.clear();
  recentErrors.set(key, now);
  logErr('worker', `${kind} dir=${workingDir}:`, err);
}
process.on('uncaughtException', (err) => trap('uncaughtException', err));
process.on('unhandledRejection', (reason) => trap('unhandledRejection', reason));
