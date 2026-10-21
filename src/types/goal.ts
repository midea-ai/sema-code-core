// 会话级长期目标（/goal 命令）
// running=自主循环中；paused=用户暂停/中断、系统止损、重开会话，可 resume；
// completed/blocked=模型经 complete_goal 自报，blocked 可 resume；不要了用 clearGoal 删除
export type GoalStatus = 'running' | 'paused' | 'completed' | 'blocked'

export interface GoalState {
  text: string
  status: GoalStatus
  round: number          // 起始轮为 1，仅自动续轮加一
  maxRounds: number      // 初始 GOAL_MAX_ROUNDS，因上限暂停后 resume 时累加
  idleRounds: number     // 连续无 tool_use 的目标轮数
  summary?: string       // complete_goal 给出的总结
  createdAt: number
  updatedAt: number
}

// 与目标相关的用户输入标记：挂在 input:received / input:processing 事件与持久化 UserMsg 上，
// UI 据此给气泡打标（设定目标 / 更新目标 / 目标第 n 轮），不用解析输入文本
export interface GoalInputMark {
  action: 'set' | 'update' | 'round'
  round: number
  maxRounds: number
}
