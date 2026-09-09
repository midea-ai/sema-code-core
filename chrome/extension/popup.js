// 扩展弹窗：连接状态、立即停止 / 允许继续、站点授权列表可撤销。全部经后台处理。
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
    $('detail').textContent = `${s.reason || ''}。请确认宿主应用（SemaWork 或 IDE 插件）已启动过一次，扩展会自动重连。`
  } else if (s.stopped) {
    dot.classList.add('stopped')
    $('state').textContent = '已停止'
    $('detail').textContent = `扩展 ${s.version}，Agent 打开的标签页 ${s.agent_tabs} 个`
  } else {
    dot.classList.add('on')
    $('state').textContent = s.inflight.length ? `运行中：${s.inflight.join('、')}` : '已连接，空闲'
    $('detail').textContent = `扩展 ${s.version}，Agent 打开的标签页 ${s.agent_tabs} 个`
  }

  $('stop').hidden = s.stopped
  $('resume').hidden = !s.stopped
  $('stoppedNote').hidden = !s.stopped

  const list = $('auth')
  list.textContent = ''
  const rows = [...s.auth.always.map((h) => [h, '总是允许']), ...s.auth.once.map((h) => [h, '仅本次'])]
  $('authEmpty').hidden = rows.length > 0
  for (const [host, kind] of rows) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'host'
    name.textContent = host
    const tag = document.createElement('span')
    tag.className = 'kind'
    tag.textContent = kind
    const btn = document.createElement('button')
    btn.className = 'link'
    btn.textContent = '撤销'
    btn.addEventListener('click', () => call('revoke', { host }))
    li.append(name, tag, btn)
    list.append(li)
  }
}

$('stop').addEventListener('click', () => call('stop'))
$('resume').addEventListener('click', () => call('resume'))
call('status')
setInterval(() => call('status'), 2000)
