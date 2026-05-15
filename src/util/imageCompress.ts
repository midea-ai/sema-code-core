import { logDebug, logWarn } from './log'
import Jimp from 'jimp'

const MIN_QUALITY = 20
const MIN_DIMENSION = 100
const MAX_DIMENSION_HARD_LIMIT = 4096

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