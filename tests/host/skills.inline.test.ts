import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// 产品形态：业务 skill 内联传入、磁盘上不留文本；允许用户自己的 skill 目录，但不要内置的。scopes.skills = ['host', 'user']
const { root, project } = isolate('skills-inline')

// 用户目录里有两个 skill：一个与宿主同名（试图覆盖），一个用户自己的
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} from user dir\n---\n${body}\n`
writeFile(join(root, 'skills', 'draw-flange', 'SKILL.md'), skillMd('draw-flange', 'USER VERSION'))
writeFile(join(root, 'skills', 'user-only', 'SKILL.md'), skillMd('user-only', 'user body'))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)

const PROMPT = '1. 向用户确认内径\n2. 厚壁工况看 guides/thick-wall.md\n3. 跑 python scripts/export_dxf.py'
const SUB = '厚壁：壁厚取内径的 0.08 倍且不小于 6mm'
const RES_DIR = '/opt/acme/skill-res/draw-flange'
setHostConfig({
  skills: {
    items: [{ name: 'draw-flange', description: '按尺寸和材质生成法兰盘图纸', prompt: PROMPT, files: { './guides/thick-wall.md': SUB }, resourceDir: RES_DIR }],
  },
  scopes: { skills: ['host', 'user'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSkillsManager } = require('../../src/services/skills/skillsManager') as typeof import('../../src/services/skills/skillsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Skill } = require('../../src/tools/Skill') as typeof import('../../src/tools/Skill')
const sm = getSkillsManager()

type CallResult = { resultForAssistant?: unknown; data: any; additionalBlocks?: Array<{ type: string; text?: string }> }
async function callSkill(input: { skill: string; args?: string; file?: string }): Promise<CallResult> {
  const results: CallResult[] = []
  for await (const r of (Skill as any).call(input)) results.push(r)
  assert.equal(results.length, 1)
  return results[0]
}

test('查询接口：内联 skill 只有名字和描述，没有正文、没有文件路径；同名用户 skill 被盖掉；内置不加载', async () => {
  const infos = await sm.getSkillsInfo()
  const flange = infos.find(s => s.name === 'draw-flange')!
  assert.equal(flange.locate, 'host')
  assert.equal(flange.private, true)
  assert.equal(flange.prompt, '')
  assert.equal(flange.filePath, undefined)
  assert.equal(flange.status, true)
  assert.equal(flange.description, '按尺寸和材质生成法兰盘图纸')

  const userOnly = infos.find(s => s.name === 'user-only')!
  assert.equal(userOnly.locate, 'user')
  assert.ok(userOnly.prompt.includes('user body'), '用户的目录 skill 正文照常回传')

  assert.equal(infos.some(s => s.locate === 'builtin'), false, 'builtin 不在 scopes 里')
  assert.equal(JSON.stringify(infos).includes('USER VERSION'), false, '同名用户版本不生效')
  assert.equal(JSON.stringify(infos).includes('0.08'), false, '子文件内容不在查询接口里')
})

test('内核内部拿得到正文与子文件，子文件路径已归一（去掉 ./）', () => {
  const conf = sm.getSkillConfig('draw-flange')!
  assert.equal(conf.prompt, PROMPT)
  assert.deepEqual(Object.keys(conf.files!), ['guides/thick-wall.md'])
  assert.equal(conf.resourceDir, RES_DIR)
})

test('开关与删除：宿主 skill 报 HOST_READONLY，用户 skill 照常', async () => {
  await rejectsWithCode(sm.setSkillEnabled('draw-flange', false), 'HOST_READONLY')
  await rejectsWithCode(sm.removeSkillConf('draw-flange'), 'HOST_READONLY')
  assert.equal(sm.isSkillDisabled('draw-flange'), false)

  await sm.setSkillEnabled('user-only', false)
  assert.equal(sm.isSkillDisabled('user-only'), true)
  await sm.setSkillEnabled('user-only', true)
})

test('激活：模型拿到资源目录说明和正文全文；发给宿主的权限请求与完成事件只有描述', async () => {
  assert.deepEqual(await Skill.validateInput({ skill: 'draw-flange' }), { result: true })
  assert.equal(Skill.genToolPermission({ skill: 'draw-flange' }).content, '按尺寸和材质生成法兰盘图纸')

  const r = await callSkill({ skill: 'draw-flange' })
  assert.equal(r.resultForAssistant, 'Skill "draw-flange" activated; its full instructions are provided below.')
  const text = r.additionalBlocks![0].text!
  assert.ok(text.includes(RES_DIR), '告诉模型脚本和资源在哪')
  assert.ok(text.includes('file parameter'), '告诉模型子文件走 file 参数')
  assert.ok(text.endsWith(PROMPT))

  assert.equal(r.data.private, true)
  assert.equal(r.data.systemPrompt, '', '事件数据里不带正文')
  const event = Skill.genToolResultMessage(r.data)
  assert.equal(event.summary, 'Skill "draw-flange" is now active.')
  assert.equal(event.content, '按尺寸和材质生成法兰盘图纸')
})

test('读子文件：模型拿到全文，事件里只有文件名；./ 前缀与否都认', async () => {
  for (const file of ['guides/thick-wall.md', './guides/thick-wall.md']) {
    assert.deepEqual(await Skill.validateInput({ skill: 'draw-flange', file }), { result: true })
    const r = await callSkill({ skill: 'draw-flange', file })
    assert.equal(r.resultForAssistant, SUB)
    assert.equal(r.additionalBlocks, undefined)
    const event = Skill.genToolResultMessage(r.data)
    assert.equal(event.summary, 'guides/thick-wall.md')
    assert.equal(event.content, '')
  }
  assert.equal(Skill.genToolPermission({ skill: 'draw-flange', file: 'guides/thick-wall.md' }).content, 'guides/thick-wall.md')
  assert.ok(Skill.getDisplayTitle({ skill: 'draw-flange', file: 'guides/thick-wall.md' }).includes('file: "guides/thick-wall.md"'))
})

test('读不存在的子文件、对目录 skill 用 file 参数：校验不过，错误信息能让模型自己纠正', async () => {
  const missing = await Skill.validateInput({ skill: 'draw-flange', file: 'guides/nope.md' })
  assert.equal(missing.result, false)
  assert.ok(missing.message!.includes('guides/thick-wall.md'), '列出可用文件')

  const onDisk = await Skill.validateInput({ skill: 'user-only', file: 'x.md' })
  assert.equal(onDisk.result, false)
  assert.ok(onDisk.message!.includes('on disk'))
})

test('目录 skill 的行为不变：激活消息带目录路径，事件带正文', async () => {
  const r = await callSkill({ skill: 'user-only' })
  const text = r.additionalBlocks![0].text!
  assert.ok(text.includes(join(root, 'skills', 'user-only')))
  assert.equal(r.data.private, undefined)
  assert.ok(Skill.genToolResultMessage(r.data).content.includes('user body'))
})
