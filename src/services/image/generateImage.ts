import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { ImageModelProfile, ImageGenResult, GeneratedImage } from '../../types/imageModel'
import { getAttachmentsDir } from '../../util/savePath'
import { logInfo, logWarn } from '../../util/log'

// 文生图统一调用：所有服务商都按 OpenAI Images 形态发一次 JSON POST，返回 data[] 里取 b64_json 或 url。
// 不下发尺寸、张数等参数，全部用服务商默认；图片拿到后立即落盘（服务商 URL 最短 1 小时过期）。

const IMAGE_GEN_TIMEOUT_MS = 300 * 1000
const IMAGE_ENDPOINT = '/images/generations'
const ERROR_BODY_MAX_LEN = 500

// 可选字段被端点拒绝后的记录（"地址#字段"，进程内有效），后续请求不再带该字段
const rejectedFields = new Set<string>()

// 透明背景：OpenAI Images 形态的 background + output_format（alpha 只有 png/webp 能承载）
const TRANSPARENT_FIELDS: Record<string, unknown> = { background: 'transparent', output_format: 'png' }

// 参考图单张上限（火山方舟的限制，OpenRouter 未公开数值）
export const REFERENCE_IMAGE_MAX_BYTES = 30 * 1024 * 1024
export const REFERENCE_IMAGE_MAX_COUNT = 10

export interface GenerateImageParams {
  profile: ImageModelProfile
  prompt: string
  outputPath?: string       // 绝对路径；不传则落到附件目录
  transparent?: boolean     // 请求透明背景；不支持的模型可能静默忽略（返回不带 alpha 的图）
  referenceImages?: string[] // 参考图：本地绝对路径或 http(s) URL，顺序即提示词里的"图 1、图 2"
  signal?: AbortSignal
  beforeWrite?: (filePath: string) => void  // 每张图写盘前回调（最终路径已确定），抛错则不写盘
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/**
 * 参考图转成服务商可接收的形式：URL 原样透传，本地文件读出来拼 data URL（格式按文件头识别，火山要求格式名小写）。
 * 不压缩，参考图要保真；只做单张大小硬上限
 */
function loadReferenceImage(ref: string): string {
  if (isHttpUrl(ref)) return ref
  const buf = fs.readFileSync(ref)
  if (buf.length > REFERENCE_IMAGE_MAX_BYTES) {
    throw new Error(`Reference image is too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, limit ${REFERENCE_IMAGE_MAX_BYTES / 1024 / 1024} MB): ${ref}`)
  }
  const type = sniffImageType(buf)
  if (!type) {
    throw new Error(`Reference image is not a supported image format (png, jpeg, webp, gif): ${ref}`)
  }
  return `data:${type.mediaType};base64,${buf.toString('base64')}`
}

/**
 * 按服务商拼参考图字段。OpenRouter Image API 用归一化的 input_references；
 * 其余（火山方舟及 custom，国内 OpenAI 兼容网关多为方舟形态）用 image，一张传字符串、多张传数组
 */
function referenceFields(provider: string, refs: string[]): Record<string, unknown> {
  if (provider === 'openrouter') {
    return { input_references: refs.map(url => ({ type: 'image_url', image_url: { url } })) }
  }
  return { image: refs.length === 1 ? refs[0] : refs }
}

/**
 * 构建文生图请求地址：baseURL 以 /images 或 /images/generations 结尾时原样使用，否则追加 /images/generations
 */
export function buildImageApiUrl(baseURL: string): string {
  const url = baseURL.trim().replace(/\/+$/, '')
  return /\/images(\/generations)?$/.test(url) ? url : `${url}${IMAGE_ENDPOINT}`
}

/**
 * 按文件头识别图片格式，识别不了返回 null
 */
export function sniffImageType(buf: Buffer): { mediaType: string; ext: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mediaType: 'image/png', ext: '.png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mediaType: 'image/jpeg', ext: '.jpg' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', ext: '.webp' }
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { mediaType: 'image/gif', ext: '.gif' }
  }
  return null
}

/**
 * 从错误响应体里取可读信息：兼容 { error: { code, message } }、{ code, message }、{ error: "..." } 与非 JSON 文本
 */
export function extractErrorMessage(body: string): string {
  const text = body.trim()
  try {
    const json = JSON.parse(text)
    const err = json?.error
    if (err && typeof err === 'object') {
      const code = err.code ?? err.type ?? err.name
      const message = err.message ?? JSON.stringify(err)
      return code ? `${code}: ${message}` : String(message)
    }
    if (typeof err === 'string') return err
    if (typeof json?.message === 'string') {
      return json.code ? `${json.code}: ${json.message}` : json.message
    }
  } catch {
    // 非 JSON（如网关返回的纯文本）：原样截断返回
  }
  return text.slice(0, ERROR_BODY_MAX_LEN)
}

