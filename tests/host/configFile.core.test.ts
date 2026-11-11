import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, KEY, throwsWithCode, writeFile } from '../helpers/isolate'

// 构造参数 configFile 接到 SemaCore 上：整份构造配置（含 host 域内容、生效域、密钥、usageProduct）写在文件里，
// 构造时只传路径；效果应与把这些字段直接写在构造参数里一样。读取与合并规则本身见 configFile.test.ts
const { root, project } = isolate('config-file-core')

const confDir = join(root, 'conf')
const PROMPT = '1. 向用户确认内径\n2. 跑 python scripts/export_dxf.py'
writeFile(join(confDir, 'prompts', 'system.md'), 'SYSTEM FROM FILE')
writeFile(join(confDir, 'skills', 'draw-flange.md'), PROMPT)
const configFile = join(confDir, 'core.json')
writeFile(configFile, JSON.stringify({
  workingDir: project,
  logLevel: 'none',
  systemPrompt: { $file: './prompts/system.md' },
  customRules: 'file rules',
  enableToolSearch: true,
  usageProduct: 'config-file-test',
  skills: { items: [{ name: 'draw-flange', description: '按尺寸生成法兰盘图纸', prompt: { $file: 'skills/draw-flange.md' } }] },
  scopes: { skills: ['host'], plugins: [] },
  encryption: { key: KEY, keyId: 'k1' },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SemaCore } = require('../../src/core/SemaCore') as typeof import('../../src/core/SemaCore')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHostConfig, getEncryptionKey, isScopeEnabled } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUsageStatsManager } = require('../../src/manager/UsageStatsManager') as typeof import('../../src/manager/UsageStatsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSkillsManager } = require('../../src/services/skills/skillsManager') as typeof import('../../src/services/skills/skillsManager')

test('配置文件有问题：构造同步抛 CONFIG_INVALID，不留下生效的配置', () => {
  throwsWithCode(() => new SemaCore({ configFile: join(confDir, 'missing.json') }), 'CONFIG_INVALID')
  throwsWithCode(() => new SemaCore({ configFile: 'core.json' }), 'CONFIG_INVALID')
  const badRef = join(confDir, 'bad-ref.json')
  writeFile(badRef, JSON.stringify({ workingDir: project, systemPrompt: { $file: './nope.md' } }))
  throwsWithCode(() => new SemaCore({ configFile: badRef }), 'CONFIG_INVALID')
  assert.equal(getConfManager().getCoreConfig(), null)
})

test('文件里的宿主配置照常校验：scopes 写错、密钥不合法同样在构造时抛', () => {
  const badScope = join(confDir, 'bad-scope.json')
  writeFile(badScope, JSON.stringify({ workingDir: project, logLevel: 'none', scopes: { skills: ['hots'] } }))
  assert.throws(() => new SemaCore({ configFile: badScope }), (err: any) => err.code === 'CONFIG_INVALID' && err.message.includes('scopes.skills'))
  const badKey = join(confDir, 'bad-key.json')
  writeFile(badKey, JSON.stringify({ workingDir: project, logLevel: 'none', encryption: { key: 'not-32-bytes' } }))
  assert.throws(() => new SemaCore({ configFile: badKey }), (err: any) => err.code === 'CONFIG_INVALID' && err.message.includes('encryption.key'))
})

// 以下用例共用同一个 core：只传路径，另外显式传 customRules 覆盖文件里的
let core: InstanceType<typeof SemaCore>
test('只传路径构造成功，异步初始化（workingDir 校验等）通过', async () => {
  core = new SemaCore({ configFile, customRules: 'arg rules' })
  await (core as any).configPromise
})

test('普通字段：取文件里的，$file 换成文本，构造参数显式传的覆盖文件', () => {
  const effective = getConfManager().getCoreConfig()!
  assert.equal(effective.workingDir, project)
  assert.equal(effective.systemPrompt, 'SYSTEM FROM FILE')
  assert.equal(effective.enableToolSearch, true)
  assert.equal(effective.customRules, 'arg rules')
  assert.equal(effective.configFile, configFile)
})

test('host 域内容与生效域：文件里的内联 skill 生效，正文来自 $file 指向的文件', async () => {
  assert.equal(getHostConfig().skills.items?.[0].prompt, PROMPT)
  assert.equal(isScopeEnabled('skills', 'host'), true)
  assert.equal(isScopeEnabled('skills', 'builtin'), false)
  assert.equal(isScopeEnabled('plugins', 'user'), false)

  const infos = await core.getSkillsInfo(true)
  assert.deepEqual(infos.map(s => [s.name, s.locate]), [['draw-flange', 'host']])
  assert.equal(getSkillsManager().getSkillConfig('draw-flange')!.prompt, PROMPT)
})

test('密钥：文件里的 encryption 生效，不进 coreConfig；日志开关缺省随之变为不写', () => {
  const enc = getEncryptionKey()!
  assert.equal(enc.keyId, 'k1')
  assert.equal(enc.key.toString('base64'), KEY)
  const effective = getConfManager().getCoreConfig()!
  assert.equal('encryption' in effective, false)
  assert.equal(effective.disableLLMLog, true)
  assert.equal(effective.disableEventLog, true)
})

test('usageProduct：写在文件里同样开启使用统计', async () => {
  assert.equal((getUsageStatsManager() as any).product, 'config-file-test')
  await core.dispose()
})
