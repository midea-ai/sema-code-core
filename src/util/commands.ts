import { type ControlOperator, parse, ParseEntry } from 'shell-quote'
import { queryQuick } from '../services/api/queryLLM'
import { API_ERR_PREFIX } from './message'
import { COMMAND_PREFIX_SYSTEM_PROMPT, COMMAND_PREFIX_USER_PROMPT } from '../prompt/commands'

const SQ_PLACEHOLDER = '__SQ_PLACEHOLDER__'
const DQ_PLACEHOLDER = '__DQ_PLACEHOLDER__'
const BS_PLACEHOLDER = '__BS_PLACEHOLDER__'

export type ExtractedCommandPrefix =
  | {
      commandPrefix: string | null
      commandInjectionDetected: false
    }
  | { commandInjectionDetected: true }

// 命令注入特征：反引号 / $( / 换行 / && / || / ;。
// 但必须区分引号内外——引号里的换行/分号是字面数据（如 echo "多行文本"），不是命令分隔：
//  - 单引号内：全部字面，shell 不做任何解释 → 一律忽略
//  - 双引号内：换行 / ; / && / || 是字面，但 $( 与反引号仍是命令替换 → 仅检出这两者
//  - 引号外：换行 / ; / && / || / $( / 反引号 全部视为注入
// 反斜杠转义会跳过下一个字符，避免把 \" \' 误判为引号边界。解析始终保守（fail-closed）。
export function hasCommandInjection(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]

    if (inSingle) {
      // 单引号内无转义，仅 ' 结束
      if (c === "'") inSingle = false
      continue
    }

    if (c === '\\') {
      // 引号外或双引号内：反斜杠转义下一个字符，跳过
      i++
      continue
    }

    if (inDouble) {
      if (c === '`') return true
      if (c === '$' && next === '(') return true
      if (c === '"') inDouble = false
      continue
    }

    // 引号外
    if (c === "'") { inSingle = true; continue }
    if (c === '"') { inDouble = true; continue }
    if (c === '`' || c === '\n' || c === ';') return true
    if (c === '$' && next === '(') return true
    if ((c === '&' || c === '|') && next === c) return true
  }
  return false
}

/**
 * 根据shell操作符将命令字符串拆分为单个命令
 */
export function splitCommand(command: string): string[] {
  const parts: ParseEntry[] = []

  // 1. 合并相邻的字符串
  for (const part of parse(
    command
      .replaceAll('\\', BS_PLACEHOLDER)
      .replaceAll('"', `"${DQ_PLACEHOLDER}`)
      .replaceAll("'", `'${SQ_PLACEHOLDER}`),
    varName => `$${varName}`,
  )) {
    if (typeof part === 'string') {
      if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') {
        parts[parts.length - 1] += ' ' + part
        continue
      }
    }
    parts.push(part)
  }

  // 2. 将令牌映射为字符串
  const stringParts = parts
    .map(part => {
      if (typeof part === 'string') {
        return part
      }
      if ('comment' in part) {
        return '#' + part.comment
      }
      if ('op' in part && part.op === 'glob') {
        return part.pattern
      }
      if ('op' in part) {
        return part.op
      }
      return undefined
    })
    .filter((part): part is string => part !== undefined)

  // 3. 将引号映射回原始形式
  const quotedParts = stringParts.map(part => {
    return part
      .replaceAll(`${SQ_PLACEHOLDER}`, "'")
      .replaceAll(`${DQ_PLACEHOLDER}`, '"')
      .replaceAll(`${BS_PLACEHOLDER}`, '\\')
  })

  // 4. 过滤掉分隔符
  const commandParts: string[] = []
  let currentCommand: string | null = null
  let commandSubstitutionDepth = 0

  const appendPart = (part: string) => {
    currentCommand = currentCommand
      ? currentCommand.endsWith('(')
        ? `${currentCommand}${part}`
        : `${currentCommand} ${part}`
      : part
  }

  const flushCurrentCommand = () => {
    if (!currentCommand) return
    commandParts.push(currentCommand)
    currentCommand = null
  }

  for (let index = 0; index < quotedParts.length; index++) {
    const part = quotedParts[index]!

    if (part === '(' && currentCommand?.endsWith('$')) {
      currentCommand += part
      commandSubstitutionDepth++
      continue
    }

    if (part === ')' && commandSubstitutionDepth > 0) {
      currentCommand = currentCommand ? `${currentCommand}${part}` : part
      commandSubstitutionDepth--
      continue
    }

    if ((SHELL_LIST_SEPARATORS as Set<string>).has(part)) {
      flushCurrentCommand()
      continue
    }

    if ((SHELL_GROUPING_OPERATORS as Set<string>).has(part)) {
      flushCurrentCommand()
      continue
    }

    if (isRedirectionOperator(part) && currentCommand) {
      const nextPart = quotedParts[index + 1]
      if (
        nextPart &&
        !(SHELL_COMMAND_BOUNDARIES as Set<string>).has(nextPart) &&
        !isRedirectionOperator(nextPart)
      ) {
        currentCommand = appendRedirection(currentCommand, part, nextPart)
        index++
      } else {
        currentCommand = appendRedirection(currentCommand, part)
      }
      continue
    }

    appendPart(part)
  }

  flushCurrentCommand()
  return commandParts
}

