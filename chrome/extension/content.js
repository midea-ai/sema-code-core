// Sema 浏览器控制：内容脚本（隔离世界），由后台按需注入，负责 read_page、get_text 与 click、fill、press、scroll。
// 元素编号 e1、e2… 在一次完整 read_page 里分配，导航或下一次完整 read_page 后作废。
// 页面世界脚本接管的原生对话框以 sema:dialog 事件送到这里排队，每个动作返回时带走。
;(() => {
  if (window.__semaContent) return
  const state = { refs: new Map(), next: 0, dialogs: [] }
  window.__semaContent = state

  // 动作开始后页面世界脚本接管对话框的时长，覆盖同步与稍后的异步弹窗
  const ACTION_ARM_MS = 3000

  document.addEventListener('sema:dialog', (e) => {
    try {
      state.dialogs.push(JSON.parse(e.detail))
    } catch {
      // 不是我们的事件
    }
  })

  // 页面世界的控制台与网络记录：同一轮同步代码里的多条攒成一批发后台，减少消息数
  let logBatch = []
  document.addEventListener('sema:log', (e) => {
    let item
    try {
      item = JSON.parse(e.detail)
    } catch {
      return
    }
    logBatch.push(item)
    if (logBatch.length > 1) return
    queueMicrotask(() => {
      const entries = logBatch
      logBatch = []
      try {
        chrome.runtime.sendMessage({ type: 'sema:log', entries }).catch(() => {})
      } catch {
        // 扩展已重载，旧脚本失效
      }
    })
  })
  // 与页面世界脚本握手：谁后到谁招呼，对方回 hello 后页面世界把攒下的记录补发过来
  const hello = () => document.dispatchEvent(new CustomEvent('sema:hello', { detail: '' }))
  document.addEventListener('sema:page-ready', hello)
  hello()

  const STOP = Symbol('stop')

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base',
    'option', 'optgroup', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'map',
  ])
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox',
    'option', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
    'treeitem', 'file', 'clickable',
  ])
  // 静态角色：标题、段落等，interactive_only 为 false 时输出
  const STATIC_TAG_ROLES = {
    h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
    p: 'p', li: 'li', td: 'td', th: 'th', dt: 'dt', dd: 'dd', pre: 'pre', blockquote: 'quote',
    label: 'label', legend: 'legend', figcaption: 'caption', caption: 'caption', img: 'img',
    nav: 'nav', main: 'main', header: 'header', footer: 'footer', aside: 'aside', form: 'form',
    table: 'table', ul: 'list', ol: 'list', dialog: 'dialog', article: 'article', section: 'section',
    iframe: 'iframe',
  }
  const STATIC_ARIA_ROLES = {
    heading: 'heading', paragraph: 'p', listitem: 'li', cell: 'td', gridcell: 'td', columnheader: 'th',
    rowheader: 'th', img: 'img', navigation: 'nav', main: 'main', banner: 'header', contentinfo: 'footer',
    complementary: 'aside', form: 'form', table: 'table', grid: 'table', list: 'list', dialog: 'dialog',
    alertdialog: 'dialog', article: 'article', region: 'section',
  }
  // 这些角色的行只放它自己的行内文本，块级后代另起一行
  const NAME_MAX = 80
  const STATIC_TEXT_MAX = 200
  const VALUE_MAX = 60
  const OPTIONS_MAX = 20

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'sema') return
    try {
      const params = msg.params || {}
      let result
      if (msg.op === 'ping') result = { ok: true }
      else if (msg.op === 'read_page') result = readPage(params)
      else if (msg.op === 'get_text') result = getText()
      else if (msg.op === 'click') result = clickOp(params)
      else if (msg.op === 'fill') result = fillOp(params)
      else if (msg.op === 'press') result = pressOp(params)
      else if (msg.op === 'scroll') result = scrollOp(params)
      else if (msg.op === 'upload_check') result = uploadCheckOp(params)
      else if (msg.op === 'upload') result = uploadOp(params)
      else if (msg.op === 'dialogs') result = { dialog: drainDialogs() }
      else if (msg.op === 'arm') result = act(params.dialog, () => {})
      else if (msg.op === 'metrics') result = metricsOp()
      else if (msg.op === 'scroll_to') result = scrollToOp(params)
      else throw rpcError('unsupported', `Unknown content op: ${msg.op}`)
      sendResponse({ ok: true, result })
    } catch (e) {
      sendResponse({ ok: false, error: e && e.rpc ? e.rpc : { code: 'internal', message: String(e?.message || e) } })
    }
  })

  function rpcError(code, message) {
    const e = new Error(message)
    e.rpc = { code, message }
    return e
  }

  // ---------- read_page ----------

  function readPage({ interactive_only = true, max_chars = 20000, ref = null }) {
    let root
    if (ref) {
      root = state.refs.get(ref)
      if (!root || !root.isConnected) {
        throw rpcError('ref_invalid', `Ref ${ref} is stale or unknown; call read_page again to get fresh refs`)
      }
    } else {
      root = document.body || document.documentElement
      state.refs = new Map()
      state.next = 0
    }
    const out = { lines: [], chars: 0, count: 0, truncated: false, budget: max_chars, styles: new Map() }
    const ctx = { interactiveOnly: interactive_only, insideInteractive: false, parentPointer: false }
    try {
      if (root) walk(root, 0, ctx, out)
    } catch (e) {
      if (e !== STOP) throw e
    }
    let text = out.lines.join('\n')
    if (out.truncated) {
      text += `\n... truncated at ${max_chars} chars (${out.count} elements listed). Pass a ref to read one subtree, or raise max_chars.`
    }
    return { title: document.title, url: location.href, text, truncated: out.truncated, element_count: out.count }
  }

  function walk(el, depth, ctx, out) {
    const tag = el.localName
    if (!tag || SKIP_TAGS.has(tag)) return
    if (!visible(el)) return

    const style = styleOf(el, out)
    const pointer = style.cursor === 'pointer'
    const block = isBlockStyle(style)
    const role = roleOf(el, tag, pointer && !ctx.parentPointer)
    const interactive = role !== null && INTERACTIVE_ROLES.has(role)

    let emitted = false
    if (interactive) {
      emitLine(depth, describeInteractive(el, tag, role, out), out)
      emitted = true
    } else if (tag === 'iframe') {
      // iframe 行任何模式都输出，模型才知道跨域部分读不到
      emitLine(depth, describeStatic(el, tag, 'iframe', out), out)
      emitted = true
    } else if (!ctx.interactiveOnly && !ctx.insideInteractive) {
      if (role !== null) {
        emitLine(depth, describeStatic(el, tag, role, out), out)
        emitted = true
      } else if (block) {
        const own = collapse(inlineText(el, out))
        if (own) {
          emitLine(depth, `text ${quote(own, STATIC_TEXT_MAX)}`, out)
          emitted = true
        }
      }
    }

    if (tag === 'iframe') {
      const doc = sameOriginDoc(el)
      if (doc && doc.body) walk(doc.body, emitted ? depth + 1 : depth, ctx, out)
      return
    }
    if (tag === 'select' || tag === 'textarea' || tag === 'input') return

    // 真正的控件（按钮、链接）内部文字已进了它的名字，不再单独成行；
    // 启发式判定的 clickable（如 cursor:pointer 的卡片）内部文字仍要输出
    const childCtx = {
      interactiveOnly: ctx.interactiveOnly,
      insideInteractive: ctx.insideInteractive || (interactive && role !== 'clickable'),
      parentPointer: pointer,
    }
    const childDepth = emitted ? depth + 1 : depth
    for (const child of childrenOf(el)) walk(child, childDepth, childCtx, out)
  }

  function childrenOf(el) {
    const kids = []
    if (el.shadowRoot) kids.push(...el.shadowRoot.children)
    kids.push(...el.children)
    return kids
  }

  function emitLine(depth, body, out) {
    const line = '  '.repeat(depth) + body
    if (out.chars + line.length + 1 > out.budget) {
      out.truncated = true
      throw STOP
    }
    out.lines.push(line)
    out.chars += line.length + 1
    out.count += 1
  }

  function roleOf(el, tag, pointerBoundary) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase()
    if (explicit) {
      if (INTERACTIVE_ROLES.has(explicit)) return explicit
      if (STATIC_ARIA_ROLES[explicit]) return STATIC_ARIA_ROLES[explicit]
      if (explicit === 'presentation' || explicit === 'none') return null
    }
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : fallbackClickable(el, tag, pointerBoundary)
      case 'button':
      case 'summary':
        return 'button'
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        if (type === 'hidden') return null
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'range') return 'slider'
        if (type === 'file') return 'file'
        if (type === 'search') return 'searchbox'
        return 'textbox'
      }
      case 'select':
        return el.multiple ? 'listbox' : 'combobox'
      case 'textarea':
        return 'textbox'
      default:
        break
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox'
    if (STATIC_TAG_ROLES[tag]) return STATIC_TAG_ROLES[tag]
    return fallbackClickable(el, tag, pointerBoundary)
  }

  function fallbackClickable(el, tag, pointerBoundary) {
    if (tag === 'body' || tag === 'html') return null
    if (el.hasAttribute('onclick')) return 'clickable'
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return 'clickable'
    if (pointerBoundary) return 'clickable'
    return null
  }

  function describeInteractive(el, tag, role, out) {
    const id = `e${++state.next}`
    state.refs.set(id, el)
    const parts = [`[${id}]`, role]
    const name = interactiveName(el, tag, role, out)
    if (name) parts.push(quote(name, NAME_MAX))

    const type = (el.getAttribute('type') || '').toLowerCase()
    if (role === 'link') {
      const href = el.getAttribute('href')
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) parts.push(`href=${quote(href, 100)}`)
    } else if (tag === 'input') {
      if (type && type !== 'text' && role === 'textbox') parts.push(`type=${type}`)
      if (role === 'checkbox' || role === 'radio') parts.push(el.checked ? 'checked' : 'unchecked')
      else if (role === 'textbox' || role === 'searchbox' || role === 'slider') {
        if (type === 'password') {
          if (el.value) parts.push('value=(filled)')
        } else if (el.value) parts.push(`value=${quote(el.value, VALUE_MAX)}`)
      }
      if (!name && el.name) parts.push(`name=${quote(el.name, 40)}`)
      // 名字回退用了 placeholder 时也要显式标出来，否则模型会把提示文字当成已填的值
      const ph = el.getAttribute('placeholder')
      if (ph) parts.push(`placeholder=${quote(ph, 40)}`)
    } else if (tag === 'textarea') {
      if (el.value) parts.push(`value=${quote(el.value, VALUE_MAX)}`)
      if (!name && el.name) parts.push(`name=${quote(el.name, 40)}`)
      const ph = el.getAttribute('placeholder')
      if (ph) parts.push(`placeholder=${quote(ph, 40)}`)
    } else if (tag === 'select') {
      const opts = [...el.options]
      const selected = opts.filter((o) => o.selected).map((o) => o.text.trim())
      if (selected.length) parts.push(`value=${quote(selected.join(', '), VALUE_MAX)}`)
      const shown = opts.slice(0, OPTIONS_MAX).map((o) => quote(o.text.trim(), 40))
      let list = `options=[${shown.join(', ')}`
      if (opts.length > OPTIONS_MAX) list += `, +${opts.length - OPTIONS_MAX} more`
      parts.push(`${list}]`)
      if (!name && el.name) parts.push(`name=${quote(el.name, 40)}`)
    } else if (el.isContentEditable) {
      const v = collapse(el.innerText || '')
      if (v) parts.push(`value=${quote(v, VALUE_MAX)}`)
    }

    const ariaChecked = el.getAttribute('aria-checked')
    if (ariaChecked && tag !== 'input') parts.push(ariaChecked === 'true' ? 'checked' : 'unchecked')
    const ariaSelected = el.getAttribute('aria-selected')
    if (ariaSelected === 'true') parts.push('selected')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) parts.push(expanded === 'true' ? 'expanded' : 'collapsed')
    else if (tag === 'summary' && el.parentElement && el.parentElement.localName === 'details') {
      parts.push(el.parentElement.open ? 'expanded' : 'collapsed')
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
    if (el.readOnly) parts.push('readonly')
    if (el.required) parts.push('required')
    return parts.join(' ')
  }

  function describeStatic(el, tag, role, out) {
    if (role === 'iframe') {
      const src = el.getAttribute('src') || ''
      const doc = sameOriginDoc(el)
      return `iframe${doc ? '' : ' [cross-origin]'}${src ? ` src=${quote(src, 100)}` : ''}`
    }
    if (role === 'img') {
      const alt = el.getAttribute('alt') || el.getAttribute('title') || ''
      return alt ? `img ${quote(alt, NAME_MAX)}` : 'img'
    }
    if (role === 'heading') {
      const level = el.getAttribute('aria-level') || '2'
      const t = collapse(inlineText(el, out))
      return `h${level}${t ? ` ${quote(t, STATIC_TEXT_MAX)}` : ''}`
    }
    const label = el.getAttribute('aria-label')
    const t = collapse(label || inlineText(el, out))
    return t ? `${role} ${quote(t, STATIC_TEXT_MAX)}` : role
  }

  function interactiveName(el, tag, role, out) {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return collapse(aria)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => (el.ownerDocument.getElementById(id) || {}).innerText || '')
        .join(' ')
      if (collapse(t)) return collapse(t)
    }
    if (el.labels && el.labels.length) {
      const t = collapse(inlineText(el.labels[0], out))
      if (t) return t
    }
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (role === 'button') return el.value || el.getAttribute('alt') || type
      return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || '')
    }
    if (tag === 'select' || tag === 'textarea') {
      return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || '')
    }
    if (el.isContentEditable) return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || '')
    const text = collapse(el.innerText || el.textContent || '')
    if (text) return text
    const img = el.querySelector('img[alt], svg[aria-label]')
    if (img) return collapse(img.getAttribute('alt') || img.getAttribute('aria-label') || '')
    return collapse(el.getAttribute('title') || '')
  }

  // 元素自己的行内文本：跳过块级后代（它们会各自成行）
  function inlineText(el, out) {
    let s = ''
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        s += n.data
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.localName
        if (SKIP_TAGS.has(tag) || !visible(n)) continue
        if (tag === 'br') {
          s += ' '
          continue
        }
        if (isBlockStyle(styleOf(n, out))) continue
        if (tag === 'select' || tag === 'textarea' || tag === 'input') continue
        s += inlineText(n, out)
      }
    }
    return s
  }

  // ---------- get_text ----------

  function getText() {
    const body = document.body
    if (!body) return { title: document.title, url: location.href, text: '' }
    const root = pickContentRoot(body)
    return { title: document.title, url: location.href, text: extractText(root, root === body) }
  }

  function pickContentRoot(body) {
    const articles = [...document.querySelectorAll('article')].filter(visible)
    if (articles.length === 1) return articles[0]
    const main = document.querySelector('main, [role="main"]')
    if (main && visible(main)) return main
    return scoreBlocks(body) || body
  }

  // 简化版 readability：段落给父级记分、祖父记半分，按链接密度打折，取最高分的块
  function scoreBlocks(body) {
    const scores = new Map()
    const paras = body.querySelectorAll('p, pre, blockquote, li, h1, h2, h3, h4, h5, h6, td, dd')
    for (const p of paras) {
      if (!visible(p)) continue
      const len = collapse(p.textContent).length
      if (len < 25) continue
      const s = 1 + len / 100
      const parent = p.parentElement
      const grand = parent && parent.parentElement
      if (parent) scores.set(parent, (scores.get(parent) || 0) + s)
      if (grand) scores.set(grand, (scores.get(grand) || 0) + s / 2)
    }
    let best = null
    let bestScore = 0
    for (const [el, s] of scores) {
      const total = collapse(el.textContent).length || 1
      let linkLen = 0
      for (const a of el.querySelectorAll('a')) linkLen += collapse(a.textContent).length
      const adj = s * (1 - linkLen / total)
      if (adj > bestScore) {
        best = el
        bestScore = adj
      }
    }
    return bestScore > 2 ? best : null
  }

  const CHROME_TAGS = new Set(['header', 'footer', 'aside'])
  const CHROME_ROLES = new Set(['banner', 'contentinfo', 'complementary'])
  const PARAGRAPH_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'table', 'ul', 'ol'])

  function extractText(root, skipChrome) {
    const parts = []
    const styles = new Map()
    const rec = (el, pre) => {
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          parts.push(pre ? n.data : n.data.replace(/\s+/g, ' '))
          continue
        }
        if (n.nodeType !== Node.ELEMENT_NODE) continue
        const tag = n.localName
        if (SKIP_TAGS.has(tag) || tag === 'iframe' || tag === 'nav') continue
        const role = (n.getAttribute('role') || '').toLowerCase()
        if (role === 'navigation') continue
        if (skipChrome && (CHROME_TAGS.has(tag) || CHROME_ROLES.has(role))) continue
        if (!visible(n)) continue
        if (tag === 'br') {
          parts.push('\n')
          continue
        }
        if (tag === 'td' || tag === 'th') {
          parts.push('\t')
          rec(n, pre)
          continue
        }
        const block = isBlockStyle(styleOf(n, { styles }))
        if (block) parts.push('\n')
        rec(n, pre || tag === 'pre')
        if (block) parts.push('\n')
        if (PARAGRAPH_TAGS.has(tag)) parts.push('\n')
      }
    }
    rec(root, root.localName === 'pre')
    return parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n (?=\S)/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // ---------- 动作：click / fill / press / scroll ----------

  function resolveRef(ref) {
    const el = state.refs.get(ref)
    if (!el || !el.isConnected) {
      throw rpcError('ref_invalid', `Ref ${ref} is stale or unknown; call read_page again to get fresh refs`)
    }
    return el
  }

  // 动作前按策略武装页面世界脚本，动作后带走对话框记录。dialog 是 {accept, input}，缺省为取消。
  function act(dialog, fn) {
    const policy = { ms: ACTION_ARM_MS, accept: Boolean(dialog && dialog.accept), input: dialog && dialog.input }
    document.dispatchEvent(new CustomEvent('sema:arm', { detail: JSON.stringify(policy) }))
    fn()
    return { dialog: drainDialogs() }
  }

  // 截图用：整页高度、视口尺寸、当前滚动位置、设备像素比
  function metricsOp() {
    const de = document.documentElement
    const body = document.body
    return {
      scroll_height: Math.max(de ? de.scrollHeight : 0, body ? body.scrollHeight : 0),
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      scroll_x: window.scrollX,
      scroll_y: window.scrollY,
      dpr: window.devicePixelRatio || 1,
    }
  }

  // 整页截图逐屏滚动。临时关掉平滑滚动，立即到位；返回实际位置，页尾不足一屏时与目标不同
  function scrollToOp({ y }) {
    const top = Number(y)
    if (!Number.isFinite(top)) throw rpcError('bad_request', 'y must be a number')
    const de = document.documentElement
    const prev = de.style.scrollBehavior
    de.style.scrollBehavior = 'auto'
    try {
      window.scrollTo(0, Math.max(0, top))
    } finally {
      de.style.scrollBehavior = prev
    }
    return { scroll_y: window.scrollY }
  }

  function drainDialogs() {
    if (!state.dialogs.length) return null
    const last = state.dialogs[state.dialogs.length - 1]
    const out = { type: last.type, message: last.message, response: last.response, count: state.dialogs.length }
    state.dialogs = []
    return out
  }

  function assertEnabled(el, ref) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      throw rpcError('bad_request', `Element ${ref} is disabled`)
    }
  }

  // 滚到可见、检查遮挡，返回元素中心的视口坐标
  function targetPoint(el, ref) {
    if (!visible(el)) throw rpcError('bad_request', `Element ${ref} is not visible`)
    const win = el.ownerDocument.defaultView
    let rect = el.getBoundingClientRect()
    if (!pointInViewport(rect, win)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      rect = el.getBoundingClientRect()
    }
    if (rect.width === 0 && rect.height === 0) throw rpcError('bad_request', `Element ${ref} has no size`)
    const x = clamp(rect.left + rect.width / 2, 1, win.innerWidth - 1)
    const y = clamp(rect.top + rect.height / 2, 1, win.innerHeight - 1)
    const hit = el.ownerDocument.elementFromPoint(x, y)
    if (hit && !within(hit, el) && !within(el, hit)) {
      throw rpcError(
        'bad_request',
        `Element ${ref} is covered by another element (<${hit.localName}${hit.id ? ` id="${hit.id}"` : ''}>); close the overlay or scroll first`,
      )
    }
    return { x, y, win }
  }

  function pointInViewport(rect, win) {
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return x >= 0 && y >= 0 && x <= win.innerWidth && y <= win.innerHeight
  }

  // 祖先判断，穿过 shadow root
  function within(node, ancestor) {
    let n = node
    while (n) {
      if (n === ancestor) return true
      n = n.parentNode || n.host || null
    }
    return false
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v))
  }

  function clickOp({ ref, dialog }) {
    const el = resolveRef(ref)
    return act(dialog, () => {
      assertEnabled(el, ref)
      if (el.localName === 'option') {
        const select = el.closest('select')
        if (select) chooseOption(select, el)
        return
      }
      const { x, y, win } = targetPoint(el, ref)
      if (typeof el.focus === 'function') el.focus({ preventScroll: true })
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        detail: 1,
      }
      const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      el.dispatchEvent(new win.PointerEvent('pointerdown', { ...pointer, buttons: 1 }))
      el.dispatchEvent(new win.MouseEvent('mousedown', { ...base, buttons: 1 }))
      el.dispatchEvent(new win.PointerEvent('pointerup', { ...pointer, buttons: 0 }))
      el.dispatchEvent(new win.MouseEvent('mouseup', { ...base, buttons: 0 }))
      el.dispatchEvent(new win.MouseEvent('click', { ...base, buttons: 0 }))
    })
  }

  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image'])

  function fillOp({ ref, value, dialog }) {
    const el = resolveRef(ref)
    const tag = el.localName
    return act(dialog, () => {
      assertEnabled(el, ref)
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase()
        if (type === 'file') throw rpcError('bad_request', `Element ${ref} is a file input; use file_upload with local paths`)
        if (type === 'checkbox' || type === 'radio') return setChecked(el, ref, value)
        if (BUTTON_INPUT_TYPES.has(type)) throw rpcError('bad_request', `Element ${ref} is a button; use click`)
        if (el.readOnly) throw rpcError('bad_request', `Element ${ref} is read-only`)
        return setNativeValue(el, ref, String(value ?? ''))
      }
      if (tag === 'textarea') {
        if (el.readOnly) throw rpcError('bad_request', `Element ${ref} is read-only`)
        return setNativeValue(el, ref, String(value ?? ''))
      }
      if (tag === 'select') return selectByValue(el, ref, String(value ?? ''))
      if (el.isContentEditable) return setEditable(el, String(value ?? ''))
      throw rpcError('bad_request', `Element ${ref} (<${tag}>) is not an input, textarea, select or editable element`)
    })
  }

  function revealForInput(el) {
    const win = el.ownerDocument.defaultView
    if (!pointInViewport(el.getBoundingClientRect(), win)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    }
  }

  // ---------- 文件上传 ----------

  // 收分片前先确认目标：必须是 <input type=file>、未禁用，多个文件要有 multiple
  function requireFileInput(ref, count) {
    const el = resolveRef(ref)
    if (!(el.localName === 'input' && (el.type || '').toLowerCase() === 'file')) {
      throw rpcError(
        'bad_request',
        `Element ${ref} (<${el.localName}>) is not a file input; pass the ref of the <input type="file"> itself (role "file" in read_page), not the button that opens the picker`,
      )
    }
    assertEnabled(el, ref)
    if (count > 1 && !el.multiple) {
      throw rpcError('bad_request', `File input ${ref} accepts a single file; ${count} given`)
    }
    return el
  }

  function uploadCheckOp({ ref, count }) {
    requireFileInput(ref, Number(count) || 0)
    return { ok: true }
  }

  // 由分片构造 File，经 DataTransfer 赋给 files，再派发 input 与 change；页面看到的和用户选完文件一样
  function uploadOp({ ref, files, dialog }) {
    const el = requireFileInput(ref, files.length)
    let uploaded = []
    const r = act(dialog, () => {
      const win = el.ownerDocument.defaultView
      const dt = new win.DataTransfer()
      for (const f of files) {
        const parts = f.parts.map(base64ToBytes)
        dt.items.add(new win.File(parts, f.name, { type: f.type || '' }))
      }
      revealForInput(el)
      el.files = dt.files
      uploaded = [...el.files].map((f) => ({ name: f.name, size: f.size }))
      el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new win.Event('change', { bubbles: true }))
    })
    return { ...r, uploaded }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  // 受控输入框（React 等）拦了实例上的 value，用原型链的原生 setter 赋值再派事件
  function setNativeValue(el, ref, value) {
    const win = el.ownerDocument.defaultView
    const proto = el.localName === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    revealForInput(el)
    el.focus({ preventScroll: true })
    if (setter) setter.call(el, value)
    else el.value = value
    if (el.value !== value) {
      throw rpcError('bad_request', `Input ${ref} (type=${el.type}) rejected the value ${JSON.stringify(value)}`)
    }
    el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }))
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
  }

  function setChecked(el, ref, value) {
    const want = toBool(value)
    if (want === null) throw rpcError('bad_request', `Element ${ref} is a ${el.type}; pass true or false`)
    if (el.type === 'radio' && !want) {
      throw rpcError('bad_request', `Radio ${ref} can only be set to true; fill another radio in the group instead`)
    }
    if (el.checked === want) return
    revealForInput(el)
    el.click() // 走激活行为，自带 input 与 change
  }

  function toBool(value) {
    if (typeof value === 'boolean') return value
    const s = String(value ?? '').trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
    return null
  }

  function selectByValue(select, ref, want) {
    const opts = [...select.options]
    const w = want.trim()
    const opt =
      opts.find((o) => o.text.trim() === w) ||
      opts.find((o) => o.value === w) ||
      opts.find((o) => o.text.trim().toLowerCase() === w.toLowerCase())
    if (!opt) {
      const list = opts.slice(0, OPTIONS_MAX).map((o) => quote(o.text.trim(), 40)).join(', ')
      throw rpcError('bad_request', `No option of ${ref} matches ${JSON.stringify(w)}; options: ${list}`)
    }
    revealForInput(select)
    chooseOption(select, opt)
  }

  function chooseOption(select, opt) {
    const win = select.ownerDocument.defaultView
    if (select.multiple) for (const o of select.options) o.selected = o === opt
    else select.selectedIndex = opt.index
    select.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new win.Event('change', { bubbles: true }))
  }

  function setEditable(el, value) {
    const doc = el.ownerDocument
    revealForInput(el)
    el.focus({ preventScroll: true })
    const sel = doc.getSelection()
    const range = doc.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = value ? doc.execCommand('insertText', false, value) : doc.execCommand('delete')
    if (!ok) {
      el.textContent = value
      el.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }))
    }
  }

  // ---- press ----

  const KEY_ALIASES = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', space: ' ', spacebar: ' ',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  }
  const KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, ' ': 32, Backspace: 8, Delete: 46, Insert: 45, Home: 36, End: 35,
    PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  }
  const MODIFIERS = {
    ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
    meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta',
  }
  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'month', 'week', 'time',
    'datetime-local', 'color',
  ])

  function parseKeys(keys) {
    const raw = keys.trim()
    const parts = raw === '+' ? ['+'] : raw.split('+').map((p) => p.trim()).filter(Boolean)
    if (!parts.length) throw rpcError('bad_request', 'keys is empty')
    const combo = { ctrl: false, alt: false, shift: false, meta: false }
    let key = null
    for (const part of parts) {
      const mod = MODIFIERS[part.toLowerCase()]
      if (mod) combo[mod] = true
      else if (key !== null) throw rpcError('bad_request', `keys ${JSON.stringify(keys)} names more than one key`)
      else key = part
    }
    if (key === null) throw rpcError('bad_request', `keys ${JSON.stringify(keys)} has modifiers only`)
    const lower = key.toLowerCase()
    if (KEY_ALIASES[lower]) key = KEY_ALIASES[lower]
    else if (/^f([1-9]|1[0-2])$/.test(lower)) key = lower.toUpperCase()
    else if (key.length !== 1) throw rpcError('bad_request', `Unknown key ${JSON.stringify(key)}`)
    combo.key = key.length === 1 && combo.shift ? key.toUpperCase() : key
    combo.code = codeOf(combo.key)
    combo.keyCode = KEY_CODES[combo.key] || (combo.key.length === 1 ? combo.key.toUpperCase().charCodeAt(0) : 0)
    return combo
  }

  function codeOf(key) {
    if (key === ' ') return 'Space'
    if (key.length === 1) {
      if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`
      if (/[0-9]/.test(key)) return `Digit${key}`
      return ''
    }
    return key
  }

  function pressOp({ keys, dialog }) {
    const combo = parseKeys(keys)
    return act(dialog, () => {
      const target = activeElement()
      const win = target.ownerDocument.defaultView
      const init = {
        key: combo.key,
        code: combo.code,
        ctrlKey: combo.ctrl,
        altKey: combo.alt,
        shiftKey: combo.shift,
        metaKey: combo.meta,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
      }
      const proceed = target.dispatchEvent(keyEvent(win, 'keydown', init, combo.keyCode))
      if (proceed) defaultKeyAction(target, combo)
      target.dispatchEvent(keyEvent(win, 'keyup', init, combo.keyCode))
    })
  }

  // 老页面看 keyCode / which，构造器设不了，补上只读访问器
  function keyEvent(win, type, init, keyCode) {
    const ev = new win.KeyboardEvent(type, init)
    if (keyCode) {
      Object.defineProperty(ev, 'keyCode', { get: () => keyCode })
      Object.defineProperty(ev, 'which', { get: () => keyCode })
    }
    return ev
  }

  // 焦点元素：穿过 shadow root 与同源 iframe，没有就是 body
  function activeElement() {
    let el = document.activeElement
    while (el) {
      if (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
      else if (el.localName === 'iframe') {
        const doc = sameOriginDoc(el)
        if (!doc) break
        el = doc.activeElement || doc.body
      } else break
    }
    return el || document.body
  }

  function isTextInput(el) {
    return el.localName === 'input' && TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase())
  }

  function isEditable(el) {
    return (isTextInput(el) && !el.readOnly) || (el.localName === 'textarea' && !el.readOnly) || el.isContentEditable
  }

  function isButtonLike(el) {
    const tag = el.localName
    if (tag === 'button' || tag === 'summary') return true
    if (tag === 'input') return BUTTON_INPUT_TYPES.has((el.type || 'text').toLowerCase())
    const role = (el.getAttribute('role') || '').toLowerCase()
    return role === 'button' || role === 'menuitem' || role === 'tab'
  }

  // 合成键盘事件没有浏览器默认行为，这里补常用的几种
  function defaultKeyAction(target, combo) {
    const mod = combo.ctrl || combo.meta
    if (mod && !combo.alt && !combo.shift && combo.key.toLowerCase() === 'a') {
      selectAll(target)
      return
    }
    if (mod || combo.alt) return // 其他快捷键只派事件，浏览器级快捷键无效果
    const tag = target.localName
    switch (combo.key) {
      case 'Enter':
        if (tag === 'textarea') insertText(target, '\n')
        else if (target.isContentEditable) target.ownerDocument.execCommand('insertParagraph')
        else if (isTextInput(target)) implicitSubmit(target)
        else if (isButtonLike(target) || (tag === 'a' && target.hasAttribute('href'))) target.click()
        return
      case ' ':
        if (isButtonLike(target) || (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio'))) target.click()
        else if (isEditable(target)) insertText(target, ' ')
        return
      case 'Tab':
        moveFocus(target, combo.shift ? -1 : 1)
        return
      case 'Escape': {
        const dialog = target.closest ? target.closest('dialog[open]') : null
        if (dialog && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close()
        return
      }
      case 'Backspace':
        if (isEditable(target)) target.ownerDocument.execCommand('delete')
        return
      case 'Delete':
        if (isEditable(target)) target.ownerDocument.execCommand('forwardDelete')
        return
      default:
        if (combo.key.length === 1 && isEditable(target)) insertText(target, combo.key)
    }
  }

  function insertText(target, text) {
    target.focus({ preventScroll: true })
    if (target.ownerDocument.execCommand('insertText', false, text)) return
    if (target.localName === 'input' || target.localName === 'textarea') {
      setNativeValue(target, 'focused element', `${target.value}${text}`)
    }
  }

  // 表单文本框上的 Enter：有默认按钮就点它（按钮的点击处理器也要跑），没有且只有一个文本框才提交
  function implicitSubmit(input) {
    const form = input.form
    if (!form) return
    const button = form.querySelector(
      'button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]',
    )
    if (button) {
      if (!button.disabled) button.click()
      return
    }
    const textFields = [...form.elements].filter((f) => isTextInput(f))
    if (textFields.length > 1) return
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.submit()
  }

  function selectAll(target) {
    if (typeof target.select === 'function' && (target.localName === 'input' || target.localName === 'textarea')) {
      target.select()
      return
    }
    const doc = target.ownerDocument
    doc.getSelection().selectAllChildren(target.isContentEditable ? target : doc.body)
  }

  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]'

  function moveFocus(target, dir) {
    const doc = target.ownerDocument
    const list = [...doc.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && !(el.localName === 'input' && el.type === 'hidden') && visible(el),
    )
    if (!list.length) return
    const i = list.indexOf(target)
    const next = i < 0 ? (dir > 0 ? list[0] : list[list.length - 1]) : list[(i + dir + list.length) % list.length]
    next.focus()
  }

  // ---- scroll ----

  function scrollOp({ ref, direction }) {
    return act(null, () => {
      if (ref && !direction) {
        resolveRef(ref).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        return
      }
      const dx = direction === 'left' ? -1 : direction === 'right' ? 1 : 0
      const dy = direction === 'up' ? -1 : direction === 'down' ? 1 : 0
      if (ref) {
        const el = resolveRef(ref)
        const scroller = scrollableAncestor(el)
        if (scroller) {
          scroller.scrollBy({ left: dx * scroller.clientWidth, top: dy * scroller.clientHeight, behavior: 'instant' })
          return
        }
        const win = el.ownerDocument.defaultView
        win.scrollBy({ left: dx * win.innerWidth, top: dy * win.innerHeight, behavior: 'instant' })
        return
      }
      window.scrollBy({ left: dx * window.innerWidth, top: dy * window.innerHeight, behavior: 'instant' })
    })
  }

  // 元素自己或最近的可滚动祖先；到文档根就返回 null，表示滚窗口
  function scrollableAncestor(el) {
    let n = el
    while (n && n !== n.ownerDocument.documentElement) {
      const s = getComputedStyle(n)
      const y = s.overflowY === 'auto' || s.overflowY === 'scroll'
      const x = s.overflowX === 'auto' || s.overflowX === 'scroll'
      if ((y && n.scrollHeight > n.clientHeight) || (x && n.scrollWidth > n.clientWidth)) return n
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null
    }
    return null
  }

  // ---------- 通用 ----------

  function visible(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return true
      // display: contents 没有盒子，checkVisibility 会说不可见，但它的孩子是可见的
      return getComputedStyle(el).display === 'contents'
    }
    return el.getClientRects().length > 0
  }

  function styleOf(el, out) {
    let s = out.styles.get(el)
    if (!s) {
      s = getComputedStyle(el)
      out.styles.set(el, s)
    }
    return s
  }

  function isBlockStyle(style) {
    const d = style.display
    return d !== 'inline' && d !== 'contents' && !d.startsWith('inline-')
  }

  function sameOriginDoc(iframe) {
    try {
      const doc = iframe.contentDocument
      return doc && doc.body ? doc : null
    } catch {
      return null
    }
  }

  function collapse(s) {
    return (s || '').replace(/\s+/g, ' ').trim()
  }

  function quote(s, max) {
    let t = collapse(s)
    if (t.length > max) t = `${t.slice(0, max - 1)}…`
    return `"${t.replace(/"/g, '\\"')}"`
  }
})()
