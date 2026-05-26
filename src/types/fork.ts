/**
 * 恢复文件时对单个文件的操作语义（从"回滚到 fork 点"的视角）：
 * - modify   : fork 后该文件被改过 → 覆盖回旧内容
 * - recreate : fork 后该文件被删了 → 重新写回旧内容
 * - delete   : 该文件是 fork 之后才新建的 → 删除以回到 fork 态
 */
export type ForkFileEffect = 'modify' | 'recreate' | 'delete';

/** 预览中单个文件的改动描述 */
export interface ForkFileChange {
  /** 绝对路径 */
  filePath: string;
  /** 相对工作目录的展示路径 */
  displayPath: string;
  effect: ForkFileEffect;
  /** 执行回滚将新增的行数 */
  additions: number;
  /** 执行回滚将删除的行数 */
  removals: number;
  /** 二进制文件：不计算增删行 */
  binary?: boolean;
}

/** Fork 预览结果：在某条用户消息处恢复文件会改动哪些文件 */
export interface ForkPreview {
  messageUuid: string;
  /** 该消息是否带快照锚点（旧历史消息可能没有 → 只能 fork-only） */
  canRestoreFiles: boolean;
  files: ForkFileChange[];
}

/** Fork 选项 */
export interface ForkOptions {
  /** 为 true 时同时把文件回滚到 fork 点 */
  restoreFiles?: boolean;
}

/**
 * Fork 执行结果（原地回退：同一会话、sessionId 不变）。
 * restoredFiles 为实际回滚的文件绝对路径列表。
 */
export type ForkResult =
  | { ok: true; sessionId: string; restoredFiles: string[] }
  | { ok: false; error: string };
