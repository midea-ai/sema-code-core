/**
 * 项目配置接口
 */
export interface ProjectConfig {
  allowedTools: string[];
  history: string[];
  lastEditTime: string;
  rules: string[];
}

/**
 * 全局配置文件接口
 */
export type GlobalProjectConfig = Record<string, ProjectConfig>;