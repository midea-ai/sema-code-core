/**
 * Markdown Frontmatter 解析工具
 *
 * 提供 YAML frontmatter 的提取和解析功能
 */

/**
 * Frontmatter 元数据类型
 */
export interface FrontmatterMetadata {
  [key: string]: string | string[] | undefined
}

/**
 * 从 Markdown 内容中提取 Frontmatter
 * @param content Markdown 文件内容
 * @returns [frontmatterText, bodyContent] 元组，如果没有 frontmatter 则返回 null
 */
export function extractFrontmatter(content: string): [string, string] | null {
  // 检查是否以 --- 开头
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return null
  }

  // 查找结束标记的位置
  const startOffset = content.startsWith('---\r\n') ? 5 : 4
  let endIndex = content.indexOf('\n---\n', startOffset)
  let endOffset = 5

  // 兼容 Windows 换行符
  if (endIndex === -1) {
    endIndex = content.indexOf('\r\n---\r\n', startOffset)
    endOffset = 7
  }

  if (endIndex === -1) {
    return null
  }

  const frontmatterText = content.slice(startOffset, endIndex)
  const bodyContent = content.slice(endIndex + endOffset).trim()

  return [frontmatterText, bodyContent]
}

/**
 * 解析 YAML frontmatter
 * 简单实现，支持基本的 key: value 格式
 * @param text frontmatter 文本（不包含 --- 分隔符）
 * @returns 解析后的元数据对象
 */
export function parseFrontmatter(text: string): FrontmatterMetadata {
  const metadata: FrontmatterMetadata = {}
  const length = text.length
  let lineStart = 0

  for (let i = 0; i <= length; i++) {
    // 遇到换行符或文件结尾时处理一行
    if (i === length || text[i] === '\n') {
      if (i > lineStart) {
        // 跳过行尾的 \r（Windows 换行符）
        const lineEnd = (i > 0 && text[i - 1] === '\r') ? i - 1 : i
        const line = text.slice(lineStart, lineEnd)

        // 跳过空行和注释行
        if (line && line[0] !== '#') {
          const colonIndex = line.indexOf(':')

          if (colonIndex !== -1) {
            // 提取 key（去除首尾空格）
            let keyStart = 0
            let keyEnd = colonIndex

            // 去除 key 前面的空格
            while (keyStart < keyEnd && (line[keyStart] === ' ' || line[keyStart] === '\t')) {
              keyStart++
            }

            // 去除 key 后面的空格
            while (keyEnd > keyStart && (line[keyEnd - 1] === ' ' || line[keyEnd - 1] === '\t')) {
              keyEnd--
            }

            const key = line.slice(keyStart, keyEnd)

            // 提取 value（去除首尾空格）
            let valueStart = colonIndex + 1
            let valueEnd = line.length

            // 去除 value 前面的空格
            while (valueStart < valueEnd && (line[valueStart] === ' ' || line[valueStart] === '\t')) {
              valueStart++
            }

            // 去除 value 后面的空格
            while (valueEnd > valueStart && (line[valueEnd - 1] === ' ' || line[valueEnd - 1] === '\t')) {
              valueEnd--
            }

            let value = line.slice(valueStart, valueEnd)

            // 移除引号（只检查首尾字符）
            if (value.length >= 2) {
              const firstChar = value[0]
              const lastChar = value[value.length - 1]
              if ((firstChar === '"' || firstChar === "'") && firstChar === lastChar) {
                value = value.slice(1, -1)
              }
            }

            if (key) {
              metadata[key] = value
            }
          }
        }
      }

      lineStart = i + 1
    }
  }

  return metadata
}

/**
 * 解析 Markdown 文件的 frontmatter
 * 结合 extractFrontmatter 和 parseFrontmatter 的便捷方法
 * @param content Markdown 文件内容
 * @returns { metadata, body } 对象，如果没有 frontmatter 则 metadata 为空对象
 */
export function parseMarkdownWithFrontmatter(content: string): {
  metadata: FrontmatterMetadata
  body: string
} {
  const extracted = extractFrontmatter(content)

  if (!extracted) {
    return {
      metadata: {},
      body: content.trim()
    }
  }

  const [frontmatterText, body] = extracted
  const metadata = parseFrontmatter(frontmatterText)

  return { metadata, body }
}
