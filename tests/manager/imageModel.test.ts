import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SEMA_ROOT 在首次 getSemaRootDir() 时缓存，必须在加载被测模块前设好；import 会被提升，故用 require 延后加载
const root = mkdtempSync(join(tmpdir(), 'sema-root-'))
process.env.SEMA_ROOT = root

const chatProfile = {
  name: 'chat-model[custom]',
  provider: 'custom',
  modelName: 'chat-model',
  baseURL: 'https://example.com/v1',
  apiKey: 'k',
  maxTokens: 1000,
  contextLength: 1000,
  adapt: 'openai',
}
// 磁盘上先放一份不含文生图字段的旧配置
writeFileSync(join(root, 'model.conf'), JSON.stringify({
  modelProfiles: [chatProfile],
  modelPointers: { main: chatProfile.name, quick: chatProfile.name },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getModelManager } = require('../../src/manager/ModelManager') as typeof import('../../src/manager/ModelManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAvailableBuiltinTools, getAllBuiltinToolNames, getAllBuiltinToolInfos } = require('../../src/tools/base/tools') as typeof import('../../src/tools/base/tools')

const TOOL = 'generate_image'
const ark = { provider: 'ark', modelName: 'seedream', baseURL: 'https://ark.example.com/api/v3', apiKey: 'a' }
const qwen = { provider: 'qwen', modelName: 'qwen-image', baseURL: 'https://qwen.example.com/v1', apiKey: 'b' }
const readConf = () => JSON.parse(readFileSync(join(root, 'model.conf'), 'utf8'))
const hasTool = () => getAvailableBuiltinTools(null).some(t => t.name === TOOL)

test('旧配置没有文生图字段：列表为空、指针为空、工具不可用', async () => {
  const data = await getModelManager().getModelData()
  assert.deepEqual(data.imageModelList, [])
  assert.equal(data.taskConfig.image, '')
  assert.equal(getModelManager().getImageModel(), null)
  assert.equal(hasTool(), false)
  assert.equal(getAllBuiltinToolInfos(null).some(t => t.name === TOOL), false)
  // 全量工具名不看可用性，保证黑名单转白名单时不漏
  assert.equal(getAllBuiltinToolNames().includes(TOOL), true)
})

test('添加第一个文生图模型：指针指向它，工具可用，对话模型不受影响', async () => {
  const data = await getModelManager().addImageModel(ark)
  assert.deepEqual(data.imageModelList, ['seedream[ark]'])
  assert.equal(data.taskConfig.image, 'seedream[ark]')
  assert.deepEqual(data.modelList, [chatProfile.name])
  assert.equal(data.taskConfig.main, chatProfile.name)
  assert.equal(hasTool(), true)

  const conf = readConf()
  assert.equal(conf.modelPointers.image, 'seedream[ark]')
  assert.equal(conf.imageModelProfiles.length, 1)
  assert.equal(conf.modelProfiles.length, 1)
})

test('添加第二个不改指针；同名添加为覆盖', async () => {
  let data = await getModelManager().addImageModel(qwen)
  assert.deepEqual(data.imageModelList, ['seedream[ark]', 'qwen-image[qwen]'])
  assert.equal(data.taskConfig.image, 'seedream[ark]')

  data = await getModelManager().addImageModel({ ...qwen, apiKey: 'b2' })
  assert.equal(data.imageModelList?.length, 2)
  assert.equal(getModelManager().getImageModelProfile('qwen', 'qwen-image')?.apiKey, 'b2')
})

test('切换指针：不存在的模型抛错，空串停用并移除工具', async () => {
  await assert.rejects(() => getModelManager().switchImageModel('nope[ark]'))

  let data = await getModelManager().switchImageModel('qwen-image[qwen]')
  assert.equal(data.taskConfig.image, 'qwen-image[qwen]')
  assert.equal(getModelManager().getImageModel()?.provider, 'qwen')

  data = await getModelManager().switchImageModel('')
  assert.equal(data.taskConfig.image, '')
  assert.equal(hasTool(), false)

  await getModelManager().switchImageModel('qwen-image[qwen]')
  assert.equal(hasTool(), true)
})

test('删除指针所指的模型：指针移到剩余第一个，删光后置空', async () => {
  let data = await getModelManager().deleteImageModel('qwen-image[qwen]')
  assert.deepEqual(data.imageModelList, ['seedream[ark]'])
  assert.equal(data.taskConfig.image, 'seedream[ark]')

  data = await getModelManager().deleteImageModel('seedream[ark]')
  assert.deepEqual(data.imageModelList, [])
  assert.equal(data.taskConfig.image, '')
  assert.equal(hasTool(), false)

  await assert.rejects(() => getModelManager().deleteImageModel('seedream[ark]'))
})

test('对话模型与文生图模型同名时，删除对话模型不受 image 指针影响', async () => {
  const mm = getModelManager()
  await mm.addNewModel({ ...chatProfile, modelName: 'dual', adapt: 'openai' } as any, true)
  await mm.addImageModel({ provider: 'custom', modelName: 'dual', baseURL: 'https://example.com/v1', apiKey: 'k' })
  assert.equal((await mm.getModelData()).taskConfig.image, 'dual[custom]')

  const data = await mm.deleteModel('dual[custom]')
  assert.equal(data.modelList.includes('dual[custom]'), false)
  assert.equal(data.taskConfig.image, 'dual[custom]')
})
