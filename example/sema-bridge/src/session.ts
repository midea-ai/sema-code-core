import { WebSocket } from 'ws';
import { SemaCore } from 'sema-core';
import type { SemaSession } from 'sema-core';
import { BridgeCommand, BridgeEvent } from './protocol';

// 会话级事件统一通过 SemaSession.on 订阅（SemaCore.on 只接收进程级事件）
const FORWARD_EVENTS = [
  'session:ready', 'session:error', 'session:interrupted', 'session:cleared',
  'state:update',
  'input:received', 'input:processing',
  'message:text:chunk', 'message:thinking:chunk', 'message:complete',
  'tool:execution:start', 'tool:permission:request', 'tool:execution:complete', 'tool:execution:chunk', 'tool:execution:error',
  'task:agent:start', 'task:agent:end', 'task:start', 'task:end',
  'todos:update', 'topic:update',
  'pick:option:request', 'plan:exit:request',
  'conversation:usage', 'file:reference',
];

export class BridgeSession {
  private core: SemaCore;
  private coreConfig: Record<string, any>;
  private session: SemaSession | null = null;

  constructor(private ws: WebSocket, defaultConfig: Record<string, any>) {
    this.coreConfig = defaultConfig;
    this.core = new SemaCore(this.coreConfig);
  }

  private push(event: string, data?: any, cmdId?: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const message: BridgeEvent = { event, data, cmdId };
      this.ws.send(JSON.stringify(message));
    }
  }

  // 把会话级事件桥接到 WebSocket（必须绑在 SemaSession 上，而非 SemaCore）
  private bindSessionEvents(session: SemaSession): void {
    for (const event of FORWARD_EVENTS) {
      session.on(event, (data: any) => this.push(event, data));
    }
  }

  // 取出当前会话，未创建时报错（避免在 core 上误调会话级方法）
  private requireSession(action: string): SemaSession {
    if (!this.session) {
      throw new Error(`No active session for action "${action}"; call session.create first`);
    }
    return this.session;
  }

  async handle(cmd: BridgeCommand): Promise<void> {
    const { id, action, payload } = cmd;
    try {
      switch (action) {
        case 'config.init':
          // 销毁旧实例，合并配置后重建 SemaCore（workingDir 等构造函数级别的配置在此生效）
          await this.core.dispose();
          this.session = null;
          this.coreConfig = { ...this.coreConfig, ...payload };
          this.core = new SemaCore(this.coreConfig);
          break;
        case 'session.create': {
          const result = await this.core.createSession(
            payload?.sessionId ? { sessionId: payload.sessionId } : undefined,
          );
          if (!result.ok) {
            // tsconfig strict=false 下不会按 ok 收窄联合类型，这里显式取 error
            this.push('error', { message: (result as { error?: string }).error, action }, id);
            return;
          }
          this.session = result.session;
          this.bindSessionEvents(this.session);
          break;
        }
        case 'session.input':      this.requireSession(action).processUserInput(payload.content, payload.orgContent); break;
        case 'session.interrupt':  this.requireSession(action).interrupt(); break;
        case 'session.dispose':
          if (this.session) {
            this.core.closeSession(this.session.sessionId);
            this.session = null;
          }
          break;
        case 'permission.respond': this.requireSession(action).respondToToolPermission(payload); break;
        case 'question.respond':   this.requireSession(action).respondToPickOption(payload); break;
        case 'plan.respond':       this.requireSession(action).respondToPlanExit(payload); break;
        case 'config.updateAgentMode': this.requireSession(action).updateAgentMode(payload.mode); break;
        case 'model.add':          await this.core.addModel(payload.config, payload.skipValidation); break;
        case 'model.applyTask':    await this.core.applyTaskModel(payload); break;
        case 'model.del':          await this.core.delModel(payload.modelName); break;
        case 'model.switch':       await this.core.switchModel(payload.modelName); break;
        case 'model.getData':      { const data = await this.core.getModelData(); this.push('ack', data, id); return; }
        case 'config.update':      this.core.updateCoreConfig(payload); break;
        default: this.push('error', { message: `Unknown action: ${action}` }, id); return;
      }
      this.push('ack', { action }, id);
    } catch (err: any) {
      this.push('error', { message: err.message, action }, id);
    }
  }

  dispose(): void {
    if (this.session) {
      this.core.closeSession(this.session.sessionId);
      this.session = null;
    }
    void this.core.dispose();
  }
}
