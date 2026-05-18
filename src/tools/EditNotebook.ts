import { type Hunk } from 'diff'
import { existsSync,  statSync } from 'fs'
import { extname, relative } from 'path'
import { z } from 'zod'
import { Tool } from './base/Tool'
import { NotebookCellType, NotebookContent } from '../types/notebook'
import {
  inferFileEncoding,
  inferLineEndings,
  writeTextFile,
  canonicalizeFilePath,
  readTextContent
} from '../util/file'
import { safeParseJSON } from '../util/format'
import { getPatch } from '../util/diff'
import { TOOL_NAME_EDIT_NOTEBOOK, TOOL_NAME_PATCH_FILE } from '../prompt/tool'
import { getStateManager } from '../manager/StateManager'
import { readInitialCwd } from '../util/cwd'

function getTitle(input?: { notebook_path?: string; cell_index?: number }) {
  if (input?.notebook_path) {
    const normalizedPath = canonicalizeFilePath(input.notebook_path)
    const relativePath = relative(readInitialCwd(), normalizedPath)
    if (input.cell_index !== undefined) {
      return `${relativePath} cell:${input.cell_index}`
    }
    return relativePath
  }
  return TOOL_NAME_EDIT_NOTEBOOK
}

const EDIT_VERBS = { insert: 'Create', delete: 'Delete', replace: 'Update' } as const

function normalizeLF(s: string) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function readCellSource(notebook: NotebookContent, cellNumber: number): string {
  const raw = notebook.cells[cellNumber]?.source
  return Array.isArray(raw) ? raw.join('') : (raw ?? '')
}

function computePatch(filePath: string, oldSource: string, newSource: string) {
  const old_ = normalizeLF(oldSource)
  const new_ = normalizeLF(newSource)
  return getPatch({ filePath, fileContents: old_, oldStr: old_, newStr: new_ })
}

const toolParams = z.strictObject({
  notebook_path: z
    .string()
    .describe(
      'Absolute path to the .ipynb notebook file (must not be a relative path)',
    ),
  cell_index: z.number().describe('Zero-based index of the target cell'),
  source: z.string().default('').describe('Replacement source content for the cell'),
  cell_type: z
    .enum(['code', 'markdown'])
    .optional()
    .describe(
      'Cell type: "code" or "markdown". Defaults to the existing cell type when replacing. Required when command is "insert".',
    ),
  command: z
    .enum(['replace', 'insert', 'delete'])
    .optional()
    .describe(
      'Operation to perform: "replace" overwrites the cell, "insert" adds a new cell at the position, "delete" removes the cell. Defaults to "replace".',
    ),
})

