export interface MemoryConfig {
  prompt: string  // MEMORY.md内容
  from?: string 
  FilePath?: string // MEMORY.md路径
  refFilePath?: string[] // memory目录非 MEMORY.md 的其他.md文件 路径列表
}