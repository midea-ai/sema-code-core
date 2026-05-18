/**
 * Cron 定时任务类型定义
 */

export interface CronTask {
  id: string
  sessionId?: string        // 创建该任务的会话 ID（触发时优先注入该会话）
  schedule: string          // 5字段 cron 表达式（本地时间）
  task: string              // 触发时执行的提示词/指令
  repeat: boolean           // true=周期执行, false=一次性触发后删除
  persist: boolean          // true=持久化到文件, false=仅内存
  status: boolean           // true=启用, false=禁用
  filePath?: string          // 持久化文件路径
  createdAt: number
  describeCronExpression: string        // 人类可读的 cron 描述
  activatedAt: number       // 本轮调度起始时间（新建=now，恢复=now），用于10天过期判断
  lastFiredAt?: number      // 上次触发时间
  nextFireAt: number[]      // 接下来最多4次触发时间
}

// 持久化文件格式（仅保留核心字段，运行时字段在加载时自动生成）
export interface CronTaskFile {
  tasks: Pick<CronTask, 'id' | 'schedule' | 'task' | 'repeat' | 'createdAt' | 'lastFiredAt'>[]
}
