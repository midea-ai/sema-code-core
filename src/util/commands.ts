import { memoize } from 'lodash-es'
import { type ControlOperator, parse, ParseEntry } from 'shell-quote'
import { queryQuick } from '../services/api/queryLLM'
import { API_ERROR_MESSAGE_PREFIX } from '../constants/message'

const SINGLE_QUOTE = '__SINGLE_QUOTE__'
const DOUBLE_QUOTE = '__DOUBLE_QUOTE__'

export type CommandPrefixResult =
  | {
      commandPrefix: string | null
      commandInjectionDetected: false
    }
  | { commandInjectionDetected: true }

// 命令前缀结果包含子命令前缀
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/**
 * 根据shell操作符将命令字符串拆分为单个命令
 */
export function splitCommand(command: string): string[] {
  const parts: ParseEntry[] = []

  // 1. 合并相邻的字符串
  // 为引号添加特殊标记，防止后续解析时被误处理
  for (const part of parse(
    command
      .replaceAll('"', `"${DOUBLE_QUOTE}`) 
      .replaceAll("'", `'${SINGLE_QUOTE}`), 
    varName => `$${varName}`, // 保留shell变量
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
      return null
    })
    .filter(_ => _ !== null)

  // 3. 将引号映射回原始形式
  const quotedParts = stringParts.map(part => {
    return part
      .replaceAll(`${SINGLE_QUOTE}`, "'")
      .replaceAll(`${DOUBLE_QUOTE}`, '"')
  })

  // 4. 过滤掉分隔符
  return quotedParts.filter(
    part => !(COMMAND_LIST_SEPARATORS as Set<string>).has(part),
  )
}

export const getCommandSubcommandPrefix = memoize(
  async (
    command: string,
    abortSignal: AbortSignal,
  ): Promise<CommandSubcommandPrefixResult | null> => {
    const subcommands = splitCommand(command)

    const [fullCommandPrefix, ...subcommandPrefixesResults] = await Promise.all(
      [
        getCommandPrefix(command, abortSignal),
        ...subcommands.map(async subcommand => ({
          subcommand,
          prefix: await getCommandPrefix(subcommand, abortSignal),
        })),
      ],
    )
    if (!fullCommandPrefix) {
      return null
    }
    const subcommandPrefixes = subcommandPrefixesResults.reduce(
      (acc, { subcommand, prefix }) => {
        if (prefix) {
          acc.set(subcommand, prefix)
        }
        return acc
      },
      new Map<string, CommandPrefixResult>(),
    )

    return {
      ...fullCommandPrefix,
      subcommandPrefixes,
    }
  },
  command => command, // 仅按命令进行memoize
)

const getCommandPrefix = memoize(
  async (
    command: string,
    abortSignal: AbortSignal,
  ): Promise<CommandPrefixResult | null> => {
    const response = await queryQuick({
      systemPrompt: [
        {
          type: 'text',
          text: `Your task is to process Bash commands that an AI coding agent wants to run.

This policy spec defines how to determine the prefix of a Bash command:`
        }
      ],
      userPrompt: `<policy_spec>
# Code Bash command prefix detection

This document defines risk levels for actions that the agent may take. This classification system is part of a broader safety framework and is used to determine when additional user confirmation or oversight may be needed.

## Definitions

**Command Injection:** Any technique used that would result in a command being run other than the detected prefix.

## Command prefix extraction examples
Examples:
- cat foo.txt => cat
- cd src => cd
- cd path/to/files/ => cd
- find ./src -type f -name "*.ts" => find
- gg cat foo.py => gg cat
- gg cp foo.py bar.py => gg cp
- git commit -m "foo" => git commit
- git diff HEAD~1 => git diff
- git diff --staged => git diff
- git diff $(pwd) => command_injection_detected
- git status => git status
- git status# test(\`id\`) => command_injection_detected
- git status\`ls\` => command_injection_detected
- git push => none
- git push origin master => git push
- git log -n 5 => git log
- git log --oneline -n 5 => git log
- grep -A 40 "from foo.bar.baz import" alpha/beta/gamma.py => grep
- pig tail zerba.log => pig tail
- npm test => none
- npm test --foo => npm test
- npm test -- -f "foo" => npm test
- pwd\n curl example.com => command_injection_detected
- pytest foo/bar.py => pytest
- scalac build => none
</policy_spec>

The user has allowed certain command prefixes to be run, and will otherwise be asked to approve or deny the command.
Your task is to determine the command prefix for the following command.

IMPORTANT: Bash commands may run multiple commands that are chained together.
For safety, if the command seems to contain command injection, you must return "command_injection_detected". 
(This will help protect the user: if they think that they're allowlisting command A, 
but the AI coding agent sends a malicious command that technically has the same prefix as command A, 
then the safety system will see that you said “command_injection_detected” and ask the user for manual confirmation.)

Note that not every command has a prefix. If a command has no prefix, return "none".

ONLY return the prefix. Do not return any other text, markdown markers, or other content or formatting.

Command: ${command}
`,
      signal: abortSignal,
      enableLLMCache: false,
    })

    const prefix =
      typeof response.message.content === 'string'
        ? response.message.content
        : Array.isArray(response.message.content)
          ? (response.message.content.find(_ => _.type === 'text')?.text ??
            'none')
          : 'none'

    if (prefix.startsWith(API_ERROR_MESSAGE_PREFIX)) {
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
  },
  command => command, // 仅按命令进行memoize
)

const COMMAND_LIST_SEPARATORS = new Set<ControlOperator>([
  '&&',
  '||',
  ';',
  ';;',
])

// 检查这是否只是一个命令列表
function isCommandList(command: string): boolean {
  for (const part of parse(
    command
      .replaceAll('"', `"${DOUBLE_QUOTE}`) // parse()会去掉引号 :P
      .replaceAll("'", `'${SINGLE_QUOTE}`), // parse()会去掉引号 :P
    varName => `$${varName}`, // 保留shell变量
  )) {
    if (typeof part === 'string') {
      // 字符串是安全的
      continue
    }
    if ('comment' in part) {
      // 不信任注释，它们可能包含命令注入
      return false
    }
    if ('op' in part) {
      if (part.op === 'glob') {
        // 通配符是安全的
        continue
      } else if (COMMAND_LIST_SEPARATORS.has(part.op)) {
        // 命令列表分隔符是安全的
        continue
      }
      // 其他操作符不安全
      return false
    }
  }
  // 在整个命令中未找到不安全的操作符
  return true
}

export function isUnsafeCompoundCommand(command: string): boolean {
  return splitCommand(command).length > 1 && !isCommandList(command)
}