import { readFileSync } from 'fs'
import {
  NotebookContent,
  NotebookCell,
  NotebookCellRawOutput,
  NotebookOutputImage,
  NotebookCellData,
  NotebookCellOutput,
} from '../types/notebook'
import { formatOutput } from './shell'

function processNotebookOutput(output: NotebookCellRawOutput): NotebookCellOutput {
  const { output_type } = output

  let rawText: string | string[] | undefined
  let image: NotebookOutputImage | undefined

  if (output_type === 'stream') {
    rawText = output.text
  } else if (output_type === 'execute_result' || output_type === 'display_data') {
    rawText = output.data?.['text/plain'] as string | string[] | undefined
    if (output.data) {
      for (const type of ['image/png', 'image/jpeg'] as const) {
        if (typeof output.data[type] === 'string') {
          image = { image_data: output.data[type] as string, media_type: type }
          break
        }
      }
    }
  } else if (output_type === 'error') {
    rawText = `${output.ename}: ${output.evalue}\n${output.traceback?.join('\n') || ''}`
  }

  const normalizedText = rawText == null ? '' : formatOutput(Array.isArray(rawText) ? rawText.join('') : rawText).truncatedContent

  return { output_type, text: normalizedText, image }
}

export function loadNotebook(filePath: string): {
  cells: NotebookCellData[]
  cellCount: number
} {
  const fileContent = readFileSync(filePath, 'utf-8')
  const notebook = JSON.parse(fileContent) as NotebookContent
  const language = notebook.metadata.language_info?.name ?? 'python'

  const cells = notebook.cells.map((cell, index) => {
    const cellData: NotebookCellData = {
      cell: index,
      cellType: cell.cell_type,
      source: Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? ''),
      language,
      execution_count: cell.execution_count,
    }

    if (cell.outputs?.length) {
      cellData.outputs = cell.outputs.map(processNotebookOutput)
    }

    return cellData
  })

  return {
    cells,
    cellCount: cells.length,
  }
}

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
