
export const VIEW_FILE_MAX_LINES = 2000  // 最多读取行数
export const VIEW_FILE_MAX_LINE_LENGTH = 1500  // 单行最多保留字符数，超出截断

export const TOOL_DESCRIPTION = `Read any file from the local filesystem. All paths are assumed valid; non-existent files return an error.

Rules:
- file_path MUST be absolute
- Default: reads up to ${VIEW_FILE_MAX_LINES} lines from the start. Use start_line/max_lines for long files, but prefer reading the whole file
- Lines longer than ${VIEW_FILE_MAX_LINE_LENGTH} chars keep only the first ${VIEW_FILE_MAX_LINE_LENGTH} chars (rest replaced with a truncation marker)
- Output: cat -n format (line numbers from 1)

Supported formats:
- Text, code, config files
- Images (PNG, JPG, etc.) — ALWAYS read when user provides a screenshot path
- PDF — large PDFs (>10 pages) MUST use the pdf_page_range parameter (e.g., "1-3"), max 20 pages per call
- Jupyter notebooks (.ipynb) — returns all cells with outputs

NOT supported:
- Word (.doc/.docx) — use Bash to extract text instead
- Directories — use \`ls\` via Bash instead

Tips:
- Read multiple files in parallel when possible`
