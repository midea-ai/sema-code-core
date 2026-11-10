import test from 'node:test'
import assert from 'node:assert/strict'
import { isolate, KEY, throwsWithCode } from '../helpers/isolate'

// 构造参数校验：只碰 hostConfig 本身，不起任何管理器
isolate('host-validate')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig, getHostConfig, isScopeEnabled, getEncryptionKey, maskForLog } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')

const model = (modelName: string, provider = 'acme') => ({ provider, modelName, baseURL: 'https://llm.acme.com/v1', apiKey: 'tok', maxTokens: 8192, contextLength: 128000, adapt: 'openai' as const })

test('什么都不传：全部域生效、不加密', () => {
  setHostConfig({})
  assert.equal(isScopeEnabled('models', 'user'), true)
  assert.equal(isScopeEnabled('skills', 'builtin'), true)
  assert.equal(isScopeEnabled('plugins', 'local'), true)
  assert.equal(getEncryptionKey(), null)
})

test('方案示例：两个同 provider 的模型能通过校验（按 modelName[provider] 去重）', () => {
  setHostConfig({ models: { profiles: [model('acme-pro'), model('acme-lite')], main: 'acme-pro[acme]' } })
  assert.equal(getHostConfig().models?.profiles.length, 2)
})

test('模型重复：同 provider 同 modelName 报 CONFIG_INVALID，换 provider 不算重复', () => {
  throwsWithCode(() => setHostConfig({ models: { profiles: [model('gpt-4o', 'openai'), model('gpt-4o', 'openai')] } }), 'CONFIG_INVALID')
  setHostConfig({ models: { profiles: [model('gpt-4o', 'openai'), model('gpt-4o', 'azure')] } })
  throwsWithCode(() => setHostConfig({ models: { profiles: [], imageProfiles: [{ provider: 'p', modelName: 'img', baseURL: 'u', apiKey: 'k' }, { provider: 'p', modelName: 'img', baseURL: 'u', apiKey: 'k' }] } }), 'CONFIG_INVALID')
})

test('模型缺字段、profiles 不是数组：CONFIG_INVALID', () => {
  throwsWithCode(() => setHostConfig({ models: { profiles: [{ provider: 'acme' } as any] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ models: { profiles: 'x' as any } }), 'CONFIG_INVALID')
})

test('scopes：未知类、未知值报 CONFIG_INVALID；写了的类只开写的域，没写的类全开', () => {
  throwsWithCode(() => setHostConfig({ scopes: { foo: ['host'] } as any }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ scopes: { models: ['project'] } as any }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ scopes: { plugins: ['host'] } as any }), 'CONFIG_INVALID')

  setHostConfig({ scopes: { models: ['host'], plugins: [] } })
  assert.equal(isScopeEnabled('models', 'host'), true)
  assert.equal(isScopeEnabled('models', 'user'), false)
  assert.equal(isScopeEnabled('plugins', 'user'), false)
  assert.equal(isScopeEnabled('mcp', 'project'), true, '没写的类全部生效')
})

test('scopes 不含 host：宿主传入的该类内容不生效，但仍然校验；没写 scopes 的类照常生效', () => {
  const skill = { name: 's', description: 'd', prompt: 'p' }
  setHostConfig({
    models: { profiles: [model('acme-pro')] },
    mcpServers: [{ name: 'cad', transport: 'stdio', command: 'cad-mcp' }],
    hooks: { Stop: [{ hooks: [{ command: 'echo stop' }] }] },
    skills: { items: [skill] },
    agents: { items: [skill] },
    commands: { items: [skill] },
    scopes: { models: ['user'], mcp: ['user'], hooks: [], skills: ['builtin'], agents: [] },
  })
  const host = getHostConfig()
  assert.equal(host.models, null)
  assert.deepEqual(host.mcpServers, [])
  assert.equal(host.hooks, null)
  assert.deepEqual(host.skills, {})
  assert.deepEqual(host.agents, {})
  assert.equal(host.commands.items?.length, 1, 'commands 没写 scopes，宿主命令照常生效')

  throwsWithCode(() => setHostConfig({ skills: { items: [skill, skill] }, scopes: { skills: [] } }), 'CONFIG_INVALID')
})

test('encryption：key 不是 32 字节、keyId 含冒号报 CONFIG_INVALID；合法时密钥只在内存', () => {
  throwsWithCode(() => setHostConfig({ encryption: { key: 'c2hvcnQ=' } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ encryption: { key: KEY, keyId: 'a:b' } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ encryption: { key: 123 } as any }), 'CONFIG_INVALID')

  setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
  const enc = getEncryptionKey()
  assert.equal(enc?.key.length, 32)
  assert.equal(enc?.keyId, 'k1')
})

test('skill / 子代理 / 命令 / MCP：缺必填、重名报 CONFIG_INVALID', () => {
  throwsWithCode(() => setHostConfig({ skills: { items: [{ name: 'a', description: 'd' } as any] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ skills: { items: [{ name: 'a', description: 'd', prompt: 'p' }, { name: 'a', description: 'd', prompt: 'p' }] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ skills: { dirs: [''] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ agents: { items: [{ name: 'a', description: 'd', prompt: '' }] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ commands: { items: [{ name: 'a', description: '', prompt: 'p' }] } }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ mcpServers: [{ name: 'cad', transport: 'stdio' }, { name: 'cad', transport: 'http' }] }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ hooks: [] as any }), 'CONFIG_INVALID')
})

test('日志视图：密钥、apiKey、MCP 凭证打码，内联正文只留长度，原对象不动', () => {
  const config = {
    encryption: { key: KEY },
    models: { profiles: [model('acme-pro')], imageProfiles: [{ provider: 'p', modelName: 'img', baseURL: 'u', apiKey: 'img-key' }] },
    mcpServers: [{ name: 'rules', transport: 'http' as const, url: 'https://mcp.acme.com', headers: { Authorization: 'Bearer secret' }, env: { TOKEN: 't' } }],
    skills: { items: [{ name: 'draw-flange', description: 'd', prompt: '壁厚取内径的 0.08 倍', files: { 'guides/x.md': '孔数取偶数' } }] },
  }
  const text = JSON.stringify(maskForLog(config))
  for (const secret of [KEY, 'tok', 'img-key', 'Bearer secret', '"t"', '0.08', '偶数']) {
    assert.equal(text.includes(secret), false, `日志里不应出现 ${secret}`)
  }
  assert.ok(text.includes('"Authorization":"***"'))
  assert.ok(text.includes(`"prompt":"<${config.skills.items[0].prompt.length} chars>"`))
  // 原对象不被改
  assert.equal(config.models.profiles[0].apiKey, 'tok')
  assert.equal(config.skills.items[0].prompt, '壁厚取内径的 0.08 倍')
})
