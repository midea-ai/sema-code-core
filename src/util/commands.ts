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

type CommandPrefixExtractor = (command: string) => Promise<ExtractedCommandPrefix | null>

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

export async function getCommandSubcommandPrefix(
  command: string,
  abortSignal: AbortSignal,
): Promise<CommandPrefixWithSubcommands | null> {
  return buildCommandPrefixWithSubcommands(command, command => getCommandPrefix(command, abortSignal))
}

export async function buildCommandPrefixWithSubcommands(
  command: string,
  extractPrefix: CommandPrefixExtractor,
): Promise<CommandPrefixWithSubcommands | null> {
  const subCommands = splitCommand(command)

  if (subCommands.length < 2) {
    const fullCommandPrefix = await extractPrefix(command)
    if (!fullCommandPrefix) return null

    return {
      ...fullCommandPrefix,
      subcommandPrefixes: new Map<string, ExtractedCommandPrefix>(),
    }
  }

  const subcommandPrefixes = new Map<string, ExtractedCommandPrefix>()
  let commandInjectionDetected = false
  for (const subCommand of subCommands) {
    const subcommandPrefix = await extractPrefix(subCommand)
    if (!subcommandPrefix) return null
    subcommandPrefixes.set(subCommand, subcommandPrefix)
    if (subcommandPrefix.commandInjectionDetected) {
      commandInjectionDetected = true
    }
  }

  if (commandInjectionDetected) {
    return {
      commandInjectionDetected: true,
      subcommandPrefixes,
    }
  }

  return {
    commandPrefix: null,
    commandInjectionDetected: false,
    subcommandPrefixes,
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
