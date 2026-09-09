// MCP 工具定义与结果格式化。定义写在桥接进程里，扩展离线时 sema-core 启动仍能拿到工具列表。

const TAB_ID = {
  type: 'integer',
  description: 'Tab id from tabs_list or tabs_open. Required; there is no default tab.',
}
const REF = {
  type: 'string',
  description: 'Element ref from the latest read_page of this tab, e.g. "e12". Refs expire after navigation or the next full read_page.',
}
const DIALOG = {
  type: 'string',
  enum: ['dismiss', 'accept'],
  description:
    'How to answer a native confirm/prompt the page raises during this action. "dismiss" (default): confirm returns false, prompt returns null, so the guarded action does not happen. "accept": confirm returns true, prompt returns dialog_input or its default value. Use "accept" when the dialog only re-asks the action the user just ordered, or when they asked to auto-confirm dialogs; if the dialog mentions consequences, scope or anything the user did not cover, report it and ask first. The receipt always shows the dialog text and the answer given.',
}
const DIALOG_INPUT = {
  type: 'string',
  description: 'Text to return from a prompt dialog when dialog is "accept". Ignored otherwise.',
}

export const tools = [
  {
    name: 'tabs_list',
    description:
      "List the tabs open in the user's Chrome (incognito windows excluded). Each entry has tab_id, title, url and whether the agent opened it. Only operate on tabs you opened unless the user explicitly names one of theirs.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tabs_open',
    description:
      'Open a new tab inside the "Sema" tab group so the user can tell it apart. With url, waits until the page finishes loading and returns tab_id, title and url. The first visit to a site prompts the user for authorization inside the extension.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Address to open. When the scheme is omitted, https is assumed (http for localhost and 127.0.0.1). Omit for a blank tab.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab that the agent opened. Tabs opened by the user cannot be closed. Close your own tabs when the task is done.',
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID }, required: ['tab_id'], additionalProperties: false },
  },
  {
    name: 'navigate',
    description:
      'Navigate a tab to a URL, or go back, forward, or reload. Waits for the page to finish loading (30s limit) and returns title, url and whether a navigation happened.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        url: { type: 'string', description: 'Address to load, or one of: back, forward, reload.' },
      },
      required: ['tab_id', 'url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description:
      'Read the page as an element tree, one element per line: [e12] role "name" attributes, indented by nesting. Refs like e12 identify elements for later actions and become stale after navigation or the next full read_page. Use get_text instead when you only need the article text.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        interactive_only: {
          type: 'boolean',
          description: 'true (default) lists only interactive elements; false also includes headings, paragraphs, lists, tables and images.',
        },
        max_chars: { type: 'integer', description: 'Output limit, default 20000. Output is cut at a line boundary with a note.' },
        ref: { type: 'string', description: 'Read only the subtree under this element ref (e.g. "e12") from a previous read_page.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_text',
    description:
      'Extract the main text of the page (article, main content or the largest text block), dropping navigation and footers. Best for reading documentation and articles.',
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID }, required: ['tab_id'], additionalProperties: false },
  },
  {
    name: 'click',
    description:
      'Click an element by its ref from read_page. Scrolls it into view, then dispatches pointer, mouse and click events at its center. Fails if the element is hidden, disabled or covered. Returns a receipt with title, url, whether a navigation happened, and any native dialog (alert/confirm/prompt) the page raised, which was auto-dismissed.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: TAB_ID, ref: REF, dialog: DIALOG, dialog_input: DIALOG_INPUT },
      required: ['tab_id', 'ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description:
      'Set the value of a form control by ref and fire input/change events. Text inputs and textareas are replaced with value; select picks the option whose text (or value) matches; checkboxes and radios take true or false; contenteditable elements get the text. Does not submit. Returns the same receipt as click.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        ref: REF,
        value: {
          type: ['string', 'boolean'],
          description: 'Text to enter, option text for a select, or true/false for a checkbox or radio.',
        },
        dialog: DIALOG,
        dialog_input: DIALOG_INPUT,
      },
      required: ['tab_id', 'ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description:
      'Press a key or key combination on the focused element (click or fill something first to focus it). Examples: Enter, Escape, Tab, ArrowDown, a, cmd+a, ctrl+shift+Enter. Enter in a form field submits the form; Tab moves focus; Escape closes an open <dialog>. Browser-level shortcuts (new tab, copy, paste) have no effect. Returns the same receipt as click.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        keys: { type: 'string', description: 'Key name or combination joined with "+", e.g. "Enter", "Escape", "cmd+a".' },
        dialog: DIALOG,
        dialog_input: DIALOG_INPUT,
      },
      required: ['tab_id', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page. With ref only, scrolls that element into the center of the view. With direction only, scrolls the window by one screen. With both, scrolls the element\'s nearest scrollable container by one screen. Returns the same receipt as click.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        ref: { type: 'string', description: 'Element ref from read_page, e.g. "e12".' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll one screen this way.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture the tab as a JPEG image, scaled to CSS pixels. Use it only to check visual results: layout, overlap, colors, what the user actually sees. Prefer read_page for structure and text. The tab is activated first, so the user sees it switch. full_page scrolls and stitches up to 5 screens; text gets small, so for details take viewport screenshots after scroll instead.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        full_page: { type: 'boolean', description: 'false (default) captures the viewport; true stitches up to 5 screens from the top of the page.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'console',
    description:
      'Read console messages captured from the page: console.log/info/warn/error/debug, uncaught exceptions, unhandled promise rejections and failed resource loads. Capture starts when the tab is first controlled by the agent and covers only the current site (cleared on cross-origin navigation), keeping the last 1000 messages. If the result says capture started after the page loaded, navigate with "reload" and read again to see load-time errors. Browser-generated warnings (CSP, deprecations, CORS notes) are not captured.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        pattern: { type: 'string', description: 'Case-insensitive regular expression; only messages matching it are returned.' },
        only_errors: { type: 'boolean', description: 'true returns only error-level messages and uncaught exceptions.' },
        limit: { type: 'integer', description: 'Maximum messages to return, newest kept. Default 100, max 1000.' },
        clear: { type: 'boolean', description: 'true clears the buffer after reading, so the next call shows only new messages. Useful before reproducing an action.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'network',
    description:
      'Read fetch and XMLHttpRequest calls made by the page: method, URL, status, duration, request body and the first 2000 characters of the response body. Capture starts when the tab is first controlled by the agent and covers only the current site, keeping the last 1000 requests. Not captured: document navigations, images, scripts, stylesheets, WebSocket, requests from workers or cross-origin iframes. To debug "nothing happens on click", clear, do the click, then read.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        url_pattern: { type: 'string', description: 'Case-insensitive regular expression matched against the request URL, e.g. "/api/order".' },
        limit: { type: 'integer', description: 'Maximum requests to return, newest kept. Default 100, max 1000.' },
        clear: { type: 'boolean', description: 'true clears the buffer after reading.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'eval_js',
    description:
      'Run JavaScript in the page and return the result as text (max 20000 characters). A single expression returns its value, top-level await is allowed; multi-statement code must return explicitly. Objects are JSON-encoded, elements return their outerHTML. Use it to read page state that read_page cannot show: computed styles, positions, variables, counting rows by a condition. Do not use it to click, fill, submit or navigate (use the action tools so receipts and dialog handling work), and never read cookies, localStorage, sessionStorage, IndexedDB or password fields. Native dialogs raised by the script are auto-dismissed. Pages with a strict Content Security Policy refuse eval; the error says so.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        code: { type: 'string', description: 'JavaScript source, e.g. "document.querySelectorAll(\'tr\').length" or "await fetch(\'/api/x\').then(r => r.status)".' },
      },
      required: ['tab_id', 'code'],
      additionalProperties: false,
    },
  },
  {
    name: 'file_upload',
    description:
      'Put local files into a file input without opening the native file picker. ref must be the <input type="file"> itself (role "file" in read_page), not the button that opens the picker. paths are absolute paths on this machine; the files are read by the bridge and never pass through the model. Total size limit 10 MB. Fires input and change events, so the page reacts as if the user had picked the files. Returns the same receipt as click plus the files the input now holds.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        ref: REF,
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Absolute local file paths, e.g. ["/Users/me/report.pdf"]. Several paths need a file input with multiple.',
        },
      },
      required: ['tab_id', 'ref', 'paths'],
      additionalProperties: false,
    },
  },
]

