import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// 产品形态：只内置模型，用户不能换。scopes.models = ['host']
const { root } = isolate('models-host-only')

// 磁盘上有一份用户自己改过的 model.conf：地址指向自己的转发服务。这个文件应该既不被读也不被写
const userConf = JSON.stringify({
  modelProfiles: [{ name: 'acme-pro[acme]', provider: 'acme', modelName: 'acme-pro', baseURL: 'https://evil.example.com/v1', apiKey: 'user-key', maxTokens: 1, contextLength: 1, adapt: 'openai' }],
  modelPointers: { main: 'acme-pro[acme]', quick: 'acme-pro[acme]' },
}, null, 2)
writeFile(join(root, 'model.conf'), userConf)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
const host = (modelName: string, maxTokens: number) => ({ provider: 'acme', modelName, baseURL: 'https://llm.acme.com/v1', apiKey: 'host-key', maxTokens, contextLength: 128000, adapt: 'openai' as const })
setHostConfig({
  models: { profiles: [host('acme-pro', 8192), host('acme-lite', 4096)], main: 'acme-pro[acme]', quick: 'acme-lite[acme]' },
  scopes: { models: ['host'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getModelManager } = require('../../src/manager/ModelManager') as typeof import('../../src/manager/ModelManager')
const mm = getModelManager()

test('模型列表与指针全部来自宿主，model.conf 里的用户模型不生效', async () => {
  const data = await mm.getModelData()
  assert.deepEqual(data.modelList, ['acme-pro[acme]', 'acme-lite[acme]'])
  assert.deepEqual(data.hostModels, ['acme-pro[acme]', 'acme-lite[acme]'])
  assert.equal(data.taskConfig.main, 'acme-pro[acme]')
  assert.equal(data.taskConfig.quick, 'acme-lite[acme]')

  // 请求真正用的是宿主的地址和 key，不是用户文件里的
  const main = mm.getModel('main')
  assert.equal(main?.baseURL, 'https://llm.acme.com/v1')
  assert.equal(main?.apiKey, 'host-key')
})

test('查询接口不回传宿主模型的 apiKey', () => {
  const profile = mm.getModelProfile('acme', 'acme-pro')
  assert.equal(profile?.apiKey, '')
  assert.equal(profile?.baseURL, 'https://llm.acme.com/v1')
})

test('增删被拒：加模型报 SCOPE_DISABLED，删宿主模型报 HOST_READONLY', async () => {
  await rejectsWithCode(mm.addNewModel(host('mine', 1), true), 'SCOPE_DISABLED')
  await rejectsWithCode(mm.addImageModel({ provider: 'p', modelName: 'img', baseURL: 'u', apiKey: 'k' }), 'SCOPE_DISABLED')
  await rejectsWithCode(mm.deleteModel('acme-pro[acme]'), 'HOST_READONLY')
})

test('切换模型只改内存：用户的 model.conf 一个字节都不动', async () => {
  const data = await mm.switchCurrentModel('acme-lite[acme]')
  assert.equal(data.taskConfig.main, 'acme-lite[acme]')
  assert.equal(mm.getModel('main')?.modelName, 'acme-lite')
  assert.equal(readFileSync(join(root, 'model.conf'), 'utf8'), userConf)
})
