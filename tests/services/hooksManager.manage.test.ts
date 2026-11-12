import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode } from '../helpers/isolate'

// hook 的增删与启停：宿主内置一条，用户级、项目级 hooks.json 各有一条
const { root, project } = isolate('hooks-manage')

const userHooksPath = join(root, 'hooks', 'hooks.json')
const projectHooksPath = join(project, '.sema', 'hooks', 'hooks.json')
const userSettingsPath = join(root, 'settings.json')
const projectSettingsPath = join(project, '.sema', 'settings.json')

// 用户级文件带未知字段（顶层 note、组上的 description），改写后必须原样保留
writeFile(userHooksPath, JSON.stringify({
  note: 'keep me',
  hooks: { PreToolUse: [{ matcher: 'Bash', description: 'keep group field', hooks: [{ type: 'command', command: 'echo user' }] }] },
}))
writeFile(projectHooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo project' }] }] } }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)
setHostConfig({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo host' }] }] } })

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHooksManager } = require('../../src/services/hooks/hooksManager') as typeof import('../../src/services/hooks/hooksManager')
const hooks = getHooksManager()
after(() => hooks.dispose())

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const all = (info: Awaited<ReturnType<typeof hooks.getHooksInfo>>) => Object.values(info.events).flat()
const find = (info: Awaited<ReturnType<typeof hooks.getHooksInfo>>, command: string) => {
  const hit = all(info).find(e => e.command === command)
  assert.ok(hit, `应有命令为 ${command} 的条目`)
  return hit!
}
const matchedCommands = (event: string, tool?: string) => hooks.getMatchedEntries(event, tool, tool).map(e => e.command)

test('列表：每条都有 id 且默认启用', async () => {
  const info = await hooks.getHooksInfo(true)
  const entries = all(info)
  assert.deepEqual(entries.map(e => e.command).sort(), ['echo host', 'echo project', 'echo user'])
  for (const e of entries) {
    assert.match(e.id, /^[0-9a-f]{12}$/)
    assert.equal(e.enabled, true)
  }
  assert.equal(new Set(entries.map(e => e.id)).size, 3, '来源不同 id 不同')
})

test('启停：用户级条目写用户级 settings，禁用后不再触发，启用后恢复', async () => {
  const user = find(await hooks.getHooksInfo(), 'echo user')

  let info = await hooks.setHookEnabled(user.id, false)
  assert.equal(find(info, 'echo user').enabled, false)
  assert.equal(find(info, 'echo user').status, 'ok', 'status 与 enabled 独立')
  assert.deepEqual(readJson(userSettingsPath).disabledHooks, [user.id])
  assert.deepEqual(matchedCommands('PreToolUse', 'Bash'), ['echo host'])

  info = await hooks.setHookEnabled(user.id, true)
  assert.equal(find(info, 'echo user').enabled, true)
  assert.deepEqual(readJson(userSettingsPath).disabledHooks, [])
  assert.deepEqual(matchedCommands('PreToolUse', 'Bash'), ['echo host', 'echo user'])
})

test('启停：项目级条目写项目级 settings', async () => {
  const proj = find(await hooks.getHooksInfo(), 'echo project')
  await hooks.setHookEnabled(proj.id, false)
  assert.deepEqual(readJson(projectSettingsPath).disabledHooks, [proj.id])
  assert.deepEqual(matchedCommands('Stop'), [])
  await hooks.setHookEnabled(proj.id, true)
  assert.deepEqual(matchedCommands('Stop'), ['echo project'])
})

test('host 条目只读：启停与移除都报 HOST_READONLY，手写进 disabledHooks 也不生效', async () => {
  const host = find(await hooks.getHooksInfo(), 'echo host')
  await rejectsWithCode(hooks.setHookEnabled(host.id, false), 'HOST_READONLY')
  await rejectsWithCode(hooks.removeHook(host.id), 'HOST_READONLY')

  writeFile(userSettingsPath, JSON.stringify({ disabledHooks: [host.id] }))
  const info = await hooks.getHooksInfo(true)
  assert.equal(find(info, 'echo host').enabled, true)
  writeFile(userSettingsPath, JSON.stringify({}))
})

test('新增：同 matcher 追加进原组，新事件新建组，未知字段保留，重复添加不重复写', async () => {
  let info = await hooks.addHook({ scope: 'user', event: 'PreToolUse', matcher: 'Bash', command: 'echo added', timeout: 10, failClosed: true })
  const added = find(info, 'echo added')
  assert.equal(added.source, 'user')
  assert.equal(added.timeout, 10)

  info = await hooks.addHook({ scope: 'user', event: 'SessionStart', command: 'echo start' })
  assert.equal(find(info, 'echo start').matcher, undefined)

  await hooks.addHook({ scope: 'user', event: 'PreToolUse', matcher: 'Bash', command: 'echo added' })

  const file = readJson(userHooksPath)
  assert.equal(file.note, 'keep me')
  assert.equal(file.hooks.PreToolUse.length, 1, '同 matcher 不新建组')
  assert.equal(file.hooks.PreToolUse[0].description, 'keep group field')
  assert.deepEqual(file.hooks.PreToolUse[0].hooks, [
    { type: 'command', command: 'echo user' },
    { type: 'command', command: 'echo added', timeout: 10, failClosed: true },
  ])
  assert.deepEqual(file.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo start' }] }])
})

test('新增：入参不合法报 CONFIG_INVALID', async () => {
  await rejectsWithCode(hooks.addHook({ scope: 'user', event: 'NoSuchEvent' as any, command: 'echo x' }), 'CONFIG_INVALID')
  await rejectsWithCode(hooks.addHook({ scope: 'user', event: 'Stop', command: '  ' }), 'CONFIG_INVALID')
  await rejectsWithCode(hooks.addHook({ scope: 'user', event: 'Stop', command: 'echo x', timeout: 0 }), 'CONFIG_INVALID')
})

test('移除：删掉条目并清掉禁用记录，组和事件删空后一并去掉', async () => {
  const start = find(await hooks.getHooksInfo(), 'echo start')
  await hooks.setHookEnabled(start.id, false)
  assert.deepEqual(readJson(userSettingsPath).disabledHooks, [start.id])

  let info = await hooks.removeHook(start.id)
  assert.equal(all(info).some(e => e.command === 'echo start'), false)
  assert.equal('SessionStart' in readJson(userHooksPath).hooks, false)
  assert.deepEqual(readJson(userSettingsPath).disabledHooks, [])

  info = await hooks.removeHook(find(info, 'echo added').id)
  const file = readJson(userHooksPath)
  assert.deepEqual(file.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'echo user' }], '组里其他条目不动')
  assert.equal(file.note, 'keep me')

  // 不存在的 id：不抛错，列表不变
  const before = all(info).length
  assert.equal(all(await hooks.removeHook('000000000000')).length, before)
})

test('文件写坏时新增直接报错，不覆盖原文件', async () => {
  writeFile(projectHooksPath, '{ broken')
  await assert.rejects(hooks.addHook({ scope: 'project', event: 'Stop', command: 'echo y' }), /Failed to parse hooks config/)
  assert.equal(readFileSync(projectHooksPath, 'utf8'), '{ broken')
})
