import { type ControlOperator, parse, ParseEntry } from 'shell-quote'
import { queryQuick } from '../services/api/queryLLM'
import { API_ERR_PREFIX } from './message'
import { COMMAND_PREFIX_SYSTEM_PROMPT, COMMAND_PREFIX_USER_PROMPT } from '../prompt/commands'

const SQ_PLACEHOLDER = '__SQ_PLACEHOLDER__'
const DQ_PLACEHOLDER = '__DQ_PLACEHOLDER__'

export type ExtractedCommandPrefix =
  | {
      commandPrefix: string | null
      commandInjectionDetected: false
    }
  | { commandInjectionDetected: true }

// 命令前缀结果包含子命令前缀
export type CommandPrefixWithSubcommands = ExtractedCommandPrefix & {
  subcommandPrefixes: Map<string, ExtractedCommandPrefix>
}

/**
 * 根据shell操作符将命令字符串拆分为单个命令
 */
export function splitCommand(command: string): string[] {
  const parts: ParseEntry[] = []

  // 1. 合并相邻的字符串
  for (const part of parse(
    command
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
  })

  // 4. 过滤掉分隔符
  return quotedParts.filter(
    part => !(SHELL_LIST_SEPARATORS as Set<string>).has(part),
  )
}

export async function getCommandSubcommandPrefix(
  command: string,
  abortSignal: AbortSignal,
): Promise<CommandPrefixWithSubcommands | null> {
  const fullCommandPrefix = await getCommandPrefix(command, abortSignal)
  if (!fullCommandPrefix) {
    return null
  }

  return {
    ...fullCommandPrefix,
    subcommandPrefixes: new Map<string, ExtractedCommandPrefix>(),
  }
}

async function getCommandPrefix(
  command: string,
  abortSignal: AbortSignal,
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
  ';',
  ';;',
])
