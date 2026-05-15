/**
 * Design 系统类型定义
 */

export interface DesignSkillInfo {
  folderName: string
  filePath: string
  name: string
  description: string
}

export interface DesignSystemColor {
  key: string
  value: string
}

export interface DesignSystemInfo {
  folderName: string
  filePath: string
  name: string
  description: string
  /** 列表缩略色条，固定 4 项，顺序为 [background, muted, foreground, accent] */
  swatches: DesignSystemColor[]
  /** 详情面板用，原始 color token 全量，key 为 token 名 */
  colors: DesignSystemColor[]
}
