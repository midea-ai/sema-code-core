// Sema 浏览器控制：页面世界脚本。由后台以 world: MAIN 注入，或在 Agent 自己发起导航前按 URL 临时注册为
// document_start 脚本，保证钩子赶在页面脚本前装上。同一文档只装一次。
// 三组钩子：
// - 对话框：只在"武装"期间接管（动作开始后几秒、导航加载期间），其余时间原生弹出，用户自己用这个标签页时不受影响。
//   武装时带策略：默认取消（confirm 返回 false、prompt 返回 null），accept 时 confirm 返回 true、prompt 返回给定文字或默认值。
// - 控制台：包 console 五个方法与 error、unhandledrejection，常驻。
// - 网络：包 fetch 与 XMLHttpRequest，记方法、URL、状态、请求体与响应体前 2000 字符，常驻。
// 记录以 sema:log 事件送给内容脚本（detail 是 JSON 字符串 {kind, entry}）；内容脚本还没到时先攒着，
// 收到 sema:hello 再补发，所以 document_start 时的记录不会丢。
;(() => {
  if (window.__semaPage) return
  const TEXT_MAX = 2000
  const BODY_MAX = 2000
  const PENDING_MAX = 300
  const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json|problem\+json)|.*\+(json|xml)\b)/i

  let connected = false
  const pending = []
  const emit = (name, detail) => {
    try {
      // 跨世界只传字符串，对象在隔离世界里读不到
      document.dispatchEvent(new CustomEvent(name, { detail }))
    } catch {
      // 页面正在卸载
    }
  }
  const send = (kind, entry) => {
    let detail
    try {
      detail = JSON.stringify({ kind, entry })
    } catch {
      return
    }
    if (connected) emit('sema:log', detail)
    // 满了丢新的：最早的 meta 与加载期报错正是要保住的
    else if (pending.length < PENDING_MAX) pending.push(detail)
  }
  document.addEventListener('sema:hello', () => {
    connected = true
    for (const d of pending.splice(0)) emit('sema:log', d)
  })
  const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}… [truncated, ${s.length} chars]` : s)

  // ---------- 对话框 ----------
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  let armedUntil = 0
  let policy = { accept: false, input: null }
  const arm = (opts) => {
    const o = opts && typeof opts === 'object' ? opts : { ms: opts }
    armedUntil = Math.max(armedUntil, Date.now() + (Number(o.ms) || 0))
    policy = { accept: Boolean(o.accept), input: typeof o.input === 'string' ? o.input : null }
  }
  const armed = () => Date.now() < armedUntil
  const record = (type, message, response) => {
    const detail = { type, message: message === undefined ? '' : String(message), response, at: Date.now() }
    emit('sema:dialog', JSON.stringify(detail))
  }
  window.alert = function (message) {
    if (!armed()) return native.alert.call(window, message)
    record('alert', message, null)
  }
  window.confirm = function (message) {
    if (!armed()) return native.confirm.call(window, message)
    record('confirm', message, policy.accept)
    return policy.accept
  }
  window.prompt = function (message, defaultValue) {
    if (!armed()) return native.prompt.call(window, message, defaultValue)
    let response = null
    if (policy.accept) response = policy.input !== null ? policy.input : defaultValue === undefined ? '' : String(defaultValue)
    record('prompt', message, response)
    return response
  }
  document.addEventListener('sema:arm', (e) => {
    let opts = e.detail
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts)
      } catch {
        return
      }
    }
    arm(opts)
  })

  // ---------- 控制台 ----------
  const describeNode = (n) => {
    if (n.nodeType === 9) return '#document'
    if (n.nodeType !== 1) return `#${n.nodeName.toLowerCase()}`
    let s = `<${n.localName}`
    if (n.id) s += `#${n.id}`
    if (typeof n.className === 'string' && n.className.trim()) s += `.${n.className.trim().split(/\s+/).join('.')}`
    return `${s}>`
  }
  const fmt = (v, depth) => {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    const t = typeof v
    if (t === 'string') return v
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v)
    if (t === 'function') return `[Function ${v.name || 'anonymous'}]`
    if (v instanceof Error) {
      const stack = typeof v.stack === 'string' ? v.stack : ''
      return stack.startsWith(`${v.name}`) || stack.includes(v.message) ? stack : `${v.name}: ${v.message}\n${stack}`
    }
    if (typeof Node !== 'undefined' && v instanceof Node) return describeNode(v)
    if (depth > 0) return String(v)
    try {
      return JSON.stringify(v, (_k, val) => {
        if (typeof val === 'bigint') return String(val)
        if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
        if (typeof Node !== 'undefined' && val instanceof Node) return describeNode(val)
        if (val instanceof Map) return Object.fromEntries(val)
        if (val instanceof Set) return [...val]
        return val
      })
    } catch {
      return String(v)
    }
  }
  const logEntry = (level, text) => send('console', { ts: Date.now(), level, text: cut(text, TEXT_MAX) })
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level]
    if (typeof orig !== 'function') continue
    console[level] = function (...args) {
      try {
        logEntry(level, args.map((a) => fmt(a, 0)).join(' '))
      } catch {
        // 记录失败不影响页面
      }
      return orig.apply(this, args)
    }
  }
  window.addEventListener(
    'error',
    (e) => {
      if (e.target && e.target !== window && !(e instanceof ErrorEvent)) {
        // 资源加载失败：img、script、link 上的 error 事件不冒泡，捕获阶段拿到
        const src = e.target.src || e.target.href
        if (src) logEntry('error', `Failed to load resource: ${src}`)
        return
      }
      let text = e.message || (e.error ? fmt(e.error, 1) : 'Uncaught error')
      if (e.error && typeof e.error.stack === 'string' && !text.includes(e.error.stack.split('\n')[0])) {
        text = `${text}\n${e.error.stack}`
      } else if (e.filename) text += ` at ${e.filename}:${e.lineno}:${e.colno}`
      if (!/^Uncaught/.test(text)) text = `Uncaught ${text}`
      logEntry('error', text)
    },
    true,
  )
  window.addEventListener('unhandledrejection', (e) => {
    logEntry('error', `Uncaught (in promise) ${fmt(e.reason, 0)}`)
  })

  // ---------- 网络 ----------
  const absolute = (u) => {
    try {
      return new URL(String(u), location.href).href
    } catch {
      return String(u)
    }
  }
  const bodyText = (body) => {
    if (body === undefined || body === null) return null
    if (typeof body === 'string') return cut(body, BODY_MAX)
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return cut(body.toString(), BODY_MAX)
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const parts = []
      for (const [k, v] of body.entries()) parts.push(`${k}=${typeof v === 'string' ? v : `[File ${v.name || ''} ${v.size} bytes]`}`)
      return cut(`[FormData] ${parts.join('&')}`, BODY_MAX)
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob ${body.size} bytes]`
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary ${body.byteLength} bytes]`
    return cut(String(body), BODY_MAX)
  }
  const netEntry = (base, extra) => send('network', { ...base, ...extra })

  // 读响应体前 BODY_MAX 字符就停，不把大响应整个读进内存；非文本类型只记类型与大小
  const readResponseBody = async (res) => {
    if (res.type === 'opaque') return '[opaque response]'
    const type = res.headers.get('content-type') || ''
    if (type && !TEXT_TYPES.test(type)) {
      const len = res.headers.get('content-length')
      return `[${type.split(';')[0]}${len ? `, ${len} bytes` : ''}]`
    }
    if (!res.body) return ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let total = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (text.length > BODY_MAX) {
        reader.cancel().catch(() => {})
        return `${text.slice(0, BODY_MAX)}… [truncated, more than ${total} bytes]`
      }
    }
    return text
  }
  const readRequestBody = async (input, init) => {
    if (init && init.body !== undefined) return bodyText(init.body)
    if (typeof Request !== 'undefined' && input instanceof Request && input.body && !input.bodyUsed) {
      try {
        return cut(await input.clone().text(), BODY_MAX)
      } catch {
        return null
      }
    }
    return null
  }

  const nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const start = Date.now()
      let base = { ts: start, type: 'fetch', method: 'GET', url: '' }
      let requestBody = null
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof Request
        base.url = absolute(isReq ? input.url : input)
        base.method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase()
        requestBody = readRequestBody(input, init)
      } catch {
        base = null
      }
      const p = nativeFetch.apply(this, arguments)
      if (base) {
        p.then(
          async (res) => {
            let clone = null
            try {
              clone = res.clone()
            } catch {
              // 页面已消费
            }
            const duration = Date.now() - start
            let body = null
            try {
              body = clone ? await readResponseBody(clone) : null
            } catch (e) {
              body = `[unreadable: ${e && e.message}]`
            }
            netEntry(base, {
              status: res.status,
              status_text: res.statusText,
              duration_ms: duration,
              request_body: await requestBody,
              response_body: body,
              error: null,
            })
          },
          async (err) => {
            netEntry(base, {
              status: 0,
              status_text: '',
              duration_ms: Date.now() - start,
              request_body: await requestBody,
              response_body: null,
              error: err && err.message ? `${err.name}: ${err.message}` : String(err),
            })
          },
        )
      }
      return p
    }
  }

  const XHR = window.XMLHttpRequest
  if (XHR && XHR.prototype) {
    const nativeOpen = XHR.prototype.open
    const nativeSend = XHR.prototype.send
    XHR.prototype.open = function (method, url) {
      try {
        this.__sema = { method: String(method).toUpperCase(), url: absolute(url) }
      } catch {
        this.__sema = null
      }
      return nativeOpen.apply(this, arguments)
    }
    XHR.prototype.send = function (body) {
      const meta = this.__sema
      if (meta) {
        const start = Date.now()
        let requestBody = null
        try {
          requestBody = bodyText(body)
        } catch {
          // 忽略
        }
        this.addEventListener('loadend', () => {
          let responseBody = null
          try {
            const rt = this.responseType
            responseBody = rt === '' || rt === 'text' ? cut(this.responseText || '', BODY_MAX) : `[${rt}]`
          } catch {
            responseBody = null
          }
          netEntry(
            { ts: start, type: 'xhr', method: meta.method, url: meta.url },
            {
              status: this.status,
              status_text: this.statusText,
              duration_ms: Date.now() - start,
              request_body: requestBody,
              response_body: responseBody,
              error: this.status === 0 ? 'network error, timeout or aborted' : null,
            },
          )
        })
      }
      return nativeSend.apply(this, arguments)
    }
  }

  window.__semaPage = { arm }
  // 首条记录：钩子装上时页面处于什么阶段，后台据此告诉模型加载期的日志有没有被捕获
  send('meta', { ts: Date.now(), url: location.href, ready_state: document.readyState })
  // 内容脚本可能已经在了（后台先注内容脚本再注本文件），招呼一声让它回 hello
  emit('sema:page-ready', '')
})()
