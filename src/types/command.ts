/**
 * 自定义命令类型定义
 */

/**
 * 自定义命令的 Frontmatter 配置
 */
export interface CustomCommandFrontmatter {
  /** 命令描述 */
  description?: string;
  /** 参数提示文本（如 "<file-path>" 或 "<environment> <version>"） */
  'argument-hint'?: string;
  // 可扩展字段：
  // 'allowed-tools'?: string[];
  // 'when-to-use'?: string;
  // model?: string;
  // [key: string]: any;
}

/**
 * 自定义命令对象
 */
export interface CustomCommand {
  /** 命令名（如 "optimize" 或 "frontend:test"） */
  name: string;
  /** 显示名（如 "/optimize" 或 "/frontend:test"） */
  displayName: string;
  /** 命令描述 */
  description: string;
  /** 参数提示 */
  argumentHint?: string;
  /** 源 .md 文件路径 */
  filePath: string;
  /** 作用域：用户级别或项目级别 */
  scope: 'user' | 'project';
  /** Markdown 内容（不含 frontmatter） */
  content: string;
}

/**
 * 加载自定义命令的结果
 */
export interface LoadCustomCommandsResult {
  /** 成功加载的命令列表 */
  commands: CustomCommand[];
  /** 加载过程中的错误列表 */
  errors: Array<{ file: string; error: string }>;
}
