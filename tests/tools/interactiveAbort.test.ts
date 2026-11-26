import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'
import type { Message } from '../../src/types/message'

const { project } = isolate('interactive-abort')
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
const { getStateManager } = require('../../src/manager/StateManager') as typeof import('../../src/manager/StateManager')
const { SemaEngine } = require('../../src/core/SemaEngine') as typeof import('../../src/core/SemaEngine')
const { createSessionEventBus } = require('../../src/events/EventSystem') as typeof import('../../src/events/EventSystem')
const { runToolUse } = require('../../src/core/RunTools') as typeof import('../../src/core/RunTools')
const { PickOption } = require('../../src/tools/PickOption') as typeof import('../../src/tools/PickOption')
const { PlanToAgent } = require('../../src/tools/PlanToAgent') as typeof import('../../src/tools/PlanToAgent')
const { CANCEL_MSG } = require('../../src/util/message') as typeof import('../../src/util/message')
const { TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT } = require('../../src/prompt/tool') as typeof import('../../src/prompt/tool')

const states = getStateManager()
const engines: InstanceType<typeof SemaEngine>[] = []

function session(id: string) {
  const engine = new SemaEngine(id, createSessionEventBus(id))
  engines.push(engine)
  return { engine, runtime: states.session(id), bus: createSessionEventBus(id) }
}

/** 跑一次工具调用，收集产出的消息 */
async function run(toolName: string, input: Record<string, unknown>, ctx: Record<string, unknown>) {
  const toolUse = { type: 'tool_use', id: 'tool-1', name: toolName, input } as any
  const messages: Message[] = []
  for await (const message of runToolUse(toolUse, {} as any, ctx as any)) messages.push(message)
  return messages
}

/** 取出唯一一条 tool_result */
function toolResult(messages: Message[]) {
  assert.equal(messages.length, 1)
  const content = messages[0].message.content as any[]
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'tool_result')
  return content[0]
}

before(async () => {
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none' })
})
after(() => {
  for (const engine of engines) { engine.dispose(); states.removeSession(engine.sessionId) }
})

test('interrupting ask_form while it waits for answers is not a tool error', async () => {
  const { engine, bus } = session('abort-ask-form')
  const abortController = new AbortController()
  const errors: any[] = []
  bus.on('tool:execution:error', (data: any) => errors.push(data))
  // 面板已弹出、用户还没提交就中断本轮
  bus.on('pick:option:request', () => setImmediate(() => abortController.abort()))

  const messages = await run(
    TOOL_NAME_PICK_OPTION,
    { questions: [{ type: 'radio', id: 'q', label: 'Pick one', options: ['a', 'b'] }] },
    { sessionId: engine.sessionId, agentId: 'main', abortController, tools: [PickOption] },
  )

  const block = toolResult(messages)
  assert.deepEqual(errors, [])
  assert.equal(block.content, CANCEL_MSG)
  assert.equal(block.is_error, true)
})

test('interrupting plan_to_agent while it waits for approval is not a tool error', async () => {
  const { engine, runtime, bus } = session('abort-plan-exit')
  const planFile = join(project, 'plan.md')
  writeFile(planFile, '# Plan\n\nDo the thing.')
  runtime.agentMode = 'Plan'

  const abortController = new AbortController()
  const errors: any[] = []
  bus.on('tool:execution:error', (data: any) => errors.push(data))
  // 先按正常流程放行权限询问，再在中途中断审批卡
  bus.on('tool:permission:request', (data: any) => {
    setImmediate(() => bus.emit('tool:permission:response', {
      toolId: data.toolId, toolName: data.toolName, selected: 'agree',
    }))
  })
  bus.on('plan:exit:request', () => setImmediate(() => abortController.abort()))

  const messages = await run(
    TOOL_NAME_PLAN_TO_AGENT,
    { plan_file_path: planFile },
    { sessionId: engine.sessionId, agentId: 'main', abortController, tools: [PlanToAgent] },
  )

  const block = toolResult(messages)
  assert.deepEqual(errors, [])
  assert.equal(block.content, CANCEL_MSG)
  assert.equal(block.is_error, true)
  // 未确认退出：会话仍留在 Plan 模式
  assert.equal(runtime.agentMode, 'Plan')
})
