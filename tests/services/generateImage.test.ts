import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// SEMA_ROOT 在首次 getSemaRootDir() 时缓存，必须在加载被测模块前设好；import 会被提升，故用 require 延后加载
const root = mkdtempSync(join(tmpdir(), 'sema-root-'))
process.env.SEMA_ROOT = root

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateImage, buildImageApiUrl, sniffImageType, extractErrorMessage } = require('../../src/services/image/generateImage') as typeof import('../../src/services/image/generateImage')

// 1x1 PNG 与最小 JPEG 文件头
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void
const requests: Array<{ url: string; auth: string; body: any }> = []
let handler: Handler = () => {}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    requests.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body })
    handler(req, body, res)
  })
})
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(typeof data === 'string' ? data : JSON.stringify(data))
}

let base = ''
test.before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.after(() => { server.close() })

const profileOf = (baseURL: string) => ({ name: 'm[p]', provider: 'p', modelName: 'm', baseURL, apiKey: 'secret' })

test('请求地址：以 /images 或 /images/generations 结尾原样使用，否则追加', () => {
  assert.equal(buildImageApiUrl('https://a.com/api/v3'), 'https://a.com/api/v3/images/generations')
  assert.equal(buildImageApiUrl('https://a.com/api/v3/'), 'https://a.com/api/v3/images/generations')
  assert.equal(buildImageApiUrl('https://a.com/v1/images/generations'), 'https://a.com/v1/images/generations')
  assert.equal(buildImageApiUrl('https://a.com/api/v1/images'), 'https://a.com/api/v1/images')
})

test('按文件头识别图片格式', () => {
  assert.deepEqual(sniffImageType(PNG), { mediaType: 'image/png', ext: '.png' })
  assert.deepEqual(sniffImageType(JPEG), { mediaType: 'image/jpeg', ext: '.jpg' })
  assert.equal(sniffImageType(Buffer.from('hello')), null)
})

test('错误体解析兼容三种形状与纯文本', () => {
  assert.equal(extractErrorMessage('{"error":{"code":"InvalidParameter","message":"bad"}}'), 'InvalidParameter: bad')
  assert.equal(extractErrorMessage('{"code":"InvalidApiKey","message":"Invalid API-key provided."}'), 'InvalidApiKey: Invalid API-key provided.')
  assert.equal(extractErrorMessage('{"success":false,"error":{"name":"ZodError","message":"x"}}'), 'ZodError: x')
  assert.equal(extractErrorMessage('"Invalid token"'), '"Invalid token"')
})

test('b64_json 返回：只发 model/prompt/watermark，落到附件目录', async () => {
  requests.length = 0
  handler = (_req, _body, res) => json(res, 200, { data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }] })

  const result = await generateImage({ profile: profileOf(`${base}/b64/v1`), prompt: 'a cat' })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/b64/v1/images/generations')
  assert.equal(requests[0].auth, 'Bearer secret')
  assert.deepEqual(requests[0].body, { model: 'm', prompt: 'a cat', watermark: false })

  assert.equal(result.images.length, 1)
  const image = result.images[0]
  assert.equal(image.mediaType, 'image/png')
  assert.ok(image.filePath.startsWith(join(root, 'attachments') + sep))
  assert.ok(image.filePath.endsWith(`${sep}image.png`))
  assert.deepEqual(readFileSync(image.filePath), PNG)
})

test('url 返回：立即下载；扩展名按实际格式替换；已存在的文件不覆盖', async () => {
  handler = (req, _body, res) => {
    if (req.url === '/file.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(JPEG)
      return
    }
    json(res, 200, { data: [{ url: `${base}/file.bin` }] })
  }
  const dir = mkdtempSync(join(tmpdir(), 'sema-out-'))
  writeFileSync(join(dir, 'hero.jpg'), 'existing')
  const written: string[] = []

  const result = await generateImage({
    profile: profileOf(`${base}/url/v1`),
    prompt: 'a banner',
    outputPath: join(dir, 'hero.png'),
    beforeWrite: p => written.push(p),
  })

  assert.equal(result.images[0].filePath, join(dir, 'hero-1.jpg'))
  assert.equal(result.images[0].mediaType, 'image/jpeg')
  assert.deepEqual(written, [join(dir, 'hero-1.jpg')])
  assert.equal(readFileSync(join(dir, 'hero.jpg'), 'utf8'), 'existing')
})

