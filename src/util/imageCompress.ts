import { logDebug, logInfo, logWarn } from './log'
import Jimp from 'jimp'
import type { InputImageAttachment } from '../types/message'

const MIN_QUALITY = 20
const MIN_DIMENSION = 100
const MAX_DIMENSION_HARD_LIMIT = 4096

// 单张图片体积硬上限，超出则压缩（ViewFile / 粘贴附件 / MCP 图片共用）
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
// PNG 超过此体积即转 JPEG：照片类 PNG 几乎不压缩，转 JPEG 体积通常降一个数量级
const CONVERT_TO_JPEG_BYTES = 500 * 1024
// 长边上限：Anthropic 服务端会把长边超过 1568 的图缩到 1568，本地先缩省掉白传的字节
const MAX_LONG_EDGE = 1568
// 转 JPEG 的默认质量
const CONVERT_QUALITY = 85
// 支持的图片 media_type 白名单
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

export type ImageMediaType = typeof SUPPORTED_IMAGE_MEDIA_TYPES[number]
/** PNG 透明度统计：全透明像素占比、四角是否透明（四角透明基本就是透明背景） */
export type PngAlphaStats = { transparentRatio: number; cornersTransparent: boolean }
// alpha 只在 PNG 文件头声明了透明时才统计；转成 JPEG 后透明区已铺白，统计值描述的是原图
export type NormalizedImage = { data: string; media_type: ImageMediaType; bytes: number; alpha?: PngAlphaStats }

/** 图片体积超过硬上限且无法再压时抛出，调用方据此决定报错还是忽略 */
export class ImageTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly limit: number) {
    super(`image ${Math.round(bytes / 1024)}KB exceeds ${Math.round(limit / 1024)}KB limit`)
    this.name = 'ImageTooLargeError'
  }
}

/** 只读文件头取尺寸，避免为了判断长边把整张图解码一遍；解析不出返回 null */
function readImageSize(buffer: Buffer, mediaType: ImageMediaType): { width: number; height: number } | null {
  try {
    if (mediaType === 'image/png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (mediaType === 'image/jpeg') {
      let i = 2
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue }
        const marker = buffer[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
        const len = buffer.readUInt16BE(i + 2)
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSOF) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
        i += 2 + len
      }
      return null
    }
    if (mediaType === 'image/webp' && buffer.length >= 30 && buffer.toString('latin1', 12, 16) === 'VP8X') {
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
    }
    if (mediaType === 'image/webp' && buffer.length >= 30 && buffer.toString('latin1', 12, 16) === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (mediaType === 'image/webp' && buffer.length >= 25 && buffer.toString('latin1', 12, 16) === 'VP8L') {
      const b = buffer.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
  } catch {
    return null
  }
  return null
}

const toBase64Result = (buf: Buffer, media_type: ImageMediaType, alpha?: PngAlphaStats): NormalizedImage =>
  ({ data: buf.toString('base64'), media_type, bytes: buf.length, ...(alpha ? { alpha } : {}) })

/** 只看文件头判断 PNG 是否可能带透明：IHDR colorType 4/6（灰度+alpha / RGBA），或 IDAT 之前出现 tRNS 块 */
function pngMayHaveAlpha(buffer: Buffer): boolean {
  if (buffer.length < 26) return false
  const colorType = buffer[25]
  if (colorType === 4 || colorType === 6) return true
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'tRNS') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + len
  }
  return false
}

/** 扫一遍 alpha 通道：alpha 为 0 的像素占比 + 四角是否全透明 */
function inspectAlpha(image: Jimp): PngAlphaStats {
  const { data, width, height } = image.bitmap
  let transparent = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++
  }
  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
  return {
    transparentRatio: transparent / (width * height),
    cornersTransparent: corners.every(p => data[p * 4 + 3] === 0),
  }
}

/** 读取 PNG 的透明度统计；文件头没声明透明、或不是能解码的 PNG 时返回 null */
export async function readPngAlphaStats(buffer: Buffer): Promise<PngAlphaStats | null> {
  if (!pngMayHaveAlpha(buffer)) return null
  try {
    return inspectAlpha(await Jimp.read(buffer))
  } catch {
    return null
  }
}

