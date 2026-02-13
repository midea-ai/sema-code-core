import { EventListener, EventBusInterface } from './types';
import { logError } from '../util/log';
import { logEvent } from '../util/logLLM';

/**
 * 简化的事件发射器
 */
export class EventEmitter {
  private events = new Map<string, Function[]>();

  on(event: string, listener: Function): this {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)!.push(listener);
    return this;
  }

  off(event: string, listener: Function): this {
    const listeners = this.events.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const listeners = this.events.get(event);
    if (listeners && listeners.length > 0) {
      // 同步执行，避免异步陷阱
      listeners.forEach((listener: Function) => {
        try {
          listener(...args);
        } catch (error) {
          logError(`EventEmitter: Error in listener for event "${event}":${error}`);
        }
      });
      return true;
    }
    return false;
  }

  once(event: string, listener: Function): this {
    const onceWrapper = (...args: any[]) => {
      listener(...args);
      this.off(event, onceWrapper);
    };
    return this.on(event, onceWrapper);
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
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
 * 简化的事件总线 - 基于进程隔离，移除复杂的隔离逻辑
 * 专注核心功能：事件发射、监听和基本管理
 */
export class EventBus implements EventBusInterface {
  private static instance: EventBus | null = null;
  private readonly emitter = new EventEmitter();

  private constructor() {
    // 简化构造函数，不需要复杂的配置逻辑
  }

  /**
   * 获取 EventBus 实例（单例模式）
   */
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

  emit<T>(event: string, data: T): boolean {
    if (!EventBus.SILENT_EVENTS.has(event)) {
      logEvent(event, data);
    }
    return this.emitter.emit(event, data);
  }

  on<T>(event: string, listener: EventListener<T>): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<T>(event: string, listener: EventListener<T>): this {
    this.emitter.off(event, listener);
    return this;
  }

  once<T>(event: string, listener: EventListener<T>): this {
    this.emitter.once(event, listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
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
 * 导出单例实例的便捷访问方法
 */
export const getEventBus = () => EventBus.getInstance();