/**
 * 色彩提取与归一化工具
 *
 * 从 Markdown / frontmatter 中嗅探 `Name: color` 形态的 color token，
 * 支持 #hex (3/4/6/8) 与 rgb()/rgba() 两种写法，统一归一为 6 位（不透明）
 * 或 8 位 hex（带 alpha），并提供 alpha 合成、亮度计算等 swatch 辅助函数。
 */

export interface ColorPair {
  name: string
  value: string // 归一化后的 hex：#rrggbb 或 #rrggbbaa
}

const HEX_FRAGMENT = '#[0-9a-fA-F]{3,8}'
const FUNC_FRAGMENT = 'rgba?\\([^)]*\\)'
const COLOR_FRAGMENT = `(?:${HEX_FRAGMENT}|${FUNC_FRAGMENT})`

/**
 * 从 frontmatter 中读 colors: 子块，逐行 `key: "#xxx"`。
 * 通用 YAML 解析器不支持嵌套对象，这里独立实现以支持单层缩进的 colors。
 */
export function extractPairsFromFrontmatterColors(content: string): ColorPair[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return []
  const lines = match[1].split(/\r?\n/)
  const result: ColorPair[] = []
  let inColors = false
  let baseIndent = -1
  for (const raw of lines) {
    if (!inColors) {
      if (/^colors\s*:\s*$/.test(raw.trim())) {
        inColors = true
        baseIndent = -1
      }
      continue
    }
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) break
    if (baseIndent === -1) baseIndent = indent
    if (indent < baseIndent) break
    const colonIdx = raw.indexOf(':')
    if (colonIdx === -1) continue
    const key = raw.slice(0, colonIdx).trim()
    let value = raw.slice(colonIdx + 1).trim()
    // 行内注释（保守地按 " #" 切，避免误伤 hex）
    const commentIdx = value.indexOf(' #')
    if (commentIdx !== -1 && !/^["'].*["']$/.test(value)) {
      value = value.slice(0, commentIdx).trim()
    }
    // 去包裹引号
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' || first === "'") && first === last) {
        value = value.slice(1, -1)
      }
    }
    const norm = normalizeColor(value)
    if (key && norm) result.push({ name: cleanName(key), value: norm })
  }
  return result
}

/**
 * 纯 Markdown 颜色嗅探。
 *   Form A:  - **Name:** `color`
 *   Form B:  **Name** (`color` …) —— 中间允许 token 占位符；color 必须是 backtick 内的完整色值
 * color 支持 #hex 与 rgb()/rgba()。要求 backtick 内 strict 等于色值（trim），避免抓
 * gradient / box-shadow 内的颜色片段。
 */
export function extractPairsFromMarkdown(content: string): ColorPair[] {
  const pairs: ColorPair[] = []
  const reA = new RegExp(`\\*\\*([^*\\n]+?):\\*\\*\\s*\`\\s*(${COLOR_FRAGMENT})\\s*\``, 'g')
  const reB = new RegExp(
    `\\*\\*([^*\\n]+?)\\*\\*\\s*\\([^*\\n]*?\`\\s*(${COLOR_FRAGMENT})\\s*\``,
    'g',
  )
  for (const re of [reA, reB]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const norm = normalizeColor(m[2])
      if (norm) pairs.push({ name: cleanName(m[1]), value: norm })
    }
  }
  return pairs
}

