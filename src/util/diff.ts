import { type Hunk, structuredPatch } from 'diff'
import { getDisplayPath } from './file'

const PATCH_SURROUNDING_LINES = 3

const SPECIAL_CHAR_MARKERS = {
  '&': '<<:AMPERSAND:>>',
  '$': '<<:DOLLAR:>>',
} as const

function escapeSpecialChars(str: string): string {
  return Object.entries(SPECIAL_CHAR_MARKERS).reduce(
    (s, [char, marker]) => s.replaceAll(char, marker), str,
  )
}

function unescapeSpecialChars(str: string): string {
  return Object.entries(SPECIAL_CHAR_MARKERS).reduce(
    (s, [char, marker]) => s.replaceAll(marker, char), str,
  )
}

interface PatchParams {
  filePath: string
  fileContents: string
  oldStr: string
  newStr: string
}

export function getPatch({ filePath, fileContents, oldStr, newStr }: PatchParams): Hunk[] {
  const escape = escapeSpecialChars
  const oldContent = escape(fileContents)
  const newContent = oldContent.replace(escape(oldStr), escape(newStr))

  const { hunks } = structuredPatch(filePath, filePath, oldContent, newContent, '', '', {
    context: PATCH_SURROUNDING_LINES,
  })

  return hunks.map(hunk => ({
    ...hunk,
    lines: hunk.lines.map(unescapeSpecialChars),
  }))
}

/**
 * 计算整文件 current → target 的 diff。
 * 强制按"整文件替换"语义调用 getPatch（oldStr === fileContents），
 * 避免误传部分字符串导致只替换首次匹配。
 */
export function diffContents(filePath: string, current: string, target: string): Hunk[] {
  return getPatch({ filePath, fileContents: current, oldStr: current, newStr: target })
}

/**
 * 整文件 diff 的统计：hunks、增删行数与首个变更行（新文件侧 1-based）。
 * 首个变更行跳过 hunk 头部上下文，指向第一处 +/- 落在新文件侧的行；纯删除指向删除后的位置。
 */
export function diffStats(filePath: string, current: string, target: string): {
  hunks: Hunk[]
  additions: number
  removals: number
  line: number
} {
  const hunks = diffContents(filePath, current, target)
  const { additions, removals } = countPatchLines(hunks)
  return { hunks, additions, removals, line: firstChangedLine(hunks) }
}

function firstChangedLine(hunks: Hunk[]): number {
  if (hunks.length === 0) return 1
  const [first] = hunks
  let line = first.newStart
  for (const l of first.lines) {
    if (l.startsWith('+') || l.startsWith('-')) break
    line++
  }
  return Math.max(1, line)
}

/**
 * 统计 hunks 的新增/删除行数（行首 + / -）。
 */
export function countPatchLines(patches?: Hunk[]): { additions: number; removals: number } {
  const hunks = patches ?? []
  const count = (prefix: string) =>
    hunks.reduce((c, hunk) => c + hunk.lines.filter(l => l.startsWith(prefix)).length, 0)
  return { additions: count('+'), removals: count('-') }
}

// 获取更新摘要信息
export function getUpdateSummary(filePath: string, patches?: Hunk[]): string {
  const hunks = patches ?? []
  const relativePath = getDisplayPath(filePath)

  const countLines = (prefix: string) =>
    hunks.reduce((count, hunk) => count + hunk.lines.filter(l => l.startsWith(prefix)).length, 0)

  const numAdditions = countLines('+')
  const numRemovals = countLines('-')

  if (numAdditions === 0 && numRemovals === 0) {
    return `Updated ${relativePath}`
  }

  const pluralize = (n: number, word: string) => `${n} ${n > 1 ? word + 's' : word}`
  const changes = [
    numAdditions > 0 && pluralize(numAdditions, 'addition'),
    numRemovals > 0 && pluralize(numRemovals, 'removal'),
  ].filter(Boolean)

  return `Updated ${relativePath} with ${changes.join(' and ')}`
}

// 获取代码diff片段
export function getDiffContent(patches?: Hunk[]): string {
  const hunks = patches ?? []
  if (hunks.length === 0) return ''

  return hunks
    .map(hunk => formatDiffLines(hunk.lines, hunk.oldStart).join('\n') + '\n')
    .join('\n...\n')
}

// 格式化diff行，使用5位行号 + 标识符 + 代码的格式
function formatDiffLines(lines: string[], startLine: number): string[] {
  const markerMap: Record<string, string> = { '+': '+', '-': '-' }
  const result: string[] = []
  let lineNum = startLine

  for (let idx = 0; idx < lines.length; ) {
    const prefix = lines[idx][0]
    const code = prefix === '+' || prefix === '-' ? lines[idx].slice(1) : lines[idx]
    const marker = markerMap[prefix] ?? ' '

    if (prefix !== '-') {
      result.push(`${lineNum.toString().padStart(5)}${marker}${code}`)
      lineNum++
      idx++
      continue
    }

    // 连续 remove 行分组处理，显示旧文件行号
    result.push(`${lineNum.toString().padStart(5)}-${code}`)
    idx++
    let extraRemoves = 0
    while (idx < lines.length && lines[idx][0] === '-') {
      result.push(`${(lineNum + extraRemoves + 1).toString().padStart(5)}-${lines[idx].slice(1)}`)
      extraRemoves++
      idx++
    }
    lineNum -= extraRemoves
  }

  return result
}
