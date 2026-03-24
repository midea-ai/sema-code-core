const HEAD_TAIL_LINES = 100

export function formatOutput(content: string, headTailLines = HEAD_TAIL_LINES): {
  totalLines: number
  truncatedContent: string
} {
  const lines = content.split('\n')
  const totalLines = lines.length

  if (totalLines <= headTailLines * 2) {
    return { totalLines, truncatedContent: content }
  }

  const firstLines = lines.slice(0, headTailLines)
  const lastLines = lines.slice(-headTailLines)
  const skippedCount = totalLines - headTailLines * 2

  const truncatedContent = [
    ...firstLines,
    `\n... [${skippedCount} lines truncated] ...\n`,
    ...lastLines,
  ].join('\n')

  return { totalLines, truncatedContent }
}
