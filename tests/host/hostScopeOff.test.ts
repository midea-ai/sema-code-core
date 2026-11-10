import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'

// host 域与其他域同一条规则：某类的 scopes 不含 host 时，宿主传入的该类内容也不加载
const { root, project } = isolate('host-scope-off')

// 用户自己的一条模型：models 只开 user，生效的应该只有它
writeFile(join(root, 'model.conf'), JSON.stringify({
  modelProfiles: [{ name: 'mine[me]', provider: 'me', modelName: 'mine', baseURL: 'https://me.example.com/v1', apiKey: 'user-key', maxTokens: 1, contextLength: 1, adapt: 'openai' }],
  modelPointers: { main: 'mine[me]', quick: 'mine[me]' },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)

const item = (name: string) => ({ name, description: `${name} desc`, prompt: `${name} body` })
setHostConfig({
  models: { profiles: [{ provider: 'acme', modelName: 'acme-pro', baseURL: 'https://llm.acme.com/v1', apiKey: 'host-key', maxTokens: 8192, contextLength: 128000, adapt: 'openai' }] },
  mcpServers: [{ name: 'cad', transport: 'stdio', command: '/nonexistent/acme/cad-mcp', enabled: false }],
  hooks: { Stop: [{ hooks: [{ command: 'echo stop' }] }] },
  skills: { items: [item('draw-flange')] },
  agents: { items: [item('planner')] },
  commands: { items: [item('deploy')] },
  scopes: { models: ['user'], mcp: [], hooks: [], skills: [], agents: [], commands: [], plugins: [] },
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getModelManager } = require('../../src/manager/ModelManager') as typeof import('../../src/manager/ModelManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getMCPManager } = require('../../src/services/mcp/MCPManager') as typeof import('../../src/services/mcp/MCPManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHooksManager } = require('../../src/services/hooks/hooksManager') as typeof import('../../src/services/hooks/hooksManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSkillsManager } = require('../../src/services/skills/skillsManager') as typeof import('../../src/services/skills/skillsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAgentsManager } = require('../../src/services/agents/agentsManager') as typeof import('../../src/services/agents/agentsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCommandsManager } = require('../../src/services/commands/commandsManager') as typeof import('../../src/services/commands/commandsManager')

after(() => getMCPManager().dispose())

test('hook：hooks 为 [] 时宿主的 hook 也不加载、不触发', async () => {
  const info = await getHooksManager().getHooksInfo()
  assert.deepEqual(Object.keys(info.events), [])
  assert.equal(getHooksManager().getMatchedEntries('Stop').length, 0)
})

test('模型：models 只开 user 时宿主模型不进列表，用的是用户自己的', async () => {
  const data = await getModelManager().getModelData()
  assert.deepEqual(data.modelList, ['mine[me]'])
  assert.deepEqual(data.hostModels ?? [], [])
  assert.equal(getModelManager().getModel('main')?.apiKey, 'user-key')
})

test('MCP / skill / 子代理 / 命令：对应类为 [] 时宿主条目都不加载', async () => {
  assert.deepEqual((await getMCPManager().getMCPServerConfigs()).map(s => s.config.name), [])
  assert.deepEqual((await getSkillsManager().getSkillsInfo()).map(s => s.name), [])
  assert.deepEqual((await getAgentsManager().getAgentsInfo()).map(a => a.name), [])
  assert.deepEqual((await getCommandsManager().getCommandsInfo()).map(c => c.name), [])
})