test('端点不认 watermark：去掉后重发一次，之后的请求不再带', async () => {
  requests.length = 0
  handler = (_req, body, res) => {
    if (body && 'watermark' in body) {
      json(res, 400, { error: { code: 400, message: "Unrecognized key(s) in object: 'watermark'" } })
      return
    }
    json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] })
  }
  const profile = profileOf(`${base}/strict/v1/images`)

  await generateImage({ profile, prompt: 'one' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/strict/v1/images')
  assert.deepEqual(requests[1].body, { model: 'm', prompt: 'one' })

  await generateImage({ profile, prompt: 'two' })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[2].body, { model: 'm', prompt: 'two' })
})

test('transparent：下发 background 与 output_format；不传时不带', async () => {
  requests.length = 0
  handler = (_req, _body, res) => json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] })
  const profile = profileOf(`${base}/alpha/v1`)

  await generateImage({ profile, prompt: 'coin icon', transparent: true })
  assert.deepEqual(requests[0].body, { model: 'm', prompt: 'coin icon', watermark: false, background: 'transparent', output_format: 'png' })

  await generateImage({ profile, prompt: 'a scene' })
  assert.deepEqual(requests[1].body, { model: 'm', prompt: 'a scene', watermark: false })
})

test('端点不认 background：只去掉被点名的字段重发，watermark 照常带', async () => {
  requests.length = 0
  handler = (_req, body, res) => {
    if (body && 'background' in body) {
      json(res, 400, { error: { message: "Unknown parameter: 'background'" } })
      return
    }
    json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] })
  }
  const profile = profileOf(`${base}/nobg/v1`)

  await generateImage({ profile, prompt: 'one', transparent: true })
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].body, { model: 'm', prompt: 'one', watermark: false, output_format: 'png' })

  await generateImage({ profile, prompt: 'two', transparent: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[2].body, { model: 'm', prompt: 'two', watermark: false, output_format: 'png' })
})

test('服务商报错：原文带给调用方，不重试', async () => {
  requests.length = 0
  handler = (_req, _body, res) => json(res, 400, { error: { code: 'InputTextSensitiveContentDetected', message: 'blocked' } })

  await assert.rejects(
    () => generateImage({ profile: profileOf(`${base}/err/v1`), prompt: 'x' }),
    /HTTP 400.*InputTextSensitiveContentDetected: blocked/,
  )
  assert.equal(requests.length, 1)
})

test('HTTP 200 但没有图：按失败处理', async () => {
  handler = (_req, _body, res) => json(res, 200, { data: [], message: 'nothing generated' })
  await assert.rejects(
    () => generateImage({ profile: profileOf(`${base}/empty/v1`), prompt: 'x' }),
    /returned no image.*nothing generated/,
  )
})

test('beforeWrite 抛错则不写盘', async () => {
  handler = (_req, _body, res) => json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] })
  const dir = mkdtempSync(join(tmpdir(), 'sema-out-'))
  await assert.rejects(() => generateImage({
    profile: profileOf(`${base}/guard/v1`),
    prompt: 'x',
    outputPath: join(dir, 'a.png'),
    beforeWrite: () => { throw new Error('checkpoint failed') },
  }), /checkpoint failed/)
  assert.equal(existsSync(join(dir, 'a.png')), false)
})

test('调用方中断：请求被取消', async () => {
  handler = () => { /* 不响应，等待中断 */ }
  const controller = new AbortController()
  const pending = generateImage({ profile: profileOf(`${base}/hang/v1`), prompt: 'x', signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(() => pending)
})
