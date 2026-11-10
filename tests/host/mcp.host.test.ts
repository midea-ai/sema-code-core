import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, rejectsWithCode, wait } from '../helpers/isolate'

// 产品形态：内置两个 MCP 服务，允许用户加自己的（user 域），项目级不认。scopes.mcp = ['host', 'user']
const { root, project } = isolate('mcp-host')

// 用户在 ~/.sema/.mcp.json 里塞了一条与宿主同名的 cad（想把工具换成自己的）和一条自己的 user-srv；
// 项目级 .mcp.json 里有 proj-srv；settings 里把 cad 禁用了
writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
  cad: { transport: 'stdio', command: '/tmp/evil-cad' },
  'user-srv': { transport: 'stdio', command: '/nonexistent/user-srv', enabled: false },
} }))
writeFile(join(project, '.sema', '.mcp.json'), JSON.stringify({ mcpServers: { 'proj-srv': { transport: 'stdio', command: '/nonexistent/proj', enabled: false } } }))
writeFile(join(root, 'settings.json'), JSON.stringify({ disabledMcpServers: ['cad'] }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)
setHostConfig({
  mcpServers: [
    // cad 启用：会真的去连，命令不存在连接失败，但状态事件里凭证必须打码
    { name: 'cad', transport: 'stdio', command: '/nonexistent/acme/cad-mcp', env: { CAD_TOKEN: 'top-secret' } },
    { name: 'rules', transport: 'http', url: 'https://mcp.acme.com/rules', headers: { Authorization: 'Bearer top-secret' }, enabled: false, useTools: ['check'] },
  ],
  scopes: { mcp: ['host', 'user'] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EventBus } = require('../../src/events/EventSystem') as typeof import('../../src/events/EventSystem')
const statusEvents: any[] = []
EventBus.getInstance().on('mcp:server:status', (info: any) => statusEvents.push(info))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getMCPManager } = require('../../src/services/mcp/MCPManager') as typeof import('../../src/services/mcp/MCPManager')
const mcp = getMCPManager()
after(() => mcp.dispose())

test('列表：宿主条目优先且不受 settings 禁用影响，同名用户条目不加载，项目级整层不读', async () => {
  const list = await mcp.getMCPServerConfigs()
  const byName = Object.fromEntries(list.map(s => [s.config.name, s]))

  assert.deepEqual(Object.keys(byName).sort(), ['cad', 'rules', 'user-srv'])
  assert.equal(byName.cad.scope, 'host')
  assert.equal(byName.cad.status, true, 'settings 里的 disabledMcpServers 对 host 条目无效')
  assert.equal(byName.cad.config.command, '/nonexistent/acme/cad-mcp', '用户同名条目没盖掉宿主的')
  assert.equal(byName.cad.filePath, undefined)
  assert.equal(byName.rules.status, false, '宿主自己传的 enabled:false 生效')
  assert.deepEqual(byName.rules.config.useTools, ['check'])
  assert.equal(byName['user-srv'].scope, 'user')
})

test('凭证打码：查询接口与状态事件里 env / headers 只剩键名', async () => {
  const list = await mcp.getMCPServerConfigs()
  const cad = list.find(s => s.config.name === 'cad')!
  const rules = list.find(s => s.config.name === 'rules')!
  assert.deepEqual(cad.config.env, { CAD_TOKEN: '***' })
  assert.deepEqual(rules.config.headers, { Authorization: '***' })
  assert.equal(JSON.stringify(list).includes('top-secret'), false)

  // cad 的连接尝试会发状态事件（connecting / error）
  for (let i = 0; i < 30 && !statusEvents.some(e => e.config?.name === 'cad'); i++) await wait(100)
  const cadEvents = statusEvents.filter(e => e.config?.name === 'cad')
  assert.ok(cadEvents.length > 0, '应收到 cad 的状态事件')
  for (const e of cadEvents) assert.deepEqual(e.config.env, { CAD_TOKEN: '***' })
})

test('写接口：与宿主同名报 HOST_READONLY，项目级报 SCOPE_DISABLED，用户级照常写进 ~/.sema/.mcp.json', async () => {
  await rejectsWithCode(mcp.addMCPServer({ name: 'cad', transport: 'stdio', command: 'x', scope: 'user' }), 'HOST_READONLY')
  await rejectsWithCode(mcp.addMCPServer({ name: 'new-srv', transport: 'stdio', command: 'x', scope: 'project' }), 'SCOPE_DISABLED')
  await rejectsWithCode(mcp.removeMCPServer('rules'), 'HOST_READONLY')
  await rejectsWithCode(mcp.disableMCPServer('cad'), 'HOST_READONLY')
  await rejectsWithCode(mcp.enableMCPServer('rules'), 'HOST_READONLY')
  await rejectsWithCode(mcp.updateMCPUseTools('rules', ['other']), 'HOST_READONLY')

  const list = await mcp.addMCPServer({ name: 'new-srv', transport: 'stdio', command: '/nonexistent/new', enabled: false, scope: 'user' })
  assert.ok(list.some(s => s.config.name === 'new-srv' && s.scope === 'user'))
  const userFile = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
  assert.ok('new-srv' in userFile.mcpServers)
  assert.equal(userFile.mcpServers.cad.command, '/tmp/evil-cad', '用户文件里原来的同名条目不动')
})
