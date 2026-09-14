// 扩展弹窗：连接状态与停止 / 继续按钮、黑名单增删、访问前询问开关、站点授权列表可撤销。全部经后台处理。
const $ = (id) => document.getElementById(id)

async function call(op, extra = {}) {
  let s
  try {
    s = await chrome.runtime.sendMessage({ type: 'sema:popup', op, ...extra })
  } catch (e) {
    s = { error: String(e?.message || e) }
  }
  render(s || { error: 'no response' })
}

function render(s) {
  const dot = $('dot')
  dot.className = 'dot'
  if (s.error) {
    $('state').textContent = '后台无响应'
    $('detail').textContent = s.error
    return
  }
  if (!s.connected) {
    dot.classList.add('off')
    $('state').textContent = '未连接原生宿主'
    $('detail').textContent = s.reason ? `请先启动宿主应用（${s.reason}）` : '请先启动宿主应用'
  } else if (s.stopped) {
    dot.classList.add('stopped')
    $('state').textContent = '已停止'
    $('detail').textContent = `扩展 ${s.version}`
  } else {
    dot.classList.add('on')
    $('state').textContent = s.inflight.length ? `运行中：${s.inflight.join('、')}` : '已连接，空闲'
    $('detail').textContent = `扩展 ${s.version}`
  }

  $('stop').hidden = s.stopped
  $('resume').hidden = !s.stopped
  $('stoppedNote').hidden = !s.stopped

  renderList(
    $('block'),
    s.auth.block.map((h) => [h, '']),
    '移除',
    (host) => call('unblock', { host }),
  )

  $('ask').checked = s.auth.ask
  $('auth').hidden = !s.auth.ask
  const rows = [...s.auth.always.map((h) => [h, '总是允许']), ...s.auth.once.map((h) => [h, '仅本次'])]
  renderList($('auth'), rows, '撤销', (host) => call('revoke', { host }))
}

function renderList(list, rows, action, onClick) {
  list.textContent = ''
  for (const [host, kind] of rows) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'host'
    name.textContent = host
    const btn = document.createElement('button')
    btn.className = 'link'
    btn.textContent = action
    btn.addEventListener('click', () => onClick(host))
    li.append(name)
    if (kind) {
      const tag = document.createElement('span')
      tag.className = 'kind'
      tag.textContent = kind
      li.append(tag)
    }
    li.append(btn)
    list.append(li)
  }
}

function addBlock() {
  const input = $('blockInput')
  const host = input.value.trim()
  if (!host) return
  input.value = ''
  call('block', { host })
}

$('stop').addEventListener('click', () => call('stop'))
$('resume').addEventListener('click', () => call('resume'))
$('ask').addEventListener('change', (e) => call('setAsk', { on: e.target.checked }))
$('blockAdd').addEventListener('click', addBlock)
$('blockInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBlock()
})
call('status')
setInterval(() => call('status'), 2000)
