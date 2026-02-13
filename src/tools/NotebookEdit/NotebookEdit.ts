import { existsSync, readFileSync } from 'fs'
import { extname, isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from '../base/Tool'
import { NotebookCellType, NotebookContent } from '../../types/notebook'
import {
  detectFileEncoding,
  detectLineEndings,
  writeTextContent,
  normalizeFilePath,
} from '../../util/file'
import { safeParseJSON } from '../../util/format'
import { getCwd } from '../../util/cwd'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'


// 辅助函数：生成显示标题
function getTitle(input?: { notebook_path?: string; cell_number?: number }) {
  if (input?.notebook_path) {
    const normalizedPath = normalizeFilePath(input.notebook_path)
    const relativePath = relative(getCwd(), normalizedPath)
    // 如果有 cell_number，返回 "analysis.ipynb cell:4" 格式
    // 如果没有 cell_number，只返回 "analysis.ipynb"
    if (input.cell_number !== undefined) {
      return `${relativePath} cell:${input.cell_number}`
    }
    return relativePath
  }
  return TOOL_NAME_FOR_PROMPT
}

const inputSchema = z.strictObject({
  notebook_path: z
    .string()
    .describe(
      'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
    ),
  cell_number: z.number().describe('The index of the cell to edit (0-based)'),
  new_source: z.string().describe('The new source for the cell'),
  cell_type: z
    .enum(['code', 'markdown'])
    .optional()
    .describe(
      'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
    ),
  edit_mode: z
    .enum(['replace', 'insert', 'delete'])
    .optional()
    .describe(
      'The type of edit to make (replace, insert, delete). Defaults to replace.',
    ),
})

export const NotebookEditTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  genResultForAssistant({ cell_number, edit_mode, new_source, error }) {
    if (error) {
      return error
    }
    switch (edit_mode) {
      case 'replace':
        return `Updated cell ${cell_number} with ${new_source}`
      case 'insert':
        return `Inserted cell ${cell_number} with ${new_source}`
      case 'delete':
        return `Deleted cell ${cell_number}`
      default:
        return `Modified cell ${cell_number}`
    }
  },
  genToolPermission(input) {
    const title = getTitle(input)
    const content = input.new_source
    return { title, content }
  },
  genToolResultMessage({ notebook_path, cell_number, new_source, error }) {
    const title = getTitle({ notebook_path })
    if (error) {
      const summary = `Failed to edit cell ${cell_number}`
      const content = error
      return { title, summary, content }
    }
    const summary = `Updated cell ${cell_number}`
    const content = new_source
    return { title, summary, content }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async validateInput(input) {
    const {
      notebook_path,
      cell_number,
      cell_type,
      edit_mode = 'replace',
    } = input

    const fullPath = normalizeFilePath(notebook_path)

    if (!existsSync(fullPath)) {
      return {
        result: false,
        message: 'Notebook file does not exist.',
      }
    }

    if (extname(fullPath) !== '.ipynb') {
      return {
        result: false,
        message:
          'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.',
      }
    }

    if (cell_number < 0) {
      return {
        result: false,
        message: 'Cell number must be non-negative.',
      }
    }

    if (
      edit_mode !== 'replace' &&
      edit_mode !== 'insert' &&
      edit_mode !== 'delete'
    ) {
      return {
        result: false,
        message: 'Edit mode must be replace, insert, or delete.',
      }
    }

    if (edit_mode === 'insert' && !cell_type) {
      return {
        result: false,
        message: 'Cell type is required when using edit_mode=insert.',
      }
    }

    const enc = detectFileEncoding(fullPath)
    const content = readFileSync(fullPath, enc)
    const notebook = safeParseJSON(content) as NotebookContent | null
    if (!notebook) {
      return {
        result: false,
        message: 'Notebook is not valid JSON.',
      }
    }

    if (edit_mode === 'insert' && cell_number > notebook.cells.length) {
      return {
        result: false,
        message: `Cell number is out of bounds. For insert mode, the maximum value is ${notebook.cells.length} (to append at the end).`,
      }
    } else if (
      (edit_mode === 'replace' || edit_mode === 'delete') &&
      (cell_number >= notebook.cells.length || !notebook.cells[cell_number])
    ) {
      return {
        result: false,
        message: `Cell number is out of bounds. Notebook has ${notebook.cells.length} cells.`,
      }
    }

    return { result: true }
  },
  async *call(input) {
    const {
      notebook_path,
      cell_number,
      new_source,
      cell_type,
      edit_mode,
    } = input
    const fullPath = normalizeFilePath(notebook_path)

    try {
      const enc = detectFileEncoding(fullPath)
      const content = readFileSync(fullPath, enc)
      const notebook = JSON.parse(content) as NotebookContent
      const language = notebook.metadata.language_info?.name ?? 'python'

      if (edit_mode === 'delete') {
        // Delete the specified cell
        notebook.cells.splice(cell_number, 1)
      } else if (edit_mode === 'insert') {
        // Insert the new cell
        const new_cell = {
          cell_type: cell_type!, // validateInput ensures cell_type is not undefined
          source: new_source,
          metadata: {},
        }
        notebook.cells.splice(
          cell_number,
          0,
          cell_type == 'markdown' ? new_cell : { ...new_cell, outputs: [] },
        )
      } else {
        // Find the specified cell
        const targetCell = notebook.cells[cell_number]! // validateInput ensures cell_number is in bounds
        targetCell.source = new_source
        // Reset execution count and clear outputs since cell was modified
        targetCell.execution_count = undefined
        targetCell.outputs = []
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type
        }
      }
      // Write back to file
      const endings = detectLineEndings(fullPath)
      const updatedNotebook = JSON.stringify(notebook, null, 1)
      writeTextContent(fullPath, updatedNotebook, enc, endings!)

      const data = {
        notebook_path,
        cell_number,
        new_source,
        cell_type: cell_type ?? 'code',
        language,
        edit_mode: edit_mode ?? 'replace',
        error: '',
      }
      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
    } catch (error) {
      if (error instanceof Error) {
        const data = {
          notebook_path,
          cell_number,
          new_source,
          cell_type: cell_type ?? 'code',
          language: 'python',
          edit_mode: 'replace',
          error: error.message,
        }
        yield {
          type: 'result',
          data,
          resultForAssistant: this.genResultForAssistant(data),
        }
        return
      }
      const data = {
        notebook_path,
        cell_number,
        new_source,
        cell_type: cell_type ?? 'code',
        language: 'python',
        edit_mode: 'replace',
        error: 'Unknown error occurred while editing notebook',
      }
      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
    }
  },
} satisfies Tool<
  typeof inputSchema,
  {
    notebook_path: string
    cell_number: number
    new_source: string
    cell_type: NotebookCellType
    language: string
    edit_mode: string
    error?: string
  }
>
