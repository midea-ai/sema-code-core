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
 * fetch_url 目标主机分级，供 PermissionManager 裁决：
 *  blocked  → 链路本地（含云元数据 169.254.169.254）/ 已知元数据主机名 / 未指定地址 / URL 解析失败：
 *             确定性转人工，不交模型，不提供「永久允许该域名」
 *  private  → 内网段（10/8、172.16/12、192.168/16、CGNAT、ULA）：转人工，但允许保存域名授权——
 *             公司内网 API 是合法高频目标，不给 allow 会让同一域名每次都问
 *  loopback → 环回（localhost、127/8、::1）：用户自己机器上的服务，与 run_shell 里 curl localhost 对齐，
 *             AutoRun 交模型按请求内容判断；不提供永久授权（「记住 localhost」范围过宽）
 *  public   → 其余，走正常流程
 *
 * 说明：new URL() (WHATWG) 已把 十进制/十六进制/八进制/短写 IPv4（如 2130706433、0x7f000001、
 * 127.1）规范化为点分十进制，故无需额外处理；这里额外补：
 *  - IPv4-mapped IPv6（::ffff:7f00:1 等）
 *  - 末尾点 FQDN（localhost. 等）
 */
export type FetchHostClass = 'public' | 'loopback' | 'private' | 'blocked'

export function classifyFetchHost(url: string): FetchHostClass {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return 'blocked'
  }

  // 去掉 IPv6 字面量方括号，并去掉末尾点（FQDN 绝对形式，如 localhost.）
  let host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')

  // 本地主机名 / 已知云元数据主机名
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (host === 'metadata.google.internal') return 'blocked'

  // IPv4-mapped IPv6 → 取出内嵌 IPv4，按下方 IPv4 规则判定
  const mapped = extractMappedIpv4(host)
  if (mapped) host = mapped

  // IPv4 字面量
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return 'blocked'                          // 0.0.0.0/8 未指定
    if (a === 127) return 'loopback'                       // 127.0.0.0/8 环回
    if (a === 169 && b === 254) return 'blocked'           // 169.254.0.0/16 链路本地（含元数据）
    if (a === 10) return 'private'                         // 10.0.0.0/8 私网
    if (a === 172 && b >= 16 && b <= 31) return 'private'  // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return 'private'           // 192.168.0.0/16 私网
    if (a === 100 && b >= 64 && b <= 127) return 'private' // 100.64.0.0/10 CGNAT
    return 'public'
  }

  // IPv6 字面量：环回 / 未指定 / ULA(fc00::/7) / 链路本地(fe80::/10)
  if (host.includes(':')) {
    if (host === '::1') return 'loopback'
    if (host === '::') return 'blocked'
    if (/^f[cd]/.test(host)) return 'private'  // fc00::/7
    if (/^fe[89ab]/.test(host)) return 'blocked' // fe80::/10
    return 'public'
  }

  return 'public'
}
