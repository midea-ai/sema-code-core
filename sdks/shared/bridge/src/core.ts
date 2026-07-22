import { SemaCore } from 'sema-core';
import type { SemaSession } from 'sema-core';

/**
 * SemaCoreManager —— 进程级单例。
 *
 * 对齐 VSCode 端的 SemaProcessWrapper：一个 Node 进程只持有唯一的 SemaCore，
 * 模型 / 配置 / MCP / 插件等进程级能力全进程共享；多个会话（对应 UI 多标签）
 * 通过 sessionId 复用同一个 Core。这样 gRPC 侧的使用体验与 VSCode 一致。
 */
export class SemaCoreManager {
  private core: SemaCore | null = null;
  private baseConfig: Record<string, any>;

  constructor(baseConfig: Record<string, any>) {
    this.baseConfig = { ...baseConfig };
  }

  /**
   * 首次调用创建 SemaCore（seed 配置仅在此刻生效，引导 core 用持久化配置启动）。
   * core 已存在时 init 即 no-op —— 只确认就绪，**不再用 seed 去 updateCoreConfig**：
   * 多面板（chat / config / history）共享同一进程单 core，后打开的面板也会发 init，
   * 若在这里更新配置，就等于"打开面板 = 悄悄改一次 core 配置"，既非本意、又会撞白名单校验。
   * 真正的配置更新只走显式路径（saveSystemConfig → updateCoreConfig）。
   */
  init(overrides?: Record<string, any>): SemaCore {
    if (!this.core) {
      this.baseConfig = { ...this.baseConfig, ...(overrides ?? {}) };
      this.core = new SemaCore(this.baseConfig);
    }
    return this.core;
  }

  /** 取 Core 实例；未初始化时报错，提示先 init（与示例调用流程一致） */
  get instance(): SemaCore {
    if (!this.core) {
      throw new Error('SemaCore 未初始化：请先发送 init');
    }
    return this.core;
  }

  isReady(): boolean {
    return this.core !== null;
  }

  // ===== 会话池（对齐 SemaProcessWrapper 的会话池方法）=====

  getSession(sessionId: string): SemaSession | undefined {
    return this.core?.getSession(sessionId);
  }

  listSessions(): string[] {
    return this.core?.listSessions() ?? [];
  }

  closeSession(sessionId: string): boolean {
    return this.core?.closeSession(sessionId) ?? false;
  }

  // ===== 进程级事件（cron / mcp 状态等，挂在 SemaCore 上）=====

  onProcessEvent(event: string, listener: (data: any) => void): void {
    (this.core as any)?.on(event, listener);
  }

  offProcessEvent(event: string, listener: (data: any) => void): void {
    (this.core as any)?.off(event, listener);
  }

  async dispose(): Promise<void> {
    try {
      await this.core?.dispose();
    } finally {
      this.core = null;
    }
  }
}