export function dedupePairs(pairs: ColorPair[]): ColorPair[] {
  const seen = new Set<string>()
  const out: ColorPair[] = []
  for (const p of pairs) {
    const k = `${p.name}|${p.value}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

export function cleanName(raw: string): string {
  return raw.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 统一色值入口：识别 #hex / rgb() / rgba()，归一为 #rrggbb 或 #rrggbbaa（小写） */
export function normalizeColor(value: string): string | null {
  const v = value.trim()
  if (v.startsWith('#')) return normalizeHex(v)
  const m = v.match(/^rgba?\(\s*([^)]*)\)\s*$/i)
  if (m) return rgbToHex(m[1])
  return null
}

export function normalizeHex(value: string): string | null {
  const m = value.trim().match(/^#([0-9a-fA-F]+)$/)
  if (!m) return null
  let hex = m[1].toLowerCase()
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map(c => c + c)
      .join('')
  } else if (hex.length !== 6 && hex.length !== 8) {
    return null
  }
  return '#' + hex
}

function rgbToHex(inner: string): string | null {
  // 支持逗号、空白、斜杠（CSS Color 4 的 `rgb(R G B / A)` 写法）作分隔
  const parts = inner.split(/[,/\s]+/).filter(p => p.length > 0)
  if (parts.length !== 3 && parts.length !== 4) return null
  const r = parseChannel(parts[0])
  const g = parseChannel(parts[1])
  const b = parseChannel(parts[2])
  if (r === null || g === null || b === null) return null
  const a = parts.length === 4 ? parseAlpha(parts[3]) : 1
  if (a === null) return null
  const base = '#' + toHex2(r) + toHex2(g) + toHex2(b)
  if (a >= 0.999) return base
  return base + toHex2(Math.round(a * 255))
}

function parseChannel(s: string): number | null {
  if (s.endsWith('%')) {
    const v = parseFloat(s.slice(0, -1))
    if (isNaN(v)) return null
    return clamp255(Math.round((v / 100) * 255))
  }
  const v = parseFloat(s)
  if (isNaN(v)) return null
  return clamp255(Math.round(v))
}

function parseAlpha(s: string): number | null {
  if (s.endsWith('%')) {
    const v = parseFloat(s.slice(0, -1))
    if (isNaN(v)) return null
    return Math.max(0, Math.min(1, v / 100))
  }
  const v = parseFloat(s)
  if (isNaN(v)) return null
  return Math.max(0, Math.min(1, v))
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, n))
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/**
 * 判定是否为中性色（接近灰）。兼容 6 位与 8 位 hex；带 alpha 时仅看 RGB 通道，
 * 不再把 8 位 hex 一律视为非中性。
 */
export function isNeutralHex(hex: string): boolean {
  if (hex.length !== 7 && hex.length !== 9) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if ([r, g, b].some(isNaN)) return false
  return Math.max(r, g, b) - Math.min(r, g, b) < 10
}

/** 是否完全不透明：6 位 hex 或 8 位 hex 末两位为 ff */
export function isOpaqueHex(hex: string): boolean {
  if (hex.length === 7) return true
  if (hex.length !== 9) return false
  return hex.slice(7, 9).toLowerCase() === 'ff'
}

/**
 * 把（可能带 alpha 的）前景色合成到背景上，输出 6 位不透明 hex。
 * 用于把 rgba token 渲染成 swatch 可见颜色。
 */
export function compositeOver(fgHex: string, bgHex: string): string {
  const fg = parseHexRgba(fgHex)
  if (!fg) return fgHex
  if (fg.a >= 0.999) return '#' + toHex2(fg.r) + toHex2(fg.g) + toHex2(fg.b)
  const bg = parseHexRgba(bgHex)
  if (!bg) return '#' + toHex2(fg.r) + toHex2(fg.g) + toHex2(fg.b)
  const a = fg.a
  const r = Math.round(fg.r * a + bg.r * (1 - a))
  const g = Math.round(fg.g * a + bg.g * (1 - a))
  const b = Math.round(fg.b * a + bg.b * (1 - a))
  return '#' + toHex2(r) + toHex2(g) + toHex2(b)
}

function parseHexRgba(
  hex: string,
): { r: number; g: number; b: number; a: number } | null {
  if (hex.length !== 7 && hex.length !== 9) return null
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if ([r, g, b].some(isNaN)) return null
  const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1
  if (isNaN(a)) return null
  return { r, g, b, a }
}

/** 感知亮度（0~1），用于按亮度排序回退挑色 */
export function luminance(hex: string): number {
  const parsed = parseHexRgba(hex)
  if (!parsed) return 0.5
  return (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255
}