// 目标路径已存在时加序号，不覆盖已有文件
function avoidOverwrite(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath
  const ext = path.extname(filePath)
  const base = filePath.slice(0, filePath.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

/**
 * 计算落盘路径。扩展名以图片实际格式为准（服务商默认输出格式不一，如 jpeg / png），
 * 与 outputPath 给的扩展名不一致时替换；一次返回多张时从第二张起加序号。
 */
function resolveTargetPath(outputPath: string | undefined, dir: string, index: number, ext: string): string {
  let target: string
  if (outputPath) {
    const givenExt = path.extname(outputPath)
    const base = givenExt ? outputPath.slice(0, outputPath.length - givenExt.length) : outputPath
    const sameFormat = givenExt.toLowerCase() === ext || (ext === '.jpg' && givenExt.toLowerCase() === '.jpeg')
    const suffix = index === 0 ? '' : `-${index + 1}`
    target = `${base}${suffix}${sameFormat ? givenExt : ext}`
  } else {
    target = path.join(dir, index === 0 ? `image${ext}` : `image-${index + 1}${ext}`)
  }
  return avoidOverwrite(target)
}

async function postJson(url: string, apiKey: string, body: object, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  return { status: response.status, text: await response.text() }
}

async function downloadImage(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await globalThis.fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Failed to download the generated image (HTTP ${response.status}).`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 生成图片并落盘。失败抛错，错误信息为服务商返回的原文，不自动重试。
 */
export async function generateImage(params: GenerateImageParams): Promise<ImageGenResult> {
  const { profile, prompt, outputPath, transparent, referenceImages, signal, beforeWrite } = params
  const start = Date.now()
  const url = buildImageApiUrl(profile.baseURL)
  // 参考图在发请求前就读好：读不到、格式不对直接失败，不占用超时时间
  const refs = (referenceImages ?? []).map(loadReferenceImage)

  // 超时只中断本次请求，不触碰调用方的 AbortController
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, IMAGE_GEN_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    // 可选字段：统一不加水印（部分服务商默认加，需显式关闭）；transparent 时下发透明背景与 png 输出。
    // 不认识某个字段的端点报 4xx 且错误信息点名了该字段时，去掉它重发一次，并记住此后不再带。
    // 参考图字段不进这个机制：丢了参考图就是另一张图，必须报错而不是降级
    const body: Record<string, unknown> = { model: profile.modelName, prompt, ...(refs.length > 0 ? referenceFields(profile.provider, refs) : {}) }
    const optional: Record<string, unknown> = { watermark: false, ...(transparent ? TRANSPARENT_FIELDS : {}) }
    for (const [key, value] of Object.entries(optional)) {
      if (!rejectedFields.has(`${url}#${key}`)) body[key] = value
    }

    let res = await postJson(url, profile.apiKey, body, controller.signal)
    if (res.status >= 400 && res.status < 500) {
      const rejected = Object.keys(optional).filter(key => key in body && new RegExp(key, 'i').test(res.text))
      if (rejected.length > 0) {
        logWarn(`文生图端点不接受字段 ${rejected.join(', ')}，去掉后重发: ${url}`)
        for (const key of rejected) {
          rejectedFields.add(`${url}#${key}`)
          delete body[key]
        }
        res = await postJson(url, profile.apiKey, body, controller.signal)
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Image generation failed (HTTP ${res.status}): ${extractErrorMessage(res.text)}`)
    }

    let json: any
    try {
      json = JSON.parse(res.text)
    } catch {
      throw new Error(`Image generation returned a non-JSON response: ${res.text.slice(0, ERROR_BODY_MAX_LEN)}`)
    }

    const items: any[] = Array.isArray(json?.data) ? json.data : []
    const buffers: Buffer[] = []
    for (const item of items) {
      if (typeof item?.b64_json === 'string' && item.b64_json) {
        buffers.push(Buffer.from(item.b64_json.replace(/^data:[^;]+;base64,/, ''), 'base64'))
      } else if (typeof item?.url === 'string' && item.url) {
        buffers.push(await downloadImage(item.url, controller.signal))
      }
    }

    // HTTP 200 但没有图：把响应里的说明带给调用方
    if (buffers.length === 0) {
      throw new Error(`The provider returned no image: ${extractErrorMessage(res.text)}`)
    }

    const dir = path.join(getAttachmentsDir(), randomUUID())
    const images: GeneratedImage[] = []
    buffers.forEach((buf, index) => {
      const type = sniffImageType(buf) ?? { mediaType: 'image/png', ext: '.png' }
      const filePath = resolveTargetPath(outputPath, dir, index, type.ext)
      beforeWrite?.(filePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, buf)
      images.push({ filePath, mediaType: type.mediaType, bytes: buf.length })
    })

    const durationMs = Date.now() - start
    logInfo(`文生图完成: model=${profile.name}, refs=${refs.length}, images=${images.length}, ${durationMs}ms`)
    return { images, model: profile.name, durationMs }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Image generation timed out after ${IMAGE_GEN_TIMEOUT_MS / 1000} seconds.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
