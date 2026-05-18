import { EventListener, EventBusInterface } from './types';
import { logError } from '../util/log';
import { logEvent } from '../util/logLLM';
import { TOOL_NAME_FETCH_URL } from '../prompt/tool';

/**
 * 监听器条目
 * sessionId 为路由标签：
 * - 有值：仅接收该会话的事件（以及无 sessionId 的广播事件）
 * - null：全局监听器，接收所有事件
 */
interface ListenerEntry {
  fn: Function;
  sessionId: string | null;
}

/**
 * 支持按 sessionId 路由的事件发射器
 */
export class EventEmitter {
  private events = new Map<string, ListenerEntry[]>();

  on(event: string, listener: Function, sessionId: string | null = null): this {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)!.push({ fn: listener, sessionId });
    return this;
  }

  off(event: string, listener: Function): this {
    const listeners = this.events.get(event);
    if (listeners) {
      const index = listeners.findIndex(entry => entry.fn === listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
    return this;
  }

  /**
   * 触发事件
   * @param sessionId 事件所属会话；为 null 时广播给所有监听器
   */
  emit(event: string, data: any, sessionId: string | null = null): boolean {
    const listeners = this.events.get(event);
    if (listeners && listeners.length > 0) {
      // 复制一份避免回调中修改数组
      [...listeners].forEach((entry: ListenerEntry) => {
        // 路由：事件带 sessionId 时，只投递给同会话监听器或全局监听器
        if (sessionId !== null && entry.sessionId !== null && entry.sessionId !== sessionId) {
          return;
        }
        try {
          entry.fn(data);
        } catch (error) {
          logError(`EventEmitter: Error in listener for event "${event}":${error}`);
        }
      });
      return true;
    }
    return false;
  }

  once(event: string, listener: Function, sessionId: string | null = null): this {
    const onceWrapper = (...args: any[]) => {
      listener(...args);
      this.off(event, onceWrapper);
    };
    return this.on(event, onceWrapper, sessionId);
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
    return this;
  }

  /**
   * 移除指定会话注册的所有监听器
   */
  removeSessionListeners(sessionId: string): this {
    for (const listeners of this.events.values()) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].sessionId === sessionId) {
          listeners.splice(i, 1);
        }
      }
    }
    return this;
  }

  hasListeners(event: string): boolean {
    return (this.events.get(event)?.length ?? 0) > 0;
  }

  listenerCount(event: string): number {
    return this.events.get(event)?.length ?? 0;
  }

  eventNames(): string[] {
    return Array.from(this.events.keys());
  }
}

/**
 * 事件总线 - 进程内单例传输层
 * sessionId 作为路由元数据（不写入事件 payload），由 SessionEventBus 注入/过滤
 */
export class EventBus implements EventBusInterface {
  private static instance: EventBus | null = null;
  private readonly emitter = new EventEmitter();

  private constructor() {}

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  private static readonly SILENT_EVENTS = new Set([
    'message:thinking:chunk',
    'message:text:chunk',
  ]);

  emit<T>(event: string, data: T, sessionId: string | null = null): boolean {
    if (!EventBus.SILENT_EVENTS.has(event)) {
      const shouldLog = event !== 'tool:execution:chunk'
        || (data as any)?.toolName === TOOL_NAME_FETCH_URL;
      if (shouldLog) {
        logEvent(event, data, sessionId ?? undefined);
      }
    }
    return this.emitter.emit(event, data, sessionId);
  }

  on<T>(event: string, listener: EventListener<T>, sessionId: string | null = null): this {
    this.emitter.on(event, listener, sessionId);
    return this;
  }

  off<T>(event: string, listener: EventListener<T>): this {
    this.emitter.off(event, listener);
    return this;
  }

  once<T>(event: string, listener: EventListener<T>, sessionId: string | null = null): this {
    this.emitter.once(event, listener, sessionId);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  removeSessionListeners(sessionId: string): this {
    this.emitter.removeSessionListeners(sessionId);
    return this;
  }

  hasListeners(event: string): boolean {
    return this.emitter.hasListeners(event);
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }

  eventNames(): string[] {
    return this.emitter.eventNames();
  }
}

/**
 * 会话级事件总线
 * 包装全局 EventBus：emit 自动标记 sessionId，on/once 自动按 sessionId 过滤
 * 每个 SemaSession 持有一个，dispose 时只移除自己注册的监听器
 */
export class SessionEventBus {
  constructor(
    private readonly bus: EventBus,
    public readonly sessionId: string,
  ) {}

  emit<T>(event: string, data: T): boolean {
    return this.bus.emit(event, data, this.sessionId);
  }

  on<T>(event: string, listener: EventListener<T>): this {
    this.bus.on(event, listener, this.sessionId);
    return this;
  }

  once<T>(event: string, listener: EventListener<T>): this {
    this.bus.once(event, listener, this.sessionId);
    return this;
  }

  off<T>(event: string, listener: EventListener<T>): this {
    this.bus.off(event, listener);
    return this;
  }

  /**
   * 移除本会话注册的所有监听器
   */
  dispose(): void {
    this.bus.removeSessionListeners(this.sessionId);
  }
}

/**
 * 导出单例实例的便捷访问方法
 */
export const getEventBus = () => EventBus.getInstance();

/**
 * 创建一个会话级事件总线
 */
export const createSessionEventBus = (sessionId: string): SessionEventBus =>
  new SessionEventBus(EventBus.getInstance(), sessionId);