// 返回文本，或 MCP content 数组（截图带图片块）
export function formatResult(name, result) {
  switch (name) {
    case 'tabs_list':
      if (!Array.isArray(result) || result.length === 0) return 'No tabs open.'
      return result
        .map((t) => `${t.tab_id}${t.agent ? ' [agent]' : ''} "${t.title}" ${t.url}`)
        .join('\n')
    case 'tabs_open':
    case 'navigate':
    case 'click':
    case 'fill':
    case 'press':
    case 'scroll':
      return formatReceipt(result)
    case 'file_upload': {
      const files = (result.uploaded || []).map((f) => `  ${f.name} (${f.size} bytes)`).join('\n')
      return `${formatReceipt(result)}\nuploaded:\n${files || '  (none)'}`
    }
    case 'tabs_close':
      return `Closed tab ${result.tab_id}.`
    case 'read_page':
      return `Title: ${result.title}\nURL: ${result.url}\n\n${result.text || '(no elements found)'}`
    case 'get_text':
      return `Title: ${result.title}\nURL: ${result.url}\n\n${result.text || '(no text found)'}`
    case 'screenshot':
      return formatScreenshot(result)
    case 'console':
      return formatConsole(result)
    case 'network':
      return formatNetwork(result)
    case 'eval_js':
      return formatEval(result)
    default:
      return JSON.stringify(result, null, 2)
  }
}

