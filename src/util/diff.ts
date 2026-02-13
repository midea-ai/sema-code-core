import { type Hunk, structuredPatch } from 'diff'
import { relative } from 'path'
import { getCwd } from './cwd'
import { EOL } from 'os'

const CONTEXT_LINES = 3

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>'

const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>'

export function getPatch({
  filePath,
  fileContents,
  oldStr,
  newStr,
}: {
  filePath: string
  fileContents: string
  oldStr: string
  newStr: string
}): Hunk[] {
  return structuredPatch(
    filePath,
    filePath,
    fileContents.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN),
    fileContents
      .replaceAll('&', AMPERSAND_TOKEN)
      .replaceAll('$', DOLLAR_TOKEN)
      .replace(
        oldStr.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN),
        newStr.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN),
      ),
    undefined,
    undefined,
    { context: CONTEXT_LINES },
  ).hunks.map(_ => ({
    ..._,
    lines: _.lines.map(_ =>
      _.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$'),
    ),
  }))
}

// 获取更新摘要信息
export function getUpdateSummary(
  filePath: string,
  structuredPatch?: Hunk[]
): string {
  const patches = Array.isArray(structuredPatch) ? structuredPatch : []
  const relativePath = relative(getCwd(), filePath)

  // 计算添加和删除的行数
  const numAdditions = patches.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('+')).length,
    0,
  )
  const numRemovals = patches.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('-')).length,
    0,
  )

  // 构建基础信息
  let result = `Updated ${relativePath}`

  if (numAdditions > 0 || numRemovals > 0) {
    result += ' with '
    const changes = []

    if (numAdditions > 0) {
      changes.push(`${numAdditions} ${numAdditions > 1 ? 'additions' : 'addition'}`)
    }

    if (numRemovals > 0) {
      changes.push(`${numRemovals} ${numRemovals > 1 ? 'removals' : 'removal'}`)
    }

    result += changes.join(' and ')
  }

  return result
}

// 获取代码diff片段
export function getDiffContent(structuredPatch?: Hunk[]): string {
  const patches = Array.isArray(structuredPatch) ? structuredPatch : []

  if (patches.length === 0) {
    return ''
  }

  let result = ''

  patches.forEach((hunk, index) => {
    if (index > 0) {
      result += '\n...\n'
    }

    // 格式化每个hunk的行
    const formattedLines = formatDiffLines(hunk.lines, hunk.oldStart)
    result += formattedLines.join('\n') + '\n'
  })

  return result
}

// 格式化diff行，使用5位行号 + 标识符 + 代码的格式
function formatDiffLines(lines: string[], startingLineNumber: number): string[] {
  const numberedLines = numberDiffLines(
    lines.map(code => {
      if (code.startsWith('+')) {
        return {
          code: code.slice(1), // 移除开头的+/-符号
          type: 'add',
        }
      }
      if (code.startsWith('-')) {
        return {
          code: code.slice(1), // 移除开头的+/-符号
          type: 'remove',
        }
      }
      return { code, type: 'nochange' }
    }),
    startingLineNumber,
  )

  return numberedLines.map(({ type, code, i }) => {
    const lineNumber = i.toString().padStart(5) // 5位行号
    const changeChar = type === 'add' ? '+' : type === 'remove' ? '-' : ' '
    return `${lineNumber}${changeChar}${code}`
  })
}

// 为diff行分配行号
function numberDiffLines(
  diff: { code: string; type: string }[],
  startLine: number,
): { code: string; type: string; i: number }[] {
  let i = startLine
  const result: { code: string; type: string; i: number }[] = []
  const queue = [...diff]

  while (queue.length > 0) {
    const { code, type } = queue.shift()!
    const line = {
      code: code,
      type,
      i,
    }

    // 根据变更类型更新计数器
    switch (type) {
      case 'nochange':
        i++
        result.push(line)
        break
      case 'add':
        i++
        result.push(line)
        break
      case 'remove': {
        result.push(line)
        let numRemoved = 0
        while (queue[0]?.type === 'remove') {
          const { code, type } = queue.shift()!
          const line = {
            code: code,
            type,
            i: i + numRemoved + 1,
          }
          result.push(line)
          numRemoved++
        }
        i -= numRemoved
        break
      }
    }
  }

  return result
}
