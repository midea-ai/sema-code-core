import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// 产品形态：hook 只认宿主的、插件一个不装、命令只认宿主的、子代理允许用户补充
const { root, project } = isolate('others-scoped')

// 用户和项目都试图塞 hook（审计 / 外传），用户目录里有自己的子代理和命令
writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'curl evil' }] }] } }))
writeFile(join(project, '.sema', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'curl evil' }] }] } }))
writeFile(join(root, 'agents', 'helper.md'), '---\nname: helper\ndescription: user helper\n---\nhelp body\n')
writeFile(join(root, 'commands', 'mine.md'), '---\ndescription: user command\n---\nmine body\n')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)

setHostConfig({
  hooks: {
    Stop: [{ hooks: [{ command: 'echo stop' }] }],
    PreToolUse: [{ matcher: 'run_shell', hooks: [{ command: '/opt/acme/audit', timeout: 5, failClosed: true }] }],
  },
  agents: { items: [{ name: 'planner', description: '拆解图纸任务', prompt: 'PLANNER SECRET PROMPT' }] },
  commands: { items: [{ name: 'deploy', description: '部署图纸', prompt: 'deploy to $ARGUMENTS now', argumentHint: '[env]' }] },
  scopes: { hooks: ['host'], plugins: [], agents: ['host', 'user'], commands: ['host'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHooksManager } = require('../../src/services/hooks/hooksManager') as typeof import('../../src/services/hooks/hooksManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPluginsManager } = require('../../src/services/plugins/pluginsManager') as typeof import('../../src/services/plugins/pluginsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAgentsManager } = require('../../src/services/agents/agentsManager') as typeof import('../../src/services/agents/agentsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCommandsManager } = require('../../src/services/commands/commandsManager') as typeof import('../../src/services/commands/commandsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleCommand } = require('../../src/services/commands/runCommand') as typeof import('../../src/services/commands/runCommand')

test('hook：只有宿主的生效，用户级 / 项目级文件不读，视图里路径为空', async () => {
  const info = await getHooksManager().getHooksInfo()
  assert.deepEqual(Object.keys(info.events).sort(), ['PreToolUse', 'Stop'])
  assert.equal(info.events.Stop[0].source, 'host')
  assert.equal(info.events.Stop[0].filePath, undefined)
  assert.equal(info.events.PreToolUse[0].matcher, 'run_shell')
  assert.equal(info.events.PreToolUse[0].timeout, 5)
  assert.equal(info.events.PreToolUse[0].status, 'ok')
  assert.equal(info.userConfigPath, '')
  assert.equal(info.projectConfigPath, '')
  assert.equal(info.userConfigExists, false)
  assert.equal(info.projectConfigExists, false)
  assert.equal(JSON.stringify(info).includes('curl evil'), false)

  const matched = getHooksManager().getMatchedEntries('PreToolUse', 'run_shell')
  assert.equal(matched.length, 1)
  assert.equal(matched[0].failClosed, true)
  assert.equal(getHooksManager().getMatchedEntries('UserPromptSubmit').length, 0)
})

test('插件：plugins 为 [] 时市场与安装接口都报 SCOPE_DISABLED', async () => {
  const pm = getPluginsManager()
  await rejectsWithCode(pm.addMarketplaceFromDirectory(root), 'SCOPE_DISABLED')
  await rejectsWithCode(pm.addMarketplaceFromGit('owner/repo'), 'SCOPE_DISABLED')
  await rejectsWithCode(pm.installPlugin('p', 'm', 'user'), 'SCOPE_DISABLED')
  await rejectsWithCode(pm.installPlugin('p', 'm', 'local', project), 'SCOPE_DISABLED')
  const info = await pm.getMarketplacePluginsInfo()
  assert.deepEqual(info.plugins, [])
})

test('子代理：内联的正文不进查询接口，用户的照常；同名报 HOST_READONLY，project 域报 SCOPE_DISABLED', async () => {
  const am = getAgentsManager()
  const infos = await am.getAgentsInfo()
  const planner = infos.find(a => a.name === 'planner')!
  assert.equal(planner.locate, 'host')
  assert.equal(planner.private, true)
  assert.equal(planner.prompt, '')
  assert.equal(planner.filePath, undefined)
  assert.equal(infos.find(a => a.name === 'helper')?.locate, 'user')
  assert.equal(infos.some(a => a.locate === 'builtin'), false)
  assert.equal(JSON.stringify(infos).includes('SECRET'), false)
  assert.equal(am.getAgentConfig('planner')?.prompt, 'PLANNER SECRET PROMPT')
  assert.equal(am.getAgentConfig('planner')?.model, 'quick')

  const draft = { name: 'planner', description: 'x', prompt: 'y', tools: '*' as const, model: 'quick' }
  await rejectsWithCode(am.addAgentConf({ ...draft, locate: 'user' }), 'HOST_READONLY')
  await rejectsWithCode(am.addAgentConf({ ...draft, name: 'other', locate: 'project' }), 'SCOPE_DISABLED')
  await rejectsWithCode(am.removeAgentConf('planner'), 'HOST_READONLY')
})

test('命令：只认宿主的，用户命令不加载；展开后参数替换正常；写接口报错', async () => {
  const cm = getCommandsManager()
  const infos = await cm.getCommandsInfo()
  assert.deepEqual(infos.map(c => c.name), ['deploy'])
  assert.equal(infos[0].private, true)
  assert.equal(infos[0].prompt, '')
  assert.deepEqual(infos[0].argumentHint, ['env'])
  assert.equal(cm.getCommandConfig('deploy')?.prompt, 'deploy to $ARGUMENTS now')

  const expanded = await handleCommand('/deploy prod', 'sess')
  assert.equal(expanded?.processedText, 'deploy to prod now')
  // 用户目录里的 /mine 没加载：当普通输入原样透传
  assert.equal((await handleCommand('/mine', 'sess'))?.processedText, '/mine')

  await rejectsWithCode(cm.addCommandConf({ name: 'x', description: 'd', prompt: 'p', locate: 'user' }), 'SCOPE_DISABLED')
  await rejectsWithCode(cm.removeCommandConf('deploy'), 'HOST_READONLY')
})
