// 站点授权窗口：把用户的选择回给后台，然后关掉自己。
const params = new URLSearchParams(location.search)
const host = params.get('host') || ''
const id = params.get('id') || ''
const timeoutMs = Number(params.get('timeout')) || 55_000

document.getElementById('host').textContent = host

let answered = false
function answer(decision) {
  if (answered) return
  answered = true
  chrome.runtime.sendMessage({ type: 'sema:authorize', host, id, decision }).catch(() => {})
  window.close()
}

for (const decision of ['once', 'always', 'deny']) {
  document.getElementById(decision).addEventListener('click', () => answer(decision))
}

const deadline = Date.now() + timeoutMs
const hint = document.getElementById('hint')
function tick() {
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  hint.textContent = `${left} 秒内未选择按拒绝处理`
  if (left <= 0) answer('deny')
}
tick()
setInterval(tick, 1000)
