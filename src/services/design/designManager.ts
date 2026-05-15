/**
 * Design 资源管理器
 *
 * 扫描全局设计资源：
 *   - ~/.sema/designs/skills          每个子目录下含 SKILL.md
 *   - ~/.sema/designs/design-systems  每个子目录下含 DESIGN.md
 *
 * 同步扫盘 + 进程内缓存；调用方可传 refresh=true 强制重读。
 * 同步入口 (listDesignSkills / listDesignSystems) 供 reminder 等同步链路使用，
 * 异步入口 (getDesignSkillsInfo / getDesignSystemsInfo) 供外部 SemaCore API 暴露。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getSemaRootDir } from '../../util/savePath'
import { parseFile } from '../../util/formatter'
import { logDebug, logError, logInfo } from '../../util/log'
import {
  ColorPair,
  compositeOver,
  dedupePairs,
  extractPairsFromFrontmatterColors,
  extractPairsFromMarkdown,
  isNeutralHex,
  isOpaqueHex,
  luminance,
} from '../../util/color'
import { DesignSkillInfo, DesignSystemInfo, DesignSystemColor } from '../../types/design'

const DESIGN_SKILL_FILE_NAME = 'SKILL.md'
const DESIGN_SYSTEM_FILE_NAME = 'DESIGN.md'

/** H1 上的官方前缀，剥掉后用作 name */
const TITLE_PREFIX = 'Design System Inspired by '

class DesignManager {
  private skillsDir: string
  private designSystemsDir: string

  private skillCache: DesignSkillInfo[] | null = null
  private systemCache: DesignSystemInfo[] | null = null

  constructor() {
    const semaRoot = getSemaRootDir()
    this.skillsDir = path.join(semaRoot, 'designs', 'skills')
    this.designSystemsDir = path.join(semaRoot, 'designs', 'design-systems')
  }

  listDesignSkills(refresh?: boolean): DesignSkillInfo[] {
    if (refresh || !this.skillCache) {
      this.skillCache = this.loadDesignSkills()
    }
    return this.skillCache
  }

  listDesignSystems(refresh?: boolean): DesignSystemInfo[] {
    if (refresh || !this.systemCache) {
      this.systemCache = this.loadDesignSystems()
    }
    return this.systemCache
  }

  async getDesignSkillsInfo(refresh?: boolean): Promise<DesignSkillInfo[]> {
    return this.listDesignSkills(refresh)
  }

  async getDesignSystemsInfo(refresh?: boolean): Promise<DesignSystemInfo[]> {
    return this.listDesignSystems(refresh)
  }

  private loadDesignSkills(): DesignSkillInfo[] {
    const result: DesignSkillInfo[] = []
    try {
      if (!fs.existsSync(this.skillsDir)) {
        logDebug(`Design skills 目录不存在: ${this.skillsDir}`)
        return result
      }
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFilePath = path.join(this.skillsDir, entry.name, DESIGN_SKILL_FILE_NAME)
        if (!fs.existsSync(skillFilePath)) continue
        try {
          const { metadata } = parseFile(skillFilePath)
          const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
          const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
          if (!name && !description) continue
          result.push({
            folderName: entry.name,
            filePath: skillFilePath,
            name,
            description,
          })
        } catch (error) {
          logError(`解析设计 Skill 文件失败 [${skillFilePath}]: ${error}`)
        }
      }
      result.sort((a, b) => a.folderName.localeCompare(b.folderName))
      logInfo(`Design skills 加载完成: ${result.length} 个`)
    } catch (error) {
      logError(`加载 Design skills 失败 [${this.skillsDir}]: ${error}`)
    }
    return result
  }

  private loadDesignSystems(): DesignSystemInfo[] {
    const result: DesignSystemInfo[] = []
    try {
      if (!fs.existsSync(this.designSystemsDir)) {
        logDebug(`Design systems 目录不存在: ${this.designSystemsDir}`)
        return result
      }
      const entries = fs.readdirSync(this.designSystemsDir, { withFileTypes: true })
      const items: Array<{ info: DesignSystemInfo; mtime: number }> = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const designFilePath = path.join(this.designSystemsDir, entry.name, DESIGN_SYSTEM_FILE_NAME)
        if (!fs.existsSync(designFilePath)) continue
        try {
          const info = parseDesignSystemFile(entry.name, designFilePath)
          if (!info) continue
          const mtime = fs.statSync(designFilePath).mtimeMs
          items.push({ info, mtime })
        } catch (error) {
          logError(`解析 Design system 文件失败 [${designFilePath}]: ${error}`)
        }
      }
      // 按 DESIGN.md 修改时间倒序：最近编辑的排前
      items.sort((a, b) => b.mtime - a.mtime)
      result.push(...items.map(i => i.info))
      logInfo(`Design systems 加载完成: ${result.length} 个`)
    } catch (error) {
      logError(`加载 Design systems 失败 [${this.designSystemsDir}]: ${error}`)
    }
    return result
  }

  dispose(): void {
    this.skillCache = null
    this.systemCache = null
  }
}

