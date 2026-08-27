/**
 * core worker 子进程入口：一个 workingDir 一个进程，持有 SemaCore 与会话池。
 * 与主进程通过 IPC 交换帧：
 *   主→子  { type:'req', id, action, sessionId?, payload }
 *   子→主  { type:'res', id, ok, data|error }
 *          { type:'event', sessionId, event, data }        会话级事件
 *          { type:'proc-event', event, data }              进程级事件
 *          { type:'ready' }                                 SemaCore 构造完成
 */
import fs from 'fs';
import type { SemaCore as SemaCoreType, SemaSession } from 'sema-core';
import { SESSION_EVENTS, PROCESS_EVENTS } from '../../../shared/protocol';
import type { CommandsInfo } from '../../../shared/types';

const send = (msg: any) => { if (process.send) process.send(msg); };

const workingDir = process.env.SEMA_WEBUI_WORKING_DIR || '';
const coreConfig = JSON.parse(process.env.SEMA_WEBUI_CORE_CONFIG || '{}');

// 先校验工作目录：core 在模块加载时就会调用 process.cwd()，cwd 不可用（目录被删/移入废纸篓/无权限）会直接崩溃
if (!workingDir || !fs.existsSync(workingDir)) {
  console.error(`[worker] 工作目录不存在: ${workingDir}`);
  process.exit(2);
}
try { process.chdir(workingDir); process.cwd(); } catch (e: any) {
  console.error(`[worker] 无法进入工作目录 ${workingDir}: ${e?.message || e}`);
  if (process.platform === 'darwin' && /EPERM|EACCES/.test(String(e?.message))) {
    console.error('[worker] macOS 提示：请在「系统设置 → 隐私与安全性 → 文件与文件夹」中允许你的终端访问「文稿」文件夹，或改用 ~/Documents 之外的项目目录');
  }
  process.exit(2);
}
// 目录校验通过后再加载 core（不能用静态 import：会被提升到最前面）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SemaCore } = require('sema-core') as { SemaCore: typeof SemaCoreType };

const core = new SemaCore({ workingDir, ...coreConfig, logLevel: coreConfig.logLevel || 'warn' });
const sessions = new Map<string, SemaSession>();

for (const ev of PROCESS_EVENTS) {
  core.on(ev, (data: any) => send({ type: 'proc-event', event: ev, data }));
}

function bindSession(session: SemaSession) {
  for (const ev of SESSION_EVENTS) {
    session.on(ev, (data: any) => send({ type: 'event', sessionId: session.sessionId, event: ev, data }));
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

async function handle(action: string, sessionId: string | undefined, payload: any): Promise<any> {
  const p = payload || {};
  // ---------- 进程级 ----------
  switch (action) {
    case 'core.getModelData': return core.getModelData();
    case 'core.switchModel': return core.switchModel(p.modelName);
    case 'core.addModel': return core.addModel(p.config, p.skipValidation);
    case 'core.delModel': return core.delModel(p.modelName);
    case 'core.applyTaskModel': return core.applyTaskModel(p.config);
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
    case 'core.getModelAdapter': return core.getModelAdapter(p.provider, p.modelName, p.baseURL) ?? null;
    case 'core.updateCoreConfig': core.updateCoreConfig(p.config); return true;
    case 'core.deleteProjectHistory': core.deleteProjectHistory(p.projectPath); return true;
    case 'core.deleteSessionHistory': core.deleteSessionHistory(p.sessionId, p.projectPath); return true;
    case 'core.getCommandsInfo':
    case 'session.getCommandsInfo':
      // 命令/技能/子代理清单是项目作用域（cwd/.sema + ~/.sema）：session.* 变体由该会话目录的 worker 回答；core.* 变体走配置 worker（草稿页占位）
      return getCommandsInfo();
    // 定时任务是项目级（workingDir 作用域）：以 session.* 形态路由到该会话目录的 worker，再调 core 全局接口
    case 'session.getCronTasks': return core.getCronTasks();
    // 记忆同为项目级（<workingDir>/.sema/memory）：由该目录的 worker 回答，refresh 清缓存重新加载
    case 'session.getMemoryInfo': return core.getMemoryInfo(p.refresh);
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
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

process.on('message', async (msg: any) => {
  if (!msg || msg.type !== 'req') return;
  try {
    const data = await handle(msg.action, msg.sessionId, msg.payload);
    send({ type: 'res', id: msg.id, ok: true, data });
  } catch (e: any) {
    send({ type: 'res', id: msg.id, ok: false, error: e?.message || String(e) });
  }
});

process.on('disconnect', async () => {
  // dispose 卡死兜底：3 秒后强制退出（unref：正常路径下不阻止进程结束）
  const t = setTimeout(() => process.exit(0), 3000);
  t.unref?.();
  try { await core.dispose(); } catch { /* ignore */ }
  process.exit(0);
});

send({ type: 'ready', pid: process.pid, workingDir });
