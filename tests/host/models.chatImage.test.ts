import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// 对话模型与文生图模型是两张表，名字规则相同（modelName[provider]）：
// 宿主的对话模型 omni[acme] 不该盖掉用户的文生图模型 omni[acme]，反过来也一样
const { root } = isolate('models-chat-image')

const userChat = (modelName: string, provider: string) => ({ name: `${modelName}[${provider}]`, provider, modelName, baseURL: 'https://me.example.com/v1', apiKey: 'user-chat-key', maxTokens: 1, contextLength: 1, adapt: 'openai' })
writeFile(join(root, 'model.conf'), JSON.stringify({
  modelProfiles: [userChat('pic', 'acme'), userChat('mine', 'me')],
  // image 为 ''：用户明确停用了文生图
  modelPointers: { main: 'mine[me]', quick: 'mine[me]', image: '' },
  imageModelProfiles: [{ name: 'omni[acme]', provider: 'acme', modelName: 'omni', baseURL: 'https://me.example.com/img', apiKey: 'user-img-key' }],
}, null, 2))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
setHostConfig({
  models: {
    profiles: [{ provider: 'acme', modelName: 'omni', baseURL: 'https://llm.acme.com/v1', apiKey: 'host-key', maxTokens: 8192, contextLength: 128000, adapt: 'openai' }],
    imageProfiles: [{ provider: 'acme', modelName: 'pic', baseURL: 'https://llm.acme.com/img', apiKey: 'host-img-key' }],
  },
  scopes: { models: ['host', 'user'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getModelManager } = require('../../src/manager/ModelManager') as typeof import('../../src/manager/ModelManager')
const mm = getModelManager()

test('用户明确停用的文生图（image 指针为空串）重启后不被宿主默认值顶掉', async () => {
  const data = await mm.getModelData()
  assert.equal(data.taskConfig.image, '')
})

test('两张表各管各的：同名的另一类用户模型照常生效，apiKey 照常回传', async () => {
  const data = await mm.getModelData()
  assert.deepEqual(data.modelList, ['omni[acme]', 'pic[acme]', 'mine[me]'])
  assert.deepEqual(data.imageModelList, ['pic[acme]', 'omni[acme]'])

  assert.equal(mm.getModelProfile('acme', 'omni')?.apiKey, '', '宿主对话模型不回传 key')
  assert.equal(mm.getImageModelProfile('acme', 'pic')?.apiKey, '', '宿主文生图模型不回传 key')
  assert.equal(mm.getModelProfile('acme', 'pic')?.apiKey, 'user-chat-key', '用户对话模型与宿主文生图模型同名，不受影响')
  assert.equal(mm.getImageModelProfile('acme', 'omni')?.apiKey, 'user-img-key', '用户文生图模型与宿主对话模型同名，不受影响')
})

test('增删：只拦同一类里的宿主条目，另一类的同名用户模型可以改、删、再加回来', async () => {
  const img = { provider: 'acme', modelName: 'omni', baseURL: 'https://me.example.com/img2', apiKey: 'user-img-key-2' }
  await mm.addImageModel(img)
  await mm.deleteImageModel('omni[acme]')
  await mm.addImageModel(img)
  assert.equal(mm.getImageModelProfile('acme', 'omni')?.apiKey, 'user-img-key-2')

  const chat = { provider: 'acme', modelName: 'pic', baseURL: 'https://me.example.com/v2', apiKey: 'user-chat-key-2', maxTokens: 1, contextLength: 1, adapt: 'openai' as const }
  await mm.addNewModel(chat, true)
  await mm.deleteModel('pic[acme]')
  await mm.addNewModel(chat, true)
  assert.equal(mm.getModelProfile('acme', 'pic')?.apiKey, 'user-chat-key-2')

  await rejectsWithCode(mm.deleteModel('omni[acme]'), 'HOST_READONLY')
  await rejectsWithCode(mm.deleteImageModel('pic[acme]'), 'HOST_READONLY')
  await rejectsWithCode(mm.addNewModel({ ...chat, modelName: 'omni' }, true), 'HOST_READONLY')
  await rejectsWithCode(mm.addImageModel({ ...img, modelName: 'pic' }), 'HOST_READONLY')

  const saved = readFileSync(join(root, 'model.conf'), 'utf8')
  assert.equal(saved.includes('host-key'), false)
  assert.equal(saved.includes('host-img-key'), false)
  assert.ok(saved.includes('user-img-key-2') && saved.includes('user-chat-key-2'))
})