// ===================== Design system 解析 =====================

/**
 * 解析单个 DESIGN.md。两种格式：
 *   A. Frontmatter (YAML)：name/description 在 metadata，colors 在 colors: 子块
 *   B. 纯 Markdown：name = H1（剥前缀）, description = 紧跟的 > 引用块, colors 用正则扫
 */
function parseDesignSystemFile(folderName: string, filePath: string): DesignSystemInfo | null {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const hasFrontmatter = /^---\r?\n/.test(raw)

  let name = ''
  let description = ''
  let pairs: ColorPair[] = []

  if (hasFrontmatter) {
    const { metadata, prompt } = parseFile(filePath)
    name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
    description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
    pairs = extractPairsFromFrontmatterColors(raw)
    // frontmatter 没 colors 子块时回退扫正文
    if (pairs.length === 0) pairs = extractPairsFromMarkdown(prompt)
  } else {
    const meta = extractMarkdownMeta(raw)
    name = meta.name
    description = meta.description
    pairs = extractPairsFromMarkdown(raw)
  }

  const deduped = dedupePairs(pairs)
  return {
    folderName,
    filePath,
    name,
    description,
    swatches: pickSlots(deduped),
    colors: deduped.map(p => ({ key: p.name, value: p.value })),
  }
}

/**
 * 纯 Markdown 文件：提名字 + 描述。
 *   - name = 第一个 H1，剥掉 "Design System Inspired by " 前缀
 *   - description = H1 后紧跟的 > 引用块（跳过 "> Category:" 行）
 */
function extractMarkdownMeta(content: string): { name: string; description: string } {
  const lines = content.split(/\r?\n/)
  let name = ''
  const descLines: string[] = []
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length) {
    const m = lines[i].match(/^#\s+(.+)$/)
    if (m) {
      name = m[1].trim()
      if (name.toLowerCase().startsWith(TITLE_PREFIX.toLowerCase())) {
        name = name.slice(TITLE_PREFIX.length).trim()
      }
      i++
    }
  }
  while (i < lines.length && lines[i].trim() === '') i++
  while (i < lines.length) {
    const m = lines[i].match(/^>\s?(.*)$/)
    if (!m) break
    const text = m[1].trim()
    if (/^Category\s*:/i.test(text)) {
      i++
      continue
    }
    if (text) descLines.push(text)
    i++
  }
  return { name, description: descLines.join(' ').trim() }
}

/**
 * 按名字提示词贪心挑 4 个槽位，返回顺序固定为 [background, muted, foreground, accent]。
 * 命中规则：先 exact match，再 substring；substring 多匹配时偏好不含 "dark" 的 key
 * （默认按亮色主题挑），让 canvas-light / hairline-on-light 类成对变体走亮色一边。
 * 未命中走多级 fallback。所有 swatch 都会按 background 做 alpha 合成，输出固定 6 位
 * 不透明 hex。
 */