/**
 * 发给模型前的图片归一化，三条入口（view_file 读图、粘贴附件、MCP 返回图）共用：
 *  - GIF 不解码：≤ 上限原样返回，否则抛 ImageTooLargeError
 *  - WebP：Jimp 0.22 无解码器，无法转码，规则同 GIF
 *  - PNG 超过 CONVERT_TO_JPEG_BYTES、或任意格式长边超过 MAX_LONG_EDGE：解码后缩到长边 ≤ 1568 并按 CONVERT_QUALITY 编成 JPEG
 *    （带透明通道的先铺白底，避免透明区在 JPEG 里变黑）
 *  - 转码后仍超过硬上限：交给 compressImage 二分质量/尺寸
 *  - 转码没省字节（如纯色 UI 截图）且原图未超限、无需缩放：保留原图
 */
export async function normalizeImage(buffer: Buffer, mediaType: ImageMediaType): Promise<NormalizedImage> {
  const bytes = buffer.length
  if (mediaType === 'image/gif' || mediaType === 'image/webp') {
    if (bytes > MAX_IMAGE_BYTES) throw new ImageTooLargeError(bytes, MAX_IMAGE_BYTES)
    return toBase64Result(buffer, mediaType)
  }

  const size = readImageSize(buffer, mediaType)
  const longEdge = size ? Math.max(size.width, size.height) : 0
  const needResize = longEdge > MAX_LONG_EDGE
  const needConvert = mediaType === 'image/png' && bytes > CONVERT_TO_JPEG_BYTES
  const overLimit = bytes > MAX_IMAGE_BYTES
  // 文件头声明了透明的 PNG 要解码统计 alpha，供调用方把"透明区已铺白"的事实告诉模型
  const mayHaveAlpha = mediaType === 'image/png' && pngMayHaveAlpha(buffer)
  if (!needResize && !needConvert && !overLimit) {
    return toBase64Result(buffer, mediaType, mayHaveAlpha ? inspectAlpha(await Jimp.read(buffer)) : undefined)
  }

  logDebug(`normalizeImage: ${mediaType} ${Math.round(bytes / 1024)}KB ${size ? `${size.width}x${size.height}` : '?'} resize=${needResize} convert=${needConvert} overLimit=${overLimit}`)
  let image = await Jimp.read(buffer)
  const alpha = mayHaveAlpha ? inspectAlpha(image) : undefined

  // 小体积 PNG 只是长边超限：缩放后仍存 PNG，保住透明通道与截图文字的锐度；缩完仍超体积阈值再走 JPEG
  if (mediaType === 'image/png' && !needConvert && !overLimit) {
    const scale = MAX_LONG_EDGE / Math.max(image.getWidth(), image.getHeight())
    const resized = image.clone().resize(Math.round(image.getWidth() * scale), Math.round(image.getHeight() * scale), Jimp.RESIZE_BILINEAR)
    const png = await resized.getBufferAsync(Jimp.MIME_PNG)
    if (png.length <= CONVERT_TO_JPEG_BYTES) {
      logInfo(`normalizeImage: png ${Math.round(bytes / 1024)}KB → png ${Math.round(png.length / 1024)}KB (${resized.getWidth()}x${resized.getHeight()})`)
      return toBase64Result(png, 'image/png', alpha)
    }
  }

  if (image.hasAlpha()) {
    image = new Jimp(image.getWidth(), image.getHeight(), 0xffffffff).composite(image, 0, 0)
  }
  const actualLongEdge = Math.max(image.getWidth(), image.getHeight())
  if (actualLongEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / actualLongEdge
    image.resize(Math.round(image.getWidth() * scale), Math.round(image.getHeight() * scale), Jimp.RESIZE_BILINEAR)
  }
  const jpeg = await image.quality(CONVERT_QUALITY).getBufferAsync(Jimp.MIME_JPEG)

  if (jpeg.length > MAX_IMAGE_BYTES) {
    const compressed = await compressImage(jpeg, 'image/jpeg', MAX_IMAGE_BYTES)
    const compressedBytes = Math.ceil(compressed.data.length * 3 / 4)
    if (compressedBytes > MAX_IMAGE_BYTES) throw new ImageTooLargeError(compressedBytes, MAX_IMAGE_BYTES)
    return { ...compressed, bytes: compressedBytes, ...(alpha ? { alpha } : {}) }
  }
  if (jpeg.length >= bytes && !overLimit && actualLongEdge <= MAX_LONG_EDGE) {
    logDebug(`normalizeImage: jpeg ${Math.round(jpeg.length / 1024)}KB not smaller than original, keeping original`)
    return toBase64Result(buffer, mediaType, alpha)
  }
  logInfo(`normalizeImage: ${mediaType} ${Math.round(bytes / 1024)}KB → jpeg ${Math.round(jpeg.length / 1024)}KB (${image.getWidth()}x${image.getHeight()})`)
  return toBase64Result(jpeg, 'image/jpeg', alpha)
}

