import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, KEY } from '../helpers/isolate'

// 模型调用日志与事件日志的开关：LLM 日志缺省不写，事件日志缺省跟随是否加密，都可显式指定、运行期改
const { project } = isolate('logs-switch')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logEvent, logLLMRequest } = require('../../src/util/logLLM') as typeof import('../../src/util/logLLM')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { flushLinesSync } = require('../../src/util/lineWriter') as typeof import('../../src/util/lineWriter')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getEventDir, getLLMLogsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')

const cm = getConfManager()

const countLines = (dir: string): number => {
  if (!existsSync(dir)) return 0
  return readdirSync(dir)
    .filter(file => file.endsWith('.log'))
    .reduce((n, file) => n + readFileSync(join(dir, file), 'utf8').trim().split('\n').filter(Boolean).length, 0)
}
const eventLines = () => countLines(getEventDir())
const llmLines = () => countLines(getLLMLogsDir())

test('没传密钥：LLM 日志缺省不写，事件日志照常写', async () => {
  await cm.setCoreConfig({ workingDir: project })
  assert.equal(cm.getCoreConfig()?.disableLLMLog, true)
  assert.equal(cm.getCoreConfig()?.disableEventLog, false)

  logEvent('input:received', { content: 'hi' }, 's1')
  logLLMRequest({ model: 'm', messages: [] }, 's1')
  flushLinesSync()
  assert.equal(eventLines(), 1)
  assert.equal(llmLines(), 0)
  assert.equal(existsSync(getLLMLogsDir()), false, 'LLM 日志缺省连目录都不建')
})

test('传了密钥：两个开关缺省都关，目录也不新建', async () => {
  const before = eventLines()
  await cm.setCoreConfig({ workingDir: project, encryption: { key: KEY } })
  assert.equal(cm.getCoreConfig()?.disableLLMLog, true)
  assert.equal(cm.getCoreConfig()?.disableEventLog, true)
  assert.equal((cm.getCoreConfig() as Record<string, unknown>).encryption, undefined, '密钥不进 coreConfig')

  logEvent('input:received', { content: 'secret' }, 's1')
  logLLMRequest({ model: 'm', messages: [{ role: 'user', content: 'secret' }] }, 's1')
  flushLinesSync()
  assert.equal(eventLines(), before)
  assert.equal(llmLines(), 0)
})

test('传了密钥但显式打开，或运行期改开关：下一条立即生效', async () => {
  await cm.setCoreConfig({ workingDir: project, encryption: { key: KEY }, disableEventLog: false })
  assert.equal(cm.getCoreConfig()?.disableEventLog, false)
  assert.equal(cm.getCoreConfig()?.disableLLMLog, true, '没显式写的那个仍按缺省')

  const before = eventLines()
  logEvent('x', {}, 's1')
  flushLinesSync()
  assert.equal(eventLines(), before + 1)

  cm.updateCoreConfig({ disableEventLog: true })
  logEvent('x', {}, 's1')
  flushLinesSync()
  assert.equal(eventLines(), before + 1)

  cm.updateCoreConfig({ disableEventLog: false })
  logEvent('x', {}, 's1')
  flushLinesSync()
  assert.equal(eventLines(), before + 2)
})

test('LLM 日志显式传 false 才写，运行期也能关掉', async () => {
  await cm.setCoreConfig({ workingDir: project, disableLLMLog: false })
  logLLMRequest({ model: 'm', messages: [] }, 's1')
  flushLinesSync()
  assert.equal(llmLines(), 1)

  cm.updateCoreConfig({ disableLLMLog: true })
  logLLMRequest({ model: 'm', messages: [] }, 's1')
  flushLinesSync()
  assert.equal(llmLines(), 1)
})