function pickSlots(pairs: ColorPair[]): DesignSystemColor[] {
  // 词典按特异性从高到低：先精确词，再泛化词
  const backgroundHints = [
    'page background',
    'background',
    'canvas',
    'cream',
    'paper',
    'surface',
    'off-white',
    'off white',
    'base',
  ]
  const foregroundHints = [
    'title',
    'heading',
    'text primary',
    'foreground',
    'ink',
    'fg',
    'body',
    'paragraph',
    'text',
    'black',
    'navy',
    'graphite',
    'charcoal',
  ]
  // primary 提到 accent/brand 之前：业界惯例 primary 比 accent-* 更指向品牌主色
  const accentHints = [
    'primary brand',
    'brand primary',
    'brand color',
    'brand accent',
    'accent color',
    'primary',
    'brand',
    'accent',
    'cta',
    'highlight',
  ]
  // hairline 提到 border 之前：hairline-on-light/dark 是典型成对变体，便于亮色偏好生效
  const mutedHints = [
    'separator',
    'divider',
    'hairline',
    'border default',
    'border',
    'rule',
    'muted',
    'subtle',
    'sand',
    'fill',
    'neutral',
    'secondary',
    'opaque',
  ]

  const findByHints = (
    hints: string[],
    filter?: (p: ColorPair) => boolean,
  ): ColorPair | undefined => {
    for (const h of hints) {
      // 1. exact match 优先 —— 避免 'accent' 误吞 'accent-turquoise' 这类复合 key
      const exact = pairs.find(p => p.name === h && (!filter || filter(p)))
      if (exact) return exact
      // 2. substring 多匹配时偏好不含 'dark' 的 key —— 成对变体默认走亮色
      const matches = pairs.filter(p => p.name.includes(h) && (!filter || filter(p)))
      if (matches.length === 0) continue
      return matches.find(p => !p.name.includes('dark')) ?? matches[0]
    }
    return undefined
  }

  // background：必须不透明；没命中就选第一个不透明色（保留文档顺序）
  const bgPair =
    findByHints(backgroundHints, p => isOpaqueHex(p.value)) ??
    pairs.find(p => isOpaqueHex(p.value))
  const background = bgPair?.value ?? '#ffffff'
  const bgLum = luminance(background)

  // foreground：命中失败 → 不透明色里挑与背景亮度差最大的（自动适配明/暗主题）
  let fgPair = findByHints(foregroundHints)
  if (!fgPair) {
    fgPair = [...pairs]
      .filter(p => isOpaqueHex(p.value))
      .sort((a, b) => Math.abs(luminance(b.value) - bgLum) - Math.abs(luminance(a.value) - bgLum))[0]
  }
  const foreground = fgPair ? compositeOver(fgPair.value, background) : '#111111'

  // accent：命中需非中性；回退优先不透明
  let accentPair = findByHints(accentHints, p => !isNeutralHex(p.value))
  if (!accentPair) {
    accentPair =
      pairs.find(p => !isNeutralHex(p.value) && isOpaqueHex(p.value)) ??
      pairs.find(p => !isNeutralHex(p.value)) ??
      pairs[0]
  }
  const accent = accentPair ? compositeOver(accentPair.value, background) : '#888888'

  // muted：命中失败 → 找一个不等于 bg/fg 的中性色
  let mutedPair = findByHints(mutedHints)
  if (!mutedPair) {
    mutedPair = pairs.find(
      p =>
        isNeutralHex(p.value) &&
        p.value !== bgPair?.value &&
        p.value !== fgPair?.value,
    )
  }
  const muted = mutedPair ? compositeOver(mutedPair.value, background) : '#cccccc'

  return [
    { key: 'background', value: background },
    { key: 'muted', value: muted },
    { key: 'foreground', value: foreground },
    { key: 'accent', value: accent },
  ]
}

// ===================== 单例 =====================

let designManagerInstance: DesignManager | null = null

export function getDesignManager(): DesignManager {
  if (!designManagerInstance) {
    designManagerInstance = new DesignManager()
  }
  return designManagerInstance
}

export { DesignManager }
