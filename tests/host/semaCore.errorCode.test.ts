import test from 'node:test'
import assert from 'node:assert/strict'
import { isolate, KEY, throwsWithCode } from '../helpers/isolate'

// 宿主配置不合法：构造当场抛带稳定错误码的 SemaError，不留下实例；
// 异步初始化失败（workingDir 无效）：createSession 返回失败结果，重试仍失败
const { project } = isolate('core-errcode')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SemaCore } = require('../../src/core/SemaCore') as typeof import('../../src/core/SemaCore')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ERROR_CODES, SemaError, errorCodeOf } = require('../../src/util/errors') as typeof import('../../src/util/errors')

test('密钥不合法：构造同步抛 CONFIG_INVALID', () => {
  throwsWithCode(() => new SemaCore({ workingDir: project, logLevel: 'none', encryption: { key: 'not-32-bytes' } }), ERROR_CODES.CONFIG_INVALID)
  assert.throws(() => new SemaCore({ workingDir: project, logLevel: 'none', encryption: { key: 'not-32-bytes' } }), /encryption\.key/)
})

test('宿主模型重复、scopes 写错：同样在构造时抛，文案点出是哪一项', () => {
  const m = { provider: 'acme', modelName: 'pro', baseURL: 'u', apiKey: 'k', maxTokens: 1, contextLength: 1, adapt: 'openai' as const }
  assert.throws(
    () => new SemaCore({ workingDir: project, logLevel: 'none', encryption: { key: KEY }, models: { profiles: [m, m] } }),
    (err: any) => err.code === 'CONFIG_INVALID' && err.message.includes('models.profiles'),
  )
  throwsWithCode(() => new SemaCore({ workingDir: project, logLevel: 'none', scopes: { skills: ['hots'] } as any }), 'CONFIG_INVALID')
})

test('workingDir 无效：构造不抛，createSession 返回失败，重试仍然失败', async () => {
  const core = new SemaCore({ workingDir: '/nonexistent/sema-errcode', logLevel: 'none' })
  for (let i = 0; i < 2; i++) {
    const result = await core.createSession()
    assert.equal(result.ok, false, `第 ${i + 1} 次建会话`)
    if (!result.ok) {
      assert.ok(result.error.includes('workingDir'))
      assert.equal(result.code, undefined)
    }
  }
})

test('错误码工具：SemaError 带 code，普通 Error 没有', () => {
  assert.equal(errorCodeOf(new SemaError('HOST_READONLY', 'x')), 'HOST_READONLY')
  assert.equal(errorCodeOf(new Error('x')), undefined)
  assert.equal(new SemaError('SCOPE_DISABLED', 'm').name, 'SemaError')
})
