import { readFileSync } from 'fs'
import { inferFileEncoding, canonicalizeFilePath } from './file'
import { type Hunk } from 'diff'
import { getPatch } from './diff'

export function normalizeLF(str: string): string {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function applyEdit(
  file_path: string,
  old_string: string,
  new_string: string,
  replace_all: boolean = false,
): { patch: Hunk[]; updatedFile: string } {
  const fullFilePath = canonicalizeFilePath(file_path)

  let originalFile: string
  let updatedFile: string

  if (old_string === '') {
    originalFile = ''
    updatedFile = normalizeLF(new_string)
  } else {
    const enc = inferFileEncoding(fullFilePath)
    originalFile = normalizeLF(readFileSync(fullFilePath, enc))

    const oldStr = normalizeLF(old_string)
    const newStr = normalizeLF(new_string)
    // 函数式替换：字符串形式会把 replacement 里的美元符号当替换模式展开，写出与意图不符的内容
    const doReplace = replace_all
      ? (s: string, from: string, to: string) => s.replaceAll(from, () => to)
      : (s: string, from: string, to: string) => s.replace(from, () => to)

    // 删除操作时，尝试连带删除尾部换行以避免留空行
    const searchStr = newStr === '' && !oldStr.endsWith('\n') && originalFile.includes(oldStr + '\n')
      ? oldStr + '\n'
      : oldStr

    updatedFile = doReplace(originalFile, searchStr, newStr)

    if (updatedFile === originalFile) {
      throw new Error('No changes detected, edit failed.')
    }
  }

  const patch = getPatch({
    filePath: file_path,
    fileContents: originalFile,
    oldStr: originalFile,
    newStr: updatedFile,
  })

  return { patch, updatedFile }
}

/**
 * search_text 的匹配总数，以及前 limit 处匹配的起始行号（1-based）。
 * 用 indexOf 逐次推进：大文件里比 split 少分配一份数组。
 */
export function findOccurrences(file: string, searchText: string, limit = 5): { count: number; lines: number[] } {
  const lines: number[] = []
  let count = 0
  if (!searchText) return { count, lines }

  let from = 0
  for (;;) {
    const idx = file.indexOf(searchText, from)
    if (idx === -1) return { count, lines }
    count++
    if (lines.length < limit) lines.push(lineNumberAt(file, idx))
    from = idx + searchText.length
  }
}

function lineNumberAt(file: string, index: number): number {
  return file.slice(0, index).split('\n').length
}
