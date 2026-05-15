import { SemaCore } from 'sema-core';

const FORWARD_EVENTS = [
  'session:ready', 'session:error', 'session:interrupted', 'session:cleared',
  'state:update',
  'input:received', 'input:processing',
  'message:text:chunk', 'message:thinking:chunk', 'message:complete',
  'tool:permission:request', 'tool:execution:complete', 'tool:execution:chunk', 'tool:execution:error',
  'task:agent:start', 'task:agent:end', 'task:start', 'task:end',
  'todos:update', 'topic:update',
  'pick:option:request', 'plan:exit:request',
  'conversation:usage', 'file:reference',
];

interface GrpcStream {
  write(event: { event: string; data: string; cmd_id: string }): void;
  writable: boolean;
}

export class BridgeSession {
  private core: SemaCore;
  private coreConfig: Record<string, any>;

  constructor(private stream: GrpcStream, defaultConfig: Record<string, any>) {
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
    if (this.stream.writable) {
      this.stream.write({
        event,
        data: data !== undefined ? JSON.stringify(data) : '',
        cmd_id: cmdId ?? '',
      });
    }
  }

  async handle(cmd: { id: string; action: string; payload?: any }): Promise<void> {
    const { id, action, payload } = cmd;
    try {
      switch (action) {
        case 'config.init':
          await (this.core as any).dispose?.();
          this.coreConfig = { ...this.coreConfig, ...payload };
          this.core = this._createCore(this.coreConfig);
          break;
        case 'session.create':     await this.core.createSession(payload?.sessionId); break;
        case 'session.input':      this.core.processUserInput(payload.content, payload.orgContent); break;
        case 'session.interrupt':  this.core.interruptSession(); break;
        case 'session.dispose':    await (this.core as any).dispose?.(); break;
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

  dispose(): void { void (this.core as any).dispose?.(); }
}
