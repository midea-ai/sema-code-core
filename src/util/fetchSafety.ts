/**
 * IPv4-mapped IPv6 → 内嵌 IPv4 点分形式。
 * Node 的 URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1，两种写法都要还原。
 *   ::ffff:127.0.0.1 → "127.0.0.1"
 *   ::ffff:7f00:1    → "127.0.0.1"
 */
function extractMappedIpv4(host: string): string | null {
  const m = host.match(/^::ffff:(.+)$/i)
  if (!m) return null
  const tail = m[1]!
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
  }
  return null
}

/**
 * fetch_url 的确定性 SSRF 兜底：命中环回 / 链路本地（含云元数据 169.254.169.254）/
 * 内网 / 未指定地址 / 本地主机名，一律按危险处理，不交给模型。URL 解析失败同样按危险处理。
 *
 * 说明：new URL() (WHATWG) 已把 十进制/十六进制/八进制/短写 IPv4（如 2130706433、0x7f000001、
 * 127.1）规范化为点分十进制，故无需额外处理；这里额外补：
 *  - IPv4-mapped IPv6（::ffff:7f00:1 等）
 *  - 末尾点 FQDN（localhost. 等）
 */
export function isBlockedFetchHost(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return true
  }

  // 去掉 IPv6 字面量方括号，并去掉末尾点（FQDN 绝对形式，如 localhost.）
  let host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')

  // 本地主机名 / 已知云元数据主机名
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal') return true

  // IPv4-mapped IPv6 → 取出内嵌 IPv4，按下方 IPv4 规则判定
  const mapped = extractMappedIpv4(host)
  if (mapped) host = mapped

  // IPv4 字面量
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return true                          // 0.0.0.0/8 未指定
    if (a === 10) return true                         // 10.0.0.0/8 私网
    if (a === 127) return true                        // 127.0.0.0/8 环回
    if (a === 169 && b === 254) return true           // 169.254.0.0/16 链路本地（含元数据）
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return true           // 192.168.0.0/16 私网
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }

  // IPv6 字面量：环回 / 未指定 / ULA(fc00::/7) / 链路本地(fe80::/10)
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd]/.test(host)) return true   // fc00::/7
    if (/^fe[89ab]/.test(host)) return true // fe80::/10
    return false
  }

  return false
}
