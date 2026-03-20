import fs from 'fs'

export interface ClaudeFileMetadata {
  [key: string]: string | string[] | undefined
}

export interface ClaudeFileParsed {
  metadata: ClaudeFileMetadata
  prompt: string
}

/**
 * 从文件路径解析 skill/command/agent 文件
 */
export function parseFile(filePath: string): ClaudeFileParsed {
  const content = fs.readFileSync(filePath, 'utf-8')
  return parseContent(content)
}

/**
 * 从字符串内容解析 skill/command/agent 文件
 */
export function parseContent(content: string): ClaudeFileParsed {
  // 找到行首的第一个 ---（--- 前面的内容丢弃）
  const firstDash = findFrontmatterStart(content)
  if (firstDash === -1) {
    return { metadata: {}, prompt: content.trim() }
  }

  const afterFirst = firstDash + 3

  // 结束标记必须独占一行，兼容 \r\n
  let endIndex = content.indexOf('\n---\n', afterFirst)
  let endOffset = 5

  if (endIndex === -1) {
    endIndex = content.indexOf('\r\n---\r\n', afterFirst)
    endOffset = 7
  }

  // 兼容文件末尾 ---\n 或 ---EOF
  if (endIndex === -1) {
    endIndex = content.indexOf('\n---', afterFirst)
    endOffset = 4
  }

  if (endIndex === -1) {
    return { metadata: {}, prompt: content.trim() }
  }

  const yamlRaw = content.slice(afterFirst, endIndex).trim()
  const prompt = content.slice(endIndex + endOffset).trim()

  return {
    metadata: parseYaml(yamlRaw),
    prompt,
  }
}

/**
 * 找到行首的第一个 ---
 * 允许 --- 前有任意内容，但 --- 本身必须在行首
 */
function findFrontmatterStart(content: string): number {
  let idx = content.indexOf('---')
  while (idx !== -1) {
    if (idx === 0 || content[idx - 1] === '\n') return idx
    idx = content.indexOf('---', idx + 3)
  }
  return -1
}

/**
 * 简单 YAML 解析
 * 支持：字符串、带引号字符串、["a","b"] 风格数组、行内注释、块标量（| 和 >）
 */
function parseYaml(yamlStr: string): ClaudeFileMetadata {
  const result: ClaudeFileMetadata = {}
  const lines = yamlStr.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    let line = lines[i]

    // 去除行内注释（保留 value 中的 # 不受影响，仅去除空格后的 #）
    const commentIdx = line.indexOf(' #')
    if (commentIdx !== -1) line = line.slice(0, commentIdx)
    line = line.trim()

    if (!line || line.startsWith('#')) {
      i++
      continue
    }

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      i++
      continue
    }

    const key = line.slice(0, colonIdx).trim()
    if (!key) {
      i++
      continue
    }

    let value = line.slice(colonIdx + 1).trim()

    // 块标量：|（字面量）或 >（折叠）
    if (value === '|' || value === '>') {
      const isFolded = value === '>'
      i++
      const blockLines: string[] = []
      let baseIndent = -1
      while (i < lines.length) {
        const raw = lines[i].replace(/\r$/, '')
        if (raw.trim() === '') {
          blockLines.push('')
          i++
          continue
        }
        const indent = raw.length - raw.trimStart().length
        if (baseIndent === -1) baseIndent = indent
        if (indent < baseIndent) break
        blockLines.push(raw.slice(baseIndent))
        i++
      }
      // 移除末尾空行
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
        blockLines.pop()
      }
      result[key] = isFolded ? blockLines.join(' ') : blockLines.join('\n')
      continue
    }

    // 数组格式：["a", "b"] 或 ['a', 'b'] 或 [a, b]
    // 排除多括号组形式如 [pr-number] [priority]（内层含 ]）
    if (value.startsWith('[') && value.endsWith(']') && !value.slice(1, -1).includes(']')) {
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map(v => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      i++
      continue
    }

    // 去除首尾引号
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' || first === "'") && first === last) {
        value = value.slice(1, -1)
      }
    }

    result[key] = value
    i++
  }

  return result
}
