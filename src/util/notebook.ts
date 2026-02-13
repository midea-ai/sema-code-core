import { readFileSync } from 'fs'
import {
  NotebookContent,
  NotebookCell,
  NotebookCellRawOutput,
  NotebookOutputImage,
  NotebookCellData,
  NotebookCellOutput,
} from '../types/notebook'
import { formatOutput } from '../tools/Bash/utils'

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return ''
  const rawText = Array.isArray(text) ? text.join('') : text
  const { truncatedContent } = formatOutput(rawText)
  return truncatedContent
}

function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  if (typeof data['image/png'] === 'string') {
    return {
      image_data: data['image/png'] as string,
      media_type: 'image/png',
    }
  }
  if (typeof data['image/jpeg'] === 'string') {
    return {
      image_data: data['image/jpeg'] as string,
      media_type: 'image/jpeg',
    }
  }
  return undefined
}

function processNotebookOutput(output: NotebookCellRawOutput): NotebookCellOutput {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      }
    case 'execute_result':
    case 'display_data':
      return {
        output_type: output.output_type,
        text: processOutputText(output.data?.['text/plain'] as string | string[] | undefined),
        image: output.data && extractImage(output.data),
      }
    case 'error':
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${output.traceback?.join('\n') || ''}`,
        ),
      }
  }
}

function processNotebookCell(
  cell: NotebookCell,
  index: number,
  language: string,
): NotebookCellData {
  const cellData: NotebookCellData = {
    cell: index,
    cellType: cell.cell_type,
    source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    language,
    execution_count: cell.execution_count,
  }

  if (cell.outputs?.length) {
    cellData.outputs = cell.outputs.map(processNotebookOutput)
  }

  return cellData
}

/**
 * 读取并解析 Jupyter Notebook 文件
 */
export function readNotebook(filePath: string): {
  cells: NotebookCellData[]
  cellCount: number
} {
  const fileContent = readFileSync(filePath, 'utf-8')
  const notebook = JSON.parse(fileContent) as NotebookContent
  const language = notebook.metadata.language_info?.name ?? 'python'

  const cells = notebook.cells.map((cell, index) =>
    processNotebookCell(cell, index, language)
  )

  return {
    cells,
    cellCount: cells.length,
  }
}

/**
 * 将 notebook cells 格式化为字符串
 * 格式: <cell id="1"><cell_type>markdown</cell_type>content</cell id="1">
 */
export function formatNotebookCells(cells: NotebookCellData[]): string {
  return cells.map(cell => {
    const cellId = String(cell.cell + 1)
    let cellContent = ''

    // 添加 cell type（仅用于 markdown）
    if (cell.cellType === 'markdown') {
      cellContent = `<cell_type>${cell.cellType}</cell_type>${cell.source}`
    } else {
      cellContent = cell.source
    }

    // 添加输出（如果有）
    if (cell.outputs && cell.outputs.length > 0) {
      const outputText = cell.outputs
        .map(output => output.text)
        .filter(Boolean)
        .join('\n')
      if (outputText) {
        cellContent += `\n\nOutput:\n${outputText}`
      }
    }

    return `<cell id="${cellId}">${cellContent}</cell id="${cellId}">`
  }).join('\n')
}
