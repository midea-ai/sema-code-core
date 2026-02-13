import { logError } from './log'

export function safeParseJSON(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    return JSON.parse(json)
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * 处理包含HEREDOC的命令，将其转换为更可读的格式
 * @param command 原始命令字符串
 * @returns 处理后的命令字符串
 */
export function processHeredocCommand(command: string): string {
  // 处理引用的HEREDOC模式
  if (command.includes("\"$(cat <<'EOF'")) {
    const match = command.match(
      /^(.*?)"?\$\(cat <<'EOF'\n([\s\S]*?)\n\s*EOF\n\s*\)"(.*)$/,
    )
    if (match && match[1] && match[2]) {
      const prefix = match[1]
      const heredocContent = match[2]
      const suffix = match[3] || ''
      return `${prefix.trim()} "${heredocContent.trim()}"${suffix.trim()}`
    }
  }
  return command
}


// 格式化错误信息
export function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error) // 非 Error 对象直接转换为字符串
  }
  const parts = [error.message] // 错误消息主体
  // 添加标准错误输出（如果存在）
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  // 添加标准输出（如果存在）
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  const fullMessage = parts.filter(Boolean).join('\n')
  // 如果消息太长，进行截断
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength) // 开头部分
  const end = fullMessage.slice(-halfLength) // 结尾部分
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}
