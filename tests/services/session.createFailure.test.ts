import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'
import type { Message } from '../../src/types/message'

// 单进程内管理器是单例：本文件只验证创建失败路径，model.conf 须在首次 getModelManager() 前写好
const { project, root } = isolate('session-create-failure')
writeFile(join(root, 'model.conf'), JSON.stringify({
  modelProfiles: [{ name: 'known[openai]', provider: 'openai', modelName: 'known', baseURL: 'https://api.example.com/v1', apiKey: 'key', maxTokens: 1, contextLength: 1, adapt: 'openai' }],
  modelPointers: { main: 'known[openai]', quick: '' },
}))

const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
const { SemaSession } = require('../../src/core/SemaSession') as typeof import('../../src/core/SemaSession')
const { loadHistory, saveHistory, resolveHistoryFile } = require('../../src/util/history') as typeof import('../../src/util/history')

const message = (uuid: string): Message => ({ type: 'user', uuid: uuid as any, checkpointSeq: 0, message: { role: 'user', content: uuid } })

test('unknown mainModel on create keeps the existing history instead of overwriting it with empty state', async () => {
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none' })
  saveHistory('existing', [message('first'), message('second')], [], project)

  await assert.rejects(SemaSession.create({ sessionId: 'existing', mainModel: 'missing[openai]' }), /missing\[openai\]/)

  assert.deepEqual((await loadHistory('existing', project)).messages.map(m => m.uuid), ['first', 'second'])
})

test('failed creation does not leave an empty history file behind', async () => {
  await assert.rejects(SemaSession.create({ sessionId: 'brand-new', mainModel: 'missing[openai]' }), /missing\[openai\]/)

  assert.equal(resolveHistoryFile('brand-new', project).exists, false)
})
