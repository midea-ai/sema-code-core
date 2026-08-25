import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import * as fs from 'fs';
import { SemaCoreManager } from './core';
import { SessionBinder } from './session';
import { ensureRg } from './rg';

const PORT = parseInt(process.env.SEMA_BRIDGE_PORT || '3766');
const WORKING_DIR = process.env.SEMA_WORKING_DIR || process.cwd();

// 桥协议版本：init ack 携带，各语言 SDK 握手校验（协议不兼容变更时 +1，并同步各 SDK 常量与 manifest）
const PROTOCOL_VERSION = 1;

// 相对源码定位 proto（唯一源在 sdks/shared/proto/sema.proto），避免依赖启动时的工作目录。
// bridge 与 proto 同在 sdks/shared/ 下、相对偏移不变：npm start dist/src/server.js（回退三级到 shared/）、
// npm run dev(ts-node) src/server.ts（回退两级到 shared/）均落在 shared/proto。
// 前两条为单文件 bundle 布局（server.js 同级 proto），tsc 构建不会命中，留作打包兼容。
const PROTO_PATH = [
  path.join(__dirname, 'proto', 'sema.proto'),
  path.join(__dirname, 'sema.proto'),
  path.join(__dirname, '..', '..', '..', 'proto', 'sema.proto'),
  path.join(__dirname, '..', '..', 'proto', 'sema.proto'),
].find(p => fs.existsSync(p)) ?? path.join(process.cwd(), 'proto', 'sema.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;

/**
 * 进程级单例：整个 Node 进程共享一个 SemaCore + 会话池。
 * 对齐 VSCode「一个宿主进程一个 Core、多会话按 sessionId 复用」的模型。
 */
const manager = new SemaCoreManager({ workingDir: WORKING_DIR, logLevel: 'none' });

// rg 兜底供应（跨语言共享的唯一实现）：启动即异步准备，init 创建 Core 前 await 完成，
// 保证 sema-core 首次 spawn rg 时 PATH 已就绪；失败只告警不阻塞（rg 缺失仅影响搜索性能）。
const rgReady = ensureRg().catch((e) =>
  console.warn(`[sema-grpc] ripgrep 准备失败（仅影响搜索性能，继续启动）: ${e?.message ?? e}`),
);

/** 进程级事件（挂在 SemaCore 上，非会话级）；转发时 session_id 留空 */
const PROCESS_EVENTS = ['cron:update', 'mcp:server:status'];

/**
 * 所有活跃连接的 pushEvent 句柄。用于把「非 core 原生事件、但需跨面板同步」的合成帧
 * （如模型变更 model:update）广播到每条独立 gRPC 连接 —— 各面板连接互相独立，
 * 单连接 push 到不了兄弟面板，跨面板同步只能靠广播真事件（对齐 VSCode 宿主广播返回值）。
 */
const connections = new Set<(event: string, data: any, sessionId: string) => void>();
const broadcast = (event: string, data: any) => {
  for (const push of connections) push(event, data, '');
};

function connect(call: grpc.ServerDuplexStream<any, any>): void {
  console.log('[sema-grpc] Client connected');

  // 本连接创建的会话绑定器，key = sessionId
  const binders = new Map<string, SessionBinder>();

  // 进程事件是否已挂到本连接（init 可重复调用，只挂一次，防重复投递）
  let processEventsAttached = false;

  // 本连接注册的 watchTask 取消函数，key = taskId（连接关闭时全部取消，防泄漏）
  const watchers = new Map<string, () => void>();

  const write = (frame: { event: string; data?: any; cmdId?: string; sessionId?: string }) => {
    if (call.writable) {
      call.write({
        event: frame.event,
        data: frame.data !== undefined ? JSON.stringify(frame.data) : '',
        cmd_id: frame.cmdId ?? '',
        session_id: frame.sessionId ?? '',
      });
    }
  };
  const pushEvent = (event: string, data: any, sessionId: string) => write({ event, data, sessionId });
  const ack = (cmdId: string, data?: any) => write({ event: 'ack', data, cmdId });
  const fail = (cmdId: string, message: string, action?: string) =>
    write({ event: 'error', data: { message, action }, cmdId });

  // 本连接加入广播集合，接收跨连接合成事件（如 model:update）
  connections.add(pushEvent);

  // 进程级事件转发到本连接（session_id 留空）
  const processHandlers = PROCESS_EVENTS.map((event) => ({
    event,
    fn: (data: any) => pushEvent(event, data, ''),
  }));
  const attachProcessEvents = () => {
    for (const { event, fn } of processHandlers) manager.onProcessEvent(event, fn);
  };
  const detachProcessEvents = () => {
    for (const { event, fn } of processHandlers) manager.offProcessEvent(event, fn);
  };

  // 解析会话级 action 的目标会话；不存在则抛出可读错误
  const requireSession = (sessionId: string, action: string) => {
    if (!sessionId) throw new Error(`action "${action}" 需要 session_id`);
    const session = manager.getSession(sessionId);
    if (!session) throw new Error(`会话不存在 (session_id=${sessionId})，请先 createSession；action=${action}`);
    return session;
  };

  call.on('data', async (cmd: any) => {
    const id: string = cmd.id;
    const action: string = cmd.action;
    const sessionId: string = cmd.session_id || '';
    let payload: any;
    try {
      payload = cmd.payload ? JSON.parse(cmd.payload) : undefined;
    } catch (e: any) {
      fail(id, `payload 不是合法 JSON: ${e.message}`, action);
      return;
    }

    try {
      switch (action) {
        // action 名与 sema-core 方法名一一对应：session_id 空 → 调 SemaCore；非空 → 调对应 SemaSession。
        // 仅 init 是例外（对应 Core 构造，core 无同名方法）。事件名亦保持 core 原始名，桥不做任何翻译。

        // ── SemaCore 方法（进程级，无需 session_id）──────────
        case 'init': {
          await rgReady;
          manager.init(payload);
          if (!processEventsAttached) { attachProcessEvents(); processEventsAttached = true; } // Core 就绪后再挂进程事件
          ack(id, { ready: true, protocolVersion: PROTOCOL_VERSION });
          return;
        }
        case 'updateCoreConfig': manager.instance.updateCoreConfig(payload); break;
        // 模型变更四连：ack 回 core 的 ModelUpdateData（对齐「ack 回原始返回值」契约，D5），
        // 并跨连接广播 model:update，让兄弟面板（聊天页模型指示器）同步刷新（D2；对齐 VSCode onModelUpdate 双面板广播）。
        case 'addModel':         { const r = await manager.instance.addModel(payload.config, payload.skipValidation); broadcast('model:update', r); ack(id, r); return; }
        case 'delModel':         { const r = await manager.instance.delModel(payload.modelName); broadcast('model:update', r); ack(id, r); return; }
        case 'switchModel':      { const r = await manager.instance.switchModel(payload.modelName); broadcast('model:update', r); ack(id, r); return; }
        case 'applyTaskModel':   { const r = await manager.instance.applyTaskModel(payload); broadcast('model:update', r); ack(id, r); return; }
        case 'getModelData':     { const data = await manager.instance.getModelData(); ack(id, data); return; }
        case 'listSessions':     ack(id, { sessions: manager.listSessions() }); return;
        case 'setActiveSession': ack(id, { ok: manager.instance.setActiveSession(payload.sessionId) }); return;

        case 'createSession': {
          // 建会话即透传 per-session 档位/模式（D7，对齐 VSCode/claw：建会话即带 permissionLevel）。
          const createOpts: Record<string, any> = {};
          if (payload?.sessionId) createOpts.sessionId = payload.sessionId;
          if (payload?.permissionLevel) createOpts.permissionLevel = payload.permissionLevel;
          if (payload?.agentMode) createOpts.agentMode = payload.agentMode;
          // 会话级模型覆盖（仅本会话生效、不落盘），值为 profile 名（同 switchModel 参数）
          if (payload?.mainModel) createOpts.mainModel = payload.mainModel;
          if (payload?.quickModel) createOpts.quickModel = payload.quickModel;
          const result = await manager.instance.createSession(
            Object.keys(createOpts).length ? createOpts : undefined,
          );
          if (!result.ok) {
            // tsconfig strict=false 下不会按 ok 收窄联合类型，这里显式取 error
            fail(id, (result as { error?: string }).error || '创建会话失败', action);
            return;
          }
          const session = result.session;
          const binder = new SessionBinder(session.sessionId, session, pushEvent, broadcast);
          binder.bind();
          binders.set(session.sessionId, binder);
          // 会话级后续指令用此 sessionId 路由；session:ready 事件也会带同一 id
          ack(id, { sessionId: session.sessionId });
          return;
        }
        case 'closeSession': {
          const binder = binders.get(sessionId);
          if (binder) { binder.unbind(); binders.delete(sessionId); }
          ack(id, { ok: manager.closeSession(sessionId) });
          return;
        }

        // ── SemaSession 方法（会话级，需 session_id）──────────
        case 'processUserInput':        (requireSession(sessionId, action) as any).processUserInput(payload.content, payload.orgContent, payload.attachments); break;
        case 'interrupt':               requireSession(sessionId, action).interrupt(); break;
        case 'respondToToolPermission': requireSession(sessionId, action).respondToToolPermission(payload); break;
        case 'respondToPickOption':     requireSession(sessionId, action).respondToPickOption(payload); break;
        case 'respondToPlanExit':       requireSession(sessionId, action).respondToPlanExit(payload); break;
        case 'updateAgentMode':         requireSession(sessionId, action).updateAgentMode(payload.mode); break;
        case 'updatePermissionLevel':   requireSession(sessionId, action).updatePermissionLevel(payload.level); break;

        // fork / 撤销回退（D1）：ack 回 core 原始返回值，UI 弹窗按 reqId 匹配。
        case 'getForkPreview':          ack(id, (requireSession(sessionId, action) as any).getForkPreview(payload.messageUuid)); return;
        case 'fork':                    ack(id, await (requireSession(sessionId, action) as any).fork(payload.messageUuid, payload.options)); return;
        // 分支到新聊天：core 新建会话并复制截断历史（源会话与工作区不动）；ack 回原始 BranchResult（含新 sessionId）。
        case 'branch':                  ack(id, await (requireSession(sessionId, action) as any).branch(payload.beforeMessageUuid)); return;
        // Stop 时一并停后台子 agent（D3）；ack 回停掉的任务数。
        case 'stopAllTasks':            ack(id, { count: (requireSession(sessionId, action) as any).stopAllTasks() }); return;
        // 子 agent 转后台（D4，会话级）；ack 回 boolean。
        case 'transferAgentToBackground': ack(id, { ok: (requireSession(sessionId, action) as any).transferAgentToBackground(payload.taskId) }); return;
        // 全部前台 agent 转后台（会话级）；ack 回转过去的 taskId 列表。
        case 'transferAllForegroundAgents': ack(id, { taskIds: (requireSession(sessionId, action) as any).transferAllForegroundAgents() }); return;

        // ── 配置页 SemaCore 方法（进程级，无需 session_id）──────────
        // 均为 sema-core 原始方法名，桥透明转发；ack 回原始返回值，UI 侧的翻译在 config-controller。
        // 参数映射对齐 semaProcessWrapper 的公开签名。

        // Model（补充：addModel/delModel/switchModel/applyTaskModel/getModelData 已在上方）
        case 'fetchAvailableModels': ack(id, await manager.instance.fetchAvailableModels(payload)); return;
        case 'testApiConnection':    ack(id, await manager.instance.testApiConnection(payload)); return;
        case 'getModelAdapter':      ack(id, manager.instance.getModelAdapter(payload.provider, payload.modelName, payload.baseURL)); return;

        // 工具 / 系统配置推 core
        case 'getToolInfos':         ack(id, manager.instance.getToolInfos()); return;
        case 'updateDisabledTools':  manager.instance.updateDisabledTools(payload.disabledTools); break;
        case 'updateCoreConfByKey':  manager.instance.updateCoreConfByKey(payload.key, payload.value); break;

        // 历史清理（外部主动删除：宿主删除历史条目后同步清理 core 落盘的历史文件）
        case 'deleteSessionHistory': manager.instance.deleteSessionHistory(payload.sessionId, payload.projectPath); break;
        case 'deleteProjectHistory': manager.instance.deleteProjectHistory(payload.projectPath); break;

        // ── 后台任务（会话级，镜像 SemaSession 的 task API，需 session_id）──────────
        case 'getTaskList':  ack(id, (requireSession(sessionId, action) as any).getTaskList()); return;
        case 'stopTask':     ack(id, { ok: (requireSession(sessionId, action) as any).stopTask(payload.taskId) }); return;
        // watchTask 流式：回调只活在本 sidecar 进程内、不跨 gRPC；
        // 每次 delta 合成会话级事件 task:watch:delta 上行（带 session_id），客户端按 taskId 过滤。
        case 'watchTask': {
          const session = requireSession(sessionId, action) as any;
          watchers.get(payload.taskId)?.(); // 幂等：重复 watch 先取消旧的
          const cancel = session.watchTask(payload.taskId, (delta: any) =>
            pushEvent('task:watch:delta', { taskId: payload.taskId, delta }, sessionId));
          watchers.set(payload.taskId, typeof cancel === 'function' ? cancel : () => {});
          ack(id, { action });
          return;
        }
        case 'unwatchTask': {
          watchers.get(payload.taskId)?.();
          watchers.delete(payload.taskId);
          ack(id, { action });
          return;
        }

        // 插件市场 / Plugins
        case 'getMarketplacePluginsInfo':     ack(id, await manager.instance.getMarketplacePluginsInfo()); return;
        case 'refreshMarketplacePluginsInfo': ack(id, await manager.instance.refreshMarketplacePluginsInfo()); return;
        case 'addMarketplaceFromGit':         ack(id, await manager.instance.addMarketplaceFromGit(payload.repo)); return;
        case 'addMarketplaceFromDirectory':   ack(id, await manager.instance.addMarketplaceFromDirectory(payload.dirPath)); return;
        case 'updateMarketplace':             ack(id, await manager.instance.updateMarketplace(payload.marketplaceName)); return;
        case 'removeMarketplace':             ack(id, await manager.instance.removeMarketplace(payload.marketplaceName)); return;
        case 'installPlugin':                 ack(id, await manager.instance.installPlugin(payload.pluginName, payload.marketplaceName, payload.scope, payload.projectPath)); return;
        case 'uninstallPlugin':               ack(id, await manager.instance.uninstallPlugin(payload.pluginName, payload.marketplaceName, payload.scope, payload.projectPath)); return;
        case 'enablePlugin':                  ack(id, await manager.instance.enablePlugin(payload.pluginName, payload.marketplaceName, payload.scope, payload.projectPath)); return;
        case 'disablePlugin':                 ack(id, await manager.instance.disablePlugin(payload.pluginName, payload.marketplaceName, payload.scope, payload.projectPath)); return;
        case 'updatePlugin':                  ack(id, await manager.instance.updatePlugin(payload.pluginName, payload.marketplaceName, payload.scope, payload.projectPath)); return;

        // Agents（concise / refresh 透传，语义与 core 方法签名一致）
        case 'getAgentsInfo':   ack(id, await manager.instance.getAgentsInfo(payload?.concise, payload?.refresh)); return;
        case 'addAgentConf':    ack(id, await manager.instance.addAgentConf(payload)); return;
        case 'removeAgentConf': ack(id, await manager.instance.removeAgentConf(payload.name)); return;

        // Skills（concise 同上）
        case 'getSkillsInfo':   ack(id, await manager.instance.getSkillsInfo(payload?.concise, payload?.refresh)); return;
        case 'removeSkillConf': ack(id, await manager.instance.removeSkillConf(payload.name)); return;

        // Commands（concise 同上）
        case 'getCommandsInfo':   ack(id, await manager.instance.getCommandsInfo(payload?.concise, payload?.refresh)); return;
        case 'addCommandConf':    ack(id, await manager.instance.addCommandConf(payload)); return;
        case 'removeCommandConf': ack(id, await manager.instance.removeCommandConf(payload.name)); return;

        // MCP
        case 'getMCPServerInfo':     ack(id, await manager.instance.getMCPServerInfo()); return;
        case 'refreshMCPServerInfo': ack(id, await manager.instance.refreshMCPServerInfo()); return;
        case 'addMCPServer':         ack(id, await manager.instance.addMCPServer(payload)); return;
        case 'removeMCPServer':      ack(id, await manager.instance.removeMCPServer(payload.name)); return;
        case 'reconnectMCPServer':   ack(id, await manager.instance.reconnectMCPServer(payload.name)); return;
        case 'disableMCPServer':     ack(id, await manager.instance.disableMCPServer(payload.name)); return;
        case 'enableMCPServer':      ack(id, await manager.instance.enableMCPServer(payload.name)); return;
        case 'updateMCPUseTools':    ack(id, await manager.instance.updateMCPUseTools(payload.name, payload.toolNames)); return;

        // Cron（delete/enable/disable 同步返回 boolean）
        case 'getCronTasks':     ack(id, await manager.instance.getCronTasks()); return;
        case 'deleteCronTask':   ack(id, manager.instance.deleteCronTask(payload.id)); return;
        case 'enableCronTask':   ack(id, manager.instance.enableCronTask(payload.id)); return;
        case 'disableCronTask':  ack(id, manager.instance.disableCronTask(payload.id)); return;

        // Memory / Rule / Hooks / Design（只读）
        case 'getMemoryInfo':        ack(id, await manager.instance.getMemoryInfo(payload?.refresh)); return;
        case 'getRuleInfo':          ack(id, await manager.instance.getRuleInfo(payload?.refresh)); return;
        case 'getHooksInfo':         ack(id, await manager.instance.getHooksInfo(payload?.refresh)); return;
        case 'getDesignSkillsInfo':  ack(id, await manager.instance.getDesignSkillsInfo(payload?.refresh)); return;
        case 'getDesignSystemsInfo': ack(id, await manager.instance.getDesignSystemsInfo(payload?.refresh)); return;

        default:
          fail(id, `未知 action: ${action}`, action);
          return;
      }
      ack(id, { action });
    } catch (err: any) {
      fail(id, err.message, action);
    }
  });

  const cleanup = () => {
    connections.delete(pushEvent);
    for (const cancel of watchers.values()) cancel();
    watchers.clear();
    detachProcessEvents();
    for (const [sid, binder] of binders) {
      binder.unbind();
      manager.closeSession(sid);
    }
    binders.clear();
  };

  call.on('end', () => {
    console.log('[sema-grpc] Client disconnected');
    cleanup();
    call.end();
  });

  call.on('error', (err: Error) => {
    console.error('[sema-grpc] Stream error:', err);
    cleanup();
  });
}

const server = new grpc.Server({
  // 默认单条 4MB，收 BridgeCommand（含贴图 base64）时易超限断连；抬到 64MB，发送不限
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.max_send_message_length': -1,
});
server.addService(proto.sema.SemaBridge.service, { Connect: connect });

// 进程级兜底：MCP/插件/cron 的脱离上下文异步异常不再掀翻整进程（sidecar 无自愈），降级为日志。
process.on('uncaughtException', (err) => console.error('[sema-grpc] uncaughtException（已兜底）:', err));
process.on('unhandledRejection', (reason) => console.error('[sema-grpc] unhandledRejection（已兜底）:', reason));

server.bindAsync(
  `127.0.0.1:${PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) {
      console.error('[sema-grpc] Failed to start server:', err);
      process.exit(1);
    }
    // 机器可解析行：宿主传 SEMA_BRIDGE_PORT=0 时可从 stdout 读取实际端口（多 IDE 窗口避免撞端口）
    console.log(`SEMA_BRIDGE_PORT_ACTUAL=${port}`);
    console.log(`[sema-grpc] Listening on grpc://127.0.0.1:${port}`);
    console.log(`[sema-grpc] Working directory: ${WORKING_DIR}`);
  },
);

