import { WebSocket } from 'ws';
import { SemaCore } from 'sema-core';
import { BridgeCommand, BridgeEvent } from './protocol';

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

  constructor(private ws: WebSocket, defaultConfig: Record<string, any>) {
    this.coreConfig = defaultConfig;
    this.core = this._createCore(this.coreConfig);
  }

  private _createCore(config: Record<string, any>): SemaCore {
    const core = new SemaCore(config);
    for (const event of FORWARD_EVENTS) {
      core.on(event, (data: any) => this.push(event, data));
    }
    return core;
  }

  private push(event: string, data?: any, cmdId?: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const message: BridgeEvent = { event, data, cmdId };
      this.ws.send(JSON.stringify(message));
    }
  }

  async handle(cmd: BridgeCommand): Promise<void> {
    const { id, action, payload } = cmd;
    try {
      switch (action) {
        case 'config.init':
          // 销毁旧实例，合并配置后重建 SemaCore（workingDir 等构造函数级别的配置在此生效）
          await this.core.dispose();
          this.coreConfig = { ...this.coreConfig, ...payload };
          this.core = this._createCore(this.coreConfig);
          break;
        case 'session.create':     await this.core.createSession(payload?.sessionId); break;
        case 'session.input':      this.core.processUserInput(payload.content, payload.orgContent); break;
        case 'session.interrupt':  this.core.interruptSession(); break;
        case 'session.dispose':    await this.core.dispose(); break;
        case 'permission.respond': this.core.respondToToolPermission(payload); break;
        case 'question.respond':   this.core.respondToPickOption(payload); break;
        case 'plan.respond':       this.core.respondToPlanExit(payload); break;
        case 'model.add':          await this.core.addModel(payload.config, payload.skipValidation); break;
        case 'model.applyTask':    await this.core.applyTaskModel(payload); break;
        case 'model.del':          await this.core.delModel(payload.modelName); break;
        case 'model.switch':       await this.core.switchModel(payload.modelName); break;
        case 'model.getData':      { const data = await this.core.getModelData(); this.push('ack', data, id); return; }
        case 'config.update':      this.core.updateCoreConfig(payload); break;
        case 'config.updateAgentMode': this.core.updateAgentMode(payload.mode); break;
        default: this.push('error', { message: `Unknown action: ${action}` }, id); return;
      }
      this.push('ack', { action }, id);
    } catch (err: any) {
      this.push('error', { message: err.message, action }, id);
    }
  }

  dispose(): void { void this.core.dispose(); }
}