export async function getCommandPrefix(
  command: string,
  abortSignal: AbortSignal,
  sessionId?: string,
): Promise<ExtractedCommandPrefix | null> {
  let response
  try {
    response = await queryQuick({
      systemPrompt: [
        {
          type: 'text',
          text: COMMAND_PREFIX_SYSTEM_PROMPT
        }
      ],
      userPrompt: COMMAND_PREFIX_USER_PROMPT(command),
      signal: abortSignal,
      enableLLMCache: false,
      sessionId,
    })
  } catch {
    return null
  }

  const prefix = (
    typeof response.message.content === 'string'
      ? response.message.content
      : Array.isArray(response.message.content)
        ? (response.message.content.find(_ => _.type === 'text')?.text ??
          'none')
        : 'none'
  ).trim()

  if (prefix.startsWith(API_ERR_PREFIX)) {
    return null
  }

  if (prefix === 'command_injection_detected') {
    return { commandInjectionDetected: true }
  }

  // 永远不接受基本`git`作为前缀（例如，如果未检测到`git diff`前缀）
  if (prefix === 'git') {
    return {
      commandPrefix: null,
      commandInjectionDetected: false,
    }
  }

  if (prefix === 'none') {
    return {
      commandPrefix: null,
      commandInjectionDetected: false,
    }
  }

  return {
    commandPrefix: prefix,
    commandInjectionDetected: false,
  }
}

const SHELL_LIST_SEPARATORS = new Set<ControlOperator>([
  '&&',
  '||',
  '|',
  '|&',
  '&',
  ';',
  ';;',
])

const SHELL_COMMAND_BOUNDARIES = new Set<string>([
  ...SHELL_LIST_SEPARATORS,
  '(',
  ')',
])

const SHELL_GROUPING_OPERATORS = new Set<string>([
  '(',
  ')',
])

const SHELL_REDIRECTION_OPERATORS = new Set<string>([
  '<',
  '>',
  '>>',
  '>|',
  '<>',
  '<&',
  '>&',
  '<<',
  '<<-',
  '<<<',
])

function isRedirectionOperator(part: string): boolean {
  return SHELL_REDIRECTION_OPERATORS.has(part) || /^\d*(?:<|>|>>|<&|>&)$/.test(part)
}

function appendRedirection(command: string, operator: string, target?: string): string {
  const fdMatch = command.match(/^(.*)\s+(\d+)$/)
  const prefix = fdMatch ? fdMatch[1]! : command
  const redirection = fdMatch ? `${fdMatch[2]}${operator}` : operator
  return target ? `${prefix} ${redirection} ${target}` : `${prefix} ${redirection}`
}