export const EditNotebook = {
  name: TOOL_NAME_EDIT_NOTEBOOK,
  description() {
    return `Replace a cell's source in a Jupyter notebook (.ipynb). notebook_path must be absolute. cell_index is 0-indexed.
command=insert: add new cell at index. command=delete: remove cell at index.`
  },
  toolParams,
  isSafe() {
    return false
  },
  genResultForAssistant({ cell_index, command, source, error }) {
    if (error) return error
    const verbs = { replace: 'updated to', insert: 'inserted with content', delete: 'deleted' }
    const verb = verbs[command as keyof typeof verbs]
    return command === 'delete'
      ? `Deleted cell ${cell_index}`
      : `Cell ${cell_index} ${verb}: ${source}`
  },
  genToolPermission(input) {
    const editMode = (input.command ?? 'replace') as keyof typeof EDIT_VERBS
    const title = `${EDIT_VERBS[editMode]} Cell - ${getTitle(input)}`

    let oldSource = ''
    if (editMode !== 'insert') {
      const fullPath = canonicalizeFilePath(input.notebook_path)
      if (existsSync(fullPath)) {
        const notebook = safeParseJSON(readTextContent(fullPath).content) as NotebookContent | null
        if (notebook && input.cell_index < notebook.cells.length) {
          oldSource = readCellSource(notebook, input.cell_index)
        }
      }
    }

    const newSource = editMode === 'delete' ? '' : (input.source ?? '')
    const patch = computePatch(input.notebook_path, oldSource, newSource)
    return { title, content: { type: 'diff', patch, diffText: '' } }
  },
  genToolResultMessage({ notebook_path, cell_index, command, structuredPatch, error }) {
    const title = getTitle({ notebook_path, cell_index })
    if (error) {
      return { title, summary: `Failed to edit cell ${cell_index}`, content: error }
    }
    const verb = EDIT_VERBS[command as keyof typeof EDIT_VERBS]
    return { title, summary: `${verb} ${title}`, content: { type: 'diff', patch: structuredPatch ?? [], diffText: '' } }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async validateInput(input, agentContext: any) {
    const {
      notebook_path,
      cell_index,
      cell_type,
      command = 'replace',
    } = input

    const fullPath = canonicalizeFilePath(notebook_path)

    if (!existsSync(fullPath)) {
      return {
        result: false,
        message: 'The specified notebook file was not found.',
      }
    }

    // 时间戳校验：确保文件已被读取且未被意外修改
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const readTimestamp = agentState.getReadFileTimestamp(fullPath)
    if (!readTimestamp) {
      return {
        result: false,
        message: 'You need to read the notebook before editing it.',
      }
    }
    const lastWriteTime = statSync(fullPath).mtimeMs
    if (lastWriteTime > readTimestamp) {
      return {
        result: false,
        message: 'The file was modified externally since last read. Please re-read it before editing.',
      }
    }

    if (extname(fullPath) !== '.ipynb') {
      return {
        result: false,
        message:
          `Only .ipynb files are supported here — use the ${TOOL_NAME_PATCH_FILE} tool for other file types.`,
      }
    }

    if (cell_index < 0) {
      return {
        result: false,
        message: 'Cell number cannot be negative.',
      }
    }

    if (command === 'insert' && !cell_type) {
      return {
        result: false,
        message: 'cell_type is required when inserting a new cell.',
      }
    }


    const fileData = readTextContent(fullPath)
    const notebook = safeParseJSON(fileData.content) as NotebookContent | null
    if (!notebook) {
      return {
        result: false,
        message: 'The notebook content is not valid JSON.',
      }
    }

    if (command === 'insert' && cell_index > notebook.cells.length) {
      return {
        result: false,
        message: `Cell number out of range — for insert mode, the maximum is ${notebook.cells.length} (appends at end).`,
      }
    } else if (
      (command === 'replace' || command === 'delete') &&
      (cell_index >= notebook.cells.length || !notebook.cells[cell_index])
    ) {
      return {
        result: false,
        message: `Cell number out of range — the notebook only has ${notebook.cells.length} cells.`,
      }
    }

    return { result: true }
  },
  async *call(input, agentContext: any) {
    const { notebook_path, cell_index, cell_type, command } = input
    const source = input.source
    const fullPath = canonicalizeFilePath(notebook_path)

    const makeData = (overrides: { language?: string; error?: string; structuredPatch?: Hunk[] }) => ({
      notebook_path,
      cell_index,
      source,
      cell_type: cell_type ?? 'code',
      language: overrides.language ?? 'python',
      command: command ?? 'replace',
      error: overrides.error ?? '',
      structuredPatch: overrides.structuredPatch ?? ([] as Hunk[]),
    })

    try {
      const notebook = JSON.parse(readTextContent(fullPath).content) as NotebookContent
      const language = notebook.metadata.language_info?.name ?? 'python'

      const originalSource = (command !== 'insert' && notebook.cells[cell_index])
        ? readCellSource(notebook, cell_index)
        : ''

      if (command === 'delete') {
        notebook.cells.splice(cell_index, 1)
      } else if (command === 'insert') {
        const new_cell = { cell_type: cell_type!, source, metadata: {} }
        notebook.cells.splice(cell_index, 0,
          cell_type === 'markdown' ? new_cell : { ...new_cell, outputs: [] })
      } else {
        const targetCell = notebook.cells[cell_index]!
        targetCell.source = source
        targetCell.execution_count = undefined
        targetCell.outputs = []
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type
        }
      }

      // 权限确认后二次校验时间戳，防止用户在权限对话框期间修改文件
      const agentState = getStateManager().forAgent(agentContext)
      const readTimestamp = agentState.getReadFileTimestamp(fullPath)
      if (readTimestamp && statSync(fullPath).mtimeMs > readTimestamp) {
        throw new Error('The file changed while awaiting permission. Please re-read it before editing.')
      }

      writeTextFile(fullPath, JSON.stringify(notebook, null, 1), inferFileEncoding(fullPath), inferLineEndings(fullPath))

      const structuredPatch = computePatch(notebook_path, originalSource, command === 'delete' ? '' : source)
      const data = makeData({ language, structuredPatch })
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred while editing the notebook.'
      const data = makeData({ error: message })
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
    }
  },
} satisfies Tool<
  typeof toolParams,
  {
    notebook_path: string
    cell_index: number
    source: string
    cell_type: NotebookCellType
    language: string
    command: string
    error?: string
    structuredPatch: Hunk[]
  }
>