/**
 * 规范化用户输入的图片附件：过滤非法 media_type，单张走 normalizeImage 归一化
 * 返回干净可直接转 image content block 的附件数组；
 * 正常轮次（SemaEngine.processQuery）与轮内注入（Conversation 注入路径）共用同一套规则
 */
export async function normalizeImageAttachments(attachments?: InputImageAttachment[]): Promise<InputImageAttachment[]> {
  if (!attachments || attachments.length === 0) return []

  const result: InputImageAttachment[] = []
  for (const att of attachments) {
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(att.media_type as ImageMediaType)) {
      logWarn(`忽略不支持的图片类型: ${att.media_type}`)
      continue
    }
    try {
      const normalized = await normalizeImage(Buffer.from(att.data, 'base64'), att.media_type as ImageMediaType)
      result.push(normalized.data === att.data ? att : { type: 'image', data: normalized.data, media_type: normalized.media_type })
    } catch (e) {
      logWarn(`处理图片附件失败，已忽略: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 图片附件转 API image content block（正常轮次与注入路径共用） */
export function toImageContentBlocks(attachments?: InputImageAttachment[]): Array<{ type: 'image'; source: { type: 'base64'; media_type: InputImageAttachment['media_type']; data: string } }> {
  return (attachments ?? []).map(a => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: a.media_type, data: a.data },
  }))
}

/**
 * 压缩图片至目标大小以内，尽可能保留质量
 *
 * 策略：
 *  0. 预缩放：长边超过动态上限时先等比缩小，避免巨图拖慢后续二分
 *  1. 阶段一：固定预缩放尺寸，二分 quality [MIN_QUALITY, 95]，找最大满足条件的质量
 *  2. 阶段二：quality 到底仍超限，二分 scale [0.1, 1.0]，找最大满足条件的尺寸
 *  3. 兜底：返回最小尺寸 + 最低质量的结果
 */
export async function compressImage(
  buffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
  maxSizeBytes: number,
): Promise<{ data: string; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  const originalSize = buffer.length
  logDebug(`imageCompress: original ${Math.round(originalSize / 1024)}KB, limit ${Math.round(maxSizeBytes / 1024)}KB`)

  // gif 不压缩，直接返回原始数据
  if (mediaType === 'image/gif') {
    logWarn('imageCompress: gif compression not supported, returning original')
    return { data: buffer.toString('base64'), media_type: mediaType }
  }

  // 已在限制内，无需处理（保留原始格式）
  if (originalSize <= maxSizeBytes) {
    logDebug('imageCompress: already within limit, returning original')
    return { data: buffer.toString('base64'), media_type: mediaType }
  }

  const image = await Jimp.read(buffer)
  const originalWidth = image.getWidth()
  const originalHeight = image.getHeight()
  const outputMediaType = 'image/jpeg'

  // 辅助：克隆并压缩为指定尺寸 + 质量的 JPEG Buffer
  const compress = async (w: number, h: number, q: number): Promise<Buffer> =>
    image.clone().resize(w, h, Jimp.RESIZE_BILINEAR).quality(q).getBufferAsync(Jimp.MIME_JPEG)

  // ── 预处理：限制最大尺寸 ────────────────────────────────────────
  // 动态上限：根据目标大小估算合理的最大边长，同时不超过硬上限
  // JPEG quality≈80 时经验压缩比约 0.2（字节/像素），乘 2 留余量
  const dynamicMaxDimension = Math.min(
    MAX_DIMENSION_HARD_LIMIT,
    Math.round(Math.sqrt((maxSizeBytes / 0.2) * 2)),
  )

  let workWidth = originalWidth
  let workHeight = originalHeight

  const maxSide = Math.max(originalWidth, originalHeight)
  if (maxSide > dynamicMaxDimension) {
    const preScale = dynamicMaxDimension / maxSide
    workWidth = Math.round(originalWidth * preScale)
    workHeight = Math.round(originalHeight * preScale)
    logDebug(
      `imageCompress: pre-scale ${originalWidth}x${originalHeight} → ${workWidth}x${workHeight} (limit=${dynamicMaxDimension}px)`,
    )
  }

  // ── 阶段一：二分质量，保持预缩放尺寸 ───────────────────────────
  // 先检测最高质量是否已满足，避免不必要的二分
  const hiQuality = 95
  const hiResult = await compress(workWidth, workHeight, hiQuality)
  if (hiResult.length <= maxSizeBytes) {
    logDebug(`imageCompress: quality=${hiQuality} fits, done`)
    return { data: hiResult.toString('base64'), media_type: outputMediaType }
  }

  let lo = MIN_QUALITY
  let hi = hiQuality - 1 // hiQuality 已测试过且超限，从 hiQuality-1 开始
  let bestQualityBuf: Buffer | null = null
  let bestQuality = lo

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const buf = await compress(workWidth, workHeight, mid)
    logDebug(`imageCompress: [quality bisect] q=${mid}, size=${Math.round(buf.length / 1024)}KB`)

    if (buf.length <= maxSizeBytes) {
      bestQualityBuf = buf
      bestQuality = mid
      lo = mid + 1 // 满足条件，尝试更高质量
    } else {
      hi = mid - 1 // 超限，降低质量
    }
  }

  if (bestQualityBuf) {
    const ratio = Math.round((1 - bestQualityBuf.length / originalSize) * 100)
    logDebug(
      `imageCompress: best quality=${bestQuality}, size=${Math.round(bestQualityBuf.length / 1024)}KB (↓${ratio}%)`,
    )
    return { data: bestQualityBuf.toString('base64'), media_type: outputMediaType }
  }

  // ── 阶段二：quality 到底仍超限，二分尺寸 ───────────────────────
  logDebug(`imageCompress: quality phase failed, entering resize bisect`)

  // scale 相对于 workWidth/workHeight（已经预缩过），范围 [0.1, 1.0]
  let scaleLo = 0.1
  let scaleHi = 1.0
  let bestScaleBuf: Buffer | null = null
  let bestScale = scaleLo

  // scale 精度 0.02 足够（对应尺寸变化 < 2%）
  while (scaleHi - scaleLo > 0.02) {
    const midScale = (scaleLo + scaleHi) / 2
    const w = Math.max(MIN_DIMENSION, Math.round(workWidth * midScale))
    const h = Math.max(MIN_DIMENSION, Math.round(workHeight * midScale))
    const buf = await compress(w, h, MIN_QUALITY)
    logDebug(
      `imageCompress: [resize bisect] scale=${midScale.toFixed(2)}, ${w}x${h}, size=${Math.round(buf.length / 1024)}KB`,
    )

    if (buf.length <= maxSizeBytes) {
      bestScaleBuf = buf
      bestScale = midScale
      scaleLo = midScale // 满足条件，尝试更大尺寸
    } else {
      scaleHi = midScale // 超限，缩小尺寸
    }
  }

  if (bestScaleBuf) {
    const ratio = Math.round((1 - bestScaleBuf.length / originalSize) * 100)
    logDebug(
      `imageCompress: best scale=${bestScale.toFixed(2)}, size=${Math.round(bestScaleBuf.length / 1024)}KB (↓${ratio}%)`,
    )
    return { data: bestScaleBuf.toString('base64'), media_type: outputMediaType }
  }

  // ── 兜底：返回极限最小尺寸 + 最低质量（保持宽高比）─────────────
  logWarn('imageCompress: unable to compress below limit, returning best effort')
  const fbScale = MIN_DIMENSION / Math.max(workWidth, workHeight)
  const fbW = Math.max(1, Math.round(workWidth * fbScale))
  const fbH = Math.max(1, Math.round(workHeight * fbScale))
  const fallback = await compress(fbW, fbH, MIN_QUALITY)
  return { data: fallback.toString('base64'), media_type: outputMediaType }
}