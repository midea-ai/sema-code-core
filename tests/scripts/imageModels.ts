/**
 * 文生图模型实测脚本：切换 image 指针到指定模型，用同一提示词出一张图，落到 tests/data/<key>.<实际格式>。
 *
 * 用法（仓库根目录）：
 *   npx tsx tests/scripts/imageModels.ts muse-image            # 测单个
 *   npx tsx tests/scripts/imageModels.ts muse-image seedream-pro # 测多个
 *   npx tsx tests/scripts/imageModels.ts all                   # 全部串行
 *   PROMPT="a red apple" npx tsx tests/scripts/imageModels.ts muse-image   # 自定义提示词
 *   CASE=ramen PROMPT="..." npx tsx tests/scripts/imageModels.ts all       # 文件名加前缀 ramen-<key>，多组用例互不覆盖
 *
 * 注意：走真实计费接口；模型须已在 ~/.sema/model.conf 的 imageModelProfiles 里配置。
 * 脚本会真实改写 model.conf 的 image 指针，跑完停在最后一个测试的模型上。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getModelManager } from '../../src/manager/ModelManager'
import { generateImage } from '../../src/services/image/generateImage'

// key：输出文件名；name：model.conf 里的 profile 名（modelName[provider]）
const MODELS: Array<{ key: string; name: string }> = [
  { key: 'muse-image', name: 'meta/muse-image[openrouter]' },
  { key: 'gpt-image-sunburst', name: 'openai/gpt-image-2.5-sunburst[openrouter]' },
  { key: 'gpt-image-flare', name: 'openai/gpt-image-2.5-flare[openrouter]' },
  { key: 'gemini-flash-image', name: 'google/gemini-3.1-flash-image[openrouter]' },
  { key: 'gemini-flash-lite-image', name: 'google/gemini-3.1-flash-lite-image[openrouter]' },
  { key: 'gemini-pro-image', name: 'google/gemini-3-pro-image[openrouter]' },
  { key: 'seedream-pro', name: 'bytedance-seed/seedream-5-0-pro[openrouter]' },
  { key: 'seedream-lite', name: 'bytedance-seed/seedream-5-0-lite[openrouter]' },
  { key: 'qwen-image-pro', name: 'qwen/qwen-image-3-pro[openrouter]' },
  { key: 'qwen-image', name: 'qwen/qwen-image-3[openrouter]' },
  { key: 'grok-imagine', name: 'x-ai/grok-imagine-image-2.0[openrouter]' },
  { key: 'ark-seedream-flash', name: 'doubao-seedream-5-0-flash-260915[volcengine]' },
  { key: 'ark-seedream', name: 'doubao-seedream-5-0-260128[volcengine]' },
  { key: 'ark-seedream-pro', name: 'doubao-seedream-5-0-pro-260628[volcengine]' },
]

const DEFAULT_PROMPT =
  'A cozy modern kitchen at golden hour, a smart refrigerator with a glass door, warm wood cabinets, ' +
  'a bowl of fresh fruit on the counter, photorealistic, soft natural light'

const OUT_DIR = path.resolve(__dirname, '../data')
// 用例前缀：文件名为 <CASE>-<key>，不传则为 <key>
const CASE_PREFIX = process.env.CASE ? `${process.env.CASE}-` : ''

// 同名旧图先删掉，否则 generateImage 会加 -1 序号而不是覆盖
function removeOld(baseName: string): void {
  if (!fs.existsSync(OUT_DIR)) return
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (path.parse(file).name === baseName) fs.unlinkSync(path.join(OUT_DIR, file))
  }
}

async function runOne(model: { key: string; name: string }, prompt: string): Promise<void> {
  const manager = getModelManager()
  console.log(`\n=== ${model.key} (${model.name}) ===`)
  await manager.switchImageModel(model.name)
  const profile = manager.getImageModel()
  if (!profile) throw new Error(`switch failed: ${model.name}`)
  console.log(`image pointer -> ${profile.name}`)

  const baseName = `${CASE_PREFIX}${model.key}`
  removeOld(baseName)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const result = await generateImage({
    profile,
    prompt,
    outputPath: path.join(OUT_DIR, `${baseName}.png`),  // 扩展名以实际格式为准
  })
  for (const image of result.images) {
    console.log(`saved: ${image.filePath} (${image.mediaType}, ${(image.bytes / 1024).toFixed(1)} KB)`)
  }
  console.log(`duration: ${(result.durationMs / 1000).toFixed(1)}s`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('usage: npx tsx tests/scripts/imageModels.ts <key...|all>\navailable keys:')
    MODELS.forEach(m => console.log(`  ${m.key.padEnd(24)} ${m.name}`))
    process.exit(1)
  }
  const selected = args.includes('all')
    ? MODELS
    : args.map(key => {
        const model = MODELS.find(m => m.key === key)
        if (!model) throw new Error(`unknown key: ${key}`)
        return model
      })
  const prompt = process.env.PROMPT || DEFAULT_PROMPT
  console.log(`prompt: ${prompt}`)

  const failed: string[] = []
  for (const model of selected) {
    try {
      await runOne(model, prompt)
    } catch (error) {
      failed.push(model.key)
      console.error(`FAILED ${model.key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\ndone: ${selected.length - failed.length}/${selected.length} ok${failed.length ? `, failed: ${failed.join(', ')}` : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
