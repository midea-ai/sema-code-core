/**
 * 输入队列批处理工具
 */

type InputItem = { inputId: string; input: string; originalInput?: string; silent?: boolean }

/**
 * 从待处理队列中取出下一批输入
 * 规则：
 * - 如果第一条是命令（/开头），单独取出作为一批
 * - 否则取出所有连续的非命令输入，直到遇到命令为止
 * 取出的元素从 pending 数组中移除（splice）
 */
export function takeNextBatch(pending: InputItem[]): InputItem[] {
  if (pending.length === 0) return []

  // 第一条是命令，单独处理
  if (pending[0].input.startsWith('/')) {
    return pending.splice(0, 1)
  }

  // 找到下一个命令的位置
  const nextCommandIdx = pending.findIndex(p => p.input.startsWith('/'))
  if (nextCommandIdx === -1) {
    // 没有命令，全部取出
    return pending.splice(0)
  }

  // 取出命令之前的所有普通输入
  return pending.splice(0, nextCommandIdx)
}