process.on('SIGTERM', () => {
  console.log('[sema-grpc] Shutting down...');
  void manager.dispose().finally(() => server.tryShutdown(() => process.exit(0)));
});

process.on('SIGINT', () => {
  // SDK 托管模式（SidecarManager 注入）：生命周期归宿主管，宿主退出时发 SIGTERM。
  // 终端宿主的 Ctrl-C 会把 SIGINT 广播给整个前台进程组——此时忽略，否则宿主
  // 「第一次 Ctrl-C 只中断会话」的语义会因桥先死而被破坏。独立 npm start 场景不受影响。
  if (process.env.SEMA_BRIDGE_PARENT_OWNED) {
    console.log('[sema-grpc] SIGINT ignored (parent-owned lifecycle)');
    return;
  }
  console.log('[sema-grpc] Shutting down...');
  void manager.dispose().finally(() => server.tryShutdown(() => process.exit(0)));
});

// 孤儿自检：stdin 是 FIFO（宿主 SidecarManager 建的管道）才启用——宿主活着管道就开着，
// 宿主死亡（含 SIGKILL / 崩溃 / IDE 停止按钮，收不到任何信号）管道必然关闭 → 自行退出，不留孤儿。
// TTY / /dev/null 是字符设备、非 FIFO，手动跑桥调试天然不触发；SEMA_NO_PARENT_WATCH=1 可强制关闭。
const stdinIsPipe = (() => { try { return fs.fstatSync(0).isFIFO(); } catch { return false; } })();
if (stdinIsPipe && !process.env.SEMA_NO_PARENT_WATCH) {
  let exiting = false;
  const orphanExit = () => {
    if (exiting) return;
    exiting = true;
    console.log('[sema-grpc] stdin closed (host gone), exiting...');
    setTimeout(() => process.exit(0), 3000).unref(); // dispose 卡住时兜底强退
    void manager.dispose().finally(() => process.exit(0));
  };
  process.stdin.resume();
  process.stdin.on('end', orphanExit);
  process.stdin.on('close', orphanExit);
}
