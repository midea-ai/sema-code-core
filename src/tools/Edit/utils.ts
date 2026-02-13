import { readFileSync } from 'fs'
import { detectFileEncoding, normalizeFilePath } from '../../util/file'
import { type Hunk } from 'diff'
import { getPatch } from '../../util/diff'

/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
export function applyEdit(
  file_path: string,
  old_string: string,
  new_string: string,
  replace_all: boolean = false,
): { patch: Hunk[]; updatedFile: string } {
  const fullFilePath = normalizeFilePath(file_path)

  let originalFile
  let updatedFile
  if (old_string === '') {
    // Create new file
    originalFile = ''
    updatedFile = new_string
  } else {
    // Edit existing file
    const enc = detectFileEncoding(fullFilePath)
    originalFile = readFileSync(fullFilePath, enc)
    const replaceFunc = replace_all
      ? (str: string, search: string, replacement: string) => str.replaceAll(search, replacement)
      : (str: string, search: string, replacement: string) => str.replace(search, replacement)

    if (new_string === '') {
      if (
        !old_string.endsWith('\n') &&
        originalFile.includes(old_string + '\n')
      ) {
        updatedFile = replaceFunc(originalFile, old_string + '\n', new_string)
      } else {
        updatedFile = replaceFunc(originalFile, old_string, new_string)
      }
    } else {
      updatedFile = replaceFunc(originalFile, old_string, new_string)
    }
    if (updatedFile === originalFile) {
      throw new Error(
        'Original and edited file match exactly. Failed to apply edit.',
      )
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
