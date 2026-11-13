import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, throwsWithCode } from '../helpers/isolate'

// scopes.rules：规则文件 AGENTS.md 读哪几级；规则、记忆都关掉时首轮提醒仍带当前日期
const { root, project } = isolate('rules-scoped')

// 用户级和项目级各有一份规则文件
const userFile = join(root, 'AGENTS.md')
const projectFile = join(project, 'AGENTS.md')
writeFile(userFile, 'USER RULE BODY\n')
writeFile(projectFile, 'PROJECT RULE BODY\n')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getRuleManager } = require('../../src/services/rules/rulesManager') as typeof import('../../src/services/rules/rulesManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateRulesReminders } = require('../../src/services/agents/genSystemReminder') as typeof import('../../src/services/agents/genSystemReminder')

const cm = getConfManager()
type CoreConfig = Parameters<typeof cm.setCoreConfig>[0]

/** 按给定配置重建 core 配置并重读规则，返回规则信息与首轮提醒文本 */
async function load(config: Omit<CoreConfig, 'workingDir'> = {}) {
  await cm.setCoreConfig({ workingDir: project, ...config })
  const info = await getRuleManager().getRuleInfo(true)
  const blocks = generateRulesReminders() as Array<{ type: 'text'; text: string }>
  return { info, blocks, reminder: blocks.map(b => b.text).join('\n') }
}

const DATE_LINE = /# Date\nCurrent date: \d{4}-\d{2}-\d{2}/

test('不写 scopes：两级都读，项目级优先', async () => {
  const { info, reminder } = await load()
  assert.equal(info?.locate, 'project')
  assert.equal(info?.filePath, projectFile)
  assert.equal(reminder.includes(`Contents of ${projectFile} (user's instructions):\n\nPROJECT RULE BODY`), true)
  assert.equal(reminder.includes('USER RULE BODY'), false)
})

test("rules 为 ['user']：项目级文件不读，用的是用户级", async () => {
  const { info, reminder } = await load({ scopes: { rules: ['user'] } })
  assert.equal(info?.locate, 'user')
  assert.equal(info?.filePath, userFile)
  assert.equal(reminder.includes(`Contents of ${userFile} (user's instructions):\n\nUSER RULE BODY`), true)
  assert.equal(reminder.includes('PROJECT RULE BODY'), false)
})

test("rules 为 ['project']：用的是项目级", async () => {
  const { info, reminder } = await load({ scopes: { rules: ['project'] } })
  assert.equal(info?.locate, 'project')
  assert.equal(reminder.includes('PROJECT RULE BODY'), true)
  assert.equal(reminder.includes('USER RULE BODY'), false)
})

test('rules 为 []：两级都不读，getRuleInfo 恒为 null；customRules 不受影响', async () => {
  const { info, blocks, reminder } = await load({ scopes: { rules: [] }, customRules: 'HOST CUSTOM RULE' })
  assert.equal(info, null)
  assert.equal(await getRuleManager().getRuleInfo(), null)
  assert.equal(getRuleManager().getRuleDescription(), '')
  assert.equal(blocks.length, 1)
  assert.equal(reminder.includes('Custom rules (user-defined instructions):\n\nHOST CUSTOM RULE'), true)
  assert.equal(reminder.includes('Contents of'), false)
  assert.equal(reminder.includes('RULE BODY'), false)
})

test('规则、记忆、customRules 都没有：首轮提醒仍然注入，只带当前日期', async () => {
  const dayBefore = new Date().toISOString().slice(0, 10)
  const { info, blocks, reminder } = await load({ scopes: { rules: [] }, disableMemory: true })
  const dayAfter = new Date().toISOString().slice(0, 10)

  assert.equal(info, null)
  assert.equal(blocks.length, 1)
  assert.match(reminder, DATE_LINE)
  const injected = reminder.match(/Current date: (\S+)/)![1]
  assert.equal([dayBefore, dayAfter].includes(injected), true, `日期应为今天，实际 ${injected}`)
  assert.equal(reminder.includes('Contents of'), false)
  assert.equal(reminder.includes('Custom rules'), false)
})

test("只开 project 而项目里没有规则文件：不回落到用户级", async () => {
  rmSync(projectFile)
  const { info, reminder } = await load({ scopes: { rules: ['project'] } })
  assert.equal(info, null)
  assert.equal(reminder.includes('USER RULE BODY'), false)
  assert.match(reminder, DATE_LINE)
})

test('scopes.rules 校验：没有 host 域，未知值、非数组报 CONFIG_INVALID', () => {
  throwsWithCode(() => setHostConfig({ scopes: { rules: ['host'] } as any }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ scopes: { rules: ['local'] } as any }), 'CONFIG_INVALID')
  throwsWithCode(() => setHostConfig({ scopes: { rules: 'user' } as any }), 'CONFIG_INVALID')
})
