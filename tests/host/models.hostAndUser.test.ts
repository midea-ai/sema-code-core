import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// 产品形态：内置模型，允许用户补充自己的。scopes.models = ['host', 'user']
const { root } = isolate('models-host-user')

// 用户的 model.conf：一条和宿主同名的 gpt-4o[openai]（自己的 key），一条自己的 my-model；主模型选的是 my-model，快速模型没选
const userGpt = { name: 'gpt-4o[openai]', provider: 'openai', modelName: 'gpt-4o', baseURL: 'https://api.openai.com/v1', apiKey: 'user-key', maxTokens: 1, contextLength: 1, adapt: 'openai' }
const userMine = { name: 'my-model[custom]', provider: 'custom', modelName: 'my-model', baseURL: 'https://me.example.com/v1', apiKey: 'mine-key', maxTokens: 1, contextLength: 1, adapt: 'openai' }
writeFile(join(root, 'model.conf'), JSON.stringify({
  modelProfiles: [userGpt, userMine],
  modelPointers: { main: 'my-model[custom]', quick: '' },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
const hostGpt = { provider: 'openai', modelName: 'gpt-4o', baseURL: 'https://llm.acme.com/v1', apiKey: 'host-key', maxTokens: 8192, contextLength: 128000, adapt: 'openai' as const }
const hostLite = { provider: 'acme', modelName: 'acme-lite', baseURL: 'https://llm.acme.com/v1', apiKey: 'host-key', maxTokens: 4096, contextLength: 64000, adapt: 'openai' as const }
setHostConfig({
  models: { profiles: [hostGpt, hostLite], main: 'gpt-4o[openai]', quick: 'acme-lite[acme]' },
  scopes: { models: ['host', 'user'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getModelManager } = require('../../src/manager/ModelManager') as typeof import('../../src/manager/ModelManager')
const mm = getModelManager()
const readConf = () => JSON.parse(readFileSync(join(root, 'model.conf'), 'utf8'))

test('指针：用户选过的沿用，没选的用宿主的', async () => {
  const data = await mm.getModelData()
  assert.equal(data.taskConfig.main, 'my-model[custom]', '用户选的 my-model 仍在，不被宿主的 main 覆盖')
  assert.equal(data.taskConfig.quick, 'acme-lite[acme]', '用户没选 quick，用宿主的')
})

test('同名 gpt-4o[openai]：生效的是宿主那条，用户那条不生效', async () => {
  const data = await mm.getModelData()
  assert.deepEqual(data.modelList, ['gpt-4o[openai]', 'acme-lite[acme]', 'my-model[custom]'])
  assert.deepEqual(data.hostModels, ['gpt-4o[openai]', 'acme-lite[acme]'])

  await mm.switchCurrentModel('gpt-4o[openai]')
  const main = mm.getModel('main')
  assert.equal(main?.baseURL, 'https://llm.acme.com/v1', '请求发到宿主网关')
  assert.equal(main?.apiKey, 'host-key')
  assert.equal(mm.getModelProfile('openai', 'gpt-4o')?.apiKey, '', '查询接口不回传宿主 key')
})

test('用户文件里的同名条目原样保留：落盘不删它，也不写宿主的模型和 key', async () => {
  // 上一步 switchCurrentModel 已经触发过一次落盘
  const conf = readConf()
  const names = conf.modelProfiles.map((p: { name: string }) => p.name)
  assert.ok(names.includes('gpt-4o[openai]'), '用户的 gpt-4o 还在文件里')
  assert.ok(names.includes('my-model[custom]'))
  assert.equal(names.includes('acme-lite[acme]'), false, '宿主模型不落盘')
  const text = readFileSync(join(root, 'model.conf'), 'utf8')
  assert.equal(text.includes('host-key'), false)
  assert.ok(text.includes('user-key'), '用户自己的 key 原样保留')
  assert.equal(conf.modelPointers.main, 'gpt-4o[openai]', '指针照常落盘')
})

test('增删：与宿主同名报 HOST_READONLY，其他用户模型照常增删', async () => {
  await rejectsWithCode(mm.addNewModel({ ...hostGpt, apiKey: 'try' }, true), 'HOST_READONLY')
  await rejectsWithCode(mm.deleteModel('acme-lite[acme]'), 'HOST_READONLY')

  const added = await mm.addNewModel({ provider: 'custom', modelName: 'other', baseURL: 'u', apiKey: 'o', maxTokens: 1, contextLength: 1, adapt: 'openai' }, true)
  assert.ok(added.modelList.includes('other[custom]'))
  assert.ok(readConf().modelProfiles.some((p: { name: string }) => p.name === 'other[custom]'))

  await mm.deleteModel('other[custom]')
  assert.equal(readConf().modelProfiles.some((p: { name: string }) => p.name === 'other[custom]'), false)
  // 删来删去，用户的同名 gpt-4o 一直在
  assert.ok(readConf().modelProfiles.some((p: { name: string }) => p.name === 'gpt-4o[openai]'))
})