function formatScreenshot(r) {
  let text = `tab_id: ${r.tab_id}\ntitle: ${r.title}\nurl: ${r.url}\n${r.width}x${r.height} px`
  if (r.screens > 1 || r.truncated) {
    text += `, ${r.screens} screens stitched`
    if (r.truncated) text += ' (page is longer; cut at 5 screens, scroll and capture again for the rest)'
  }
  return [
    { type: 'image', data: r.data, mimeType: r.mime || 'image/jpeg' },
    { type: 'text', text },
  ]
}

// 捕获范围提示：钩子在页面加载后才装上时，加载期的报错与请求已错过
function coverageNote(r, what) {
  if (r.coverage === 'partial') {
    return `Note: capture started after the page had loaded, so ${what} from page load are missing. Navigate with "reload" and read again to see them.`
  }
  if (r.coverage === null) return `Note: nothing captured yet for this tab; ${what} will be recorded from now on.`
  return ''
}

function clock(ts) {
  const d = new Date(ts)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function formatConsole(r) {
  const lines = [`tab_id: ${r.tab_id}`, `url: ${r.url}`]
  const note = coverageNote(r, 'messages')
  if (note) lines.push(note)
  const real = r.entries.filter((e) => e.level !== 'nav').length
  lines.push(`${real} of ${r.matched} matching messages shown (${r.stored} stored)`, '')
  if (!real) lines.push('(no messages)')
  for (const e of r.entries) {
    lines.push(e.level === 'nav' ? `--- ${clock(e.ts)} ${e.text} ---` : `${clock(e.ts)} [${e.level}] ${e.text}`)
  }
  return lines.join('\n')
}

function formatNetwork(r) {
  const lines = [`tab_id: ${r.tab_id}`, `url: ${r.url}`]
  const note = coverageNote(r, 'requests')
  if (note) lines.push(note)
  lines.push(`${r.entries.length} of ${r.matched} matching requests shown (${r.stored} stored)`, '')
  if (!r.entries.length) lines.push('(no requests)')
  for (const e of r.entries) {
    const status = e.error ? `failed: ${e.error}` : `${e.status}${e.status_text ? ` ${e.status_text}` : ''}`
    lines.push(`${clock(e.ts)} ${e.method} ${e.url} -> ${status} (${e.duration_ms} ms, ${e.type})`)
    if (e.request_body) lines.push(`  request: ${indent(e.request_body)}`)
    if (e.response_body) lines.push(`  response: ${indent(e.response_body)}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function indent(s) {
  return String(s).replace(/\n/g, '\n    ')
}

function formatEval(r) {
  let text = r.value === '' ? '(empty string)' : r.value
  if (r.truncated) text += `\n... truncated at 20000 chars`
  const d = r.dialog
  if (d) {
    text += `\n\ndialog: ${d.type} ${JSON.stringify(d.message)} (${dialogOutcome(d)})`
    if (d.count > 1) text += `, ${d.count} dialogs during the script, last one shown`
  }
  return text
}

export function formatError(err) {
  let text = `[${err.code}] ${err.message}`
  if (err.data && typeof err.data === 'object' && 'tab_id' in err.data) {
    text += `\nCurrent page:\n${formatReceipt(err.data)}`
  }
  return text
}

function dialogOutcome(d) {
  if (d.type === 'confirm') return d.response === true ? 'auto-accepted, returned true' : 'auto-dismissed, returned false'
  if (d.type === 'prompt') {
    return typeof d.response === 'string'
      ? `auto-accepted, returned ${JSON.stringify(d.response)}`
      : 'auto-dismissed, returned null'
  }
  return 'auto-dismissed'
}

function formatReceipt(r) {
  const lines = [`tab_id: ${r.tab_id}`, `title: ${r.title}`, `url: ${r.url}`, `navigated: ${r.navigated}`]
  const d = r.dialog
  if (d) {
    let line = `dialog: ${d.type} ${JSON.stringify(d.message)} (${dialogOutcome(d)})`
    if (d.count > 1) line += `, ${d.count} dialogs since the previous action, last one shown`
    lines.push(line)
  }
  return lines.join('\n')
}
