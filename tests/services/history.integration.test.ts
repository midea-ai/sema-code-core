import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, wait, writeFile } from '../helpers/isolate'
import type { Message } from '../../src/types/message'

const { project, root } = isolate('history-integration')
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
const { getStateManager } = require('../../src/manager/StateManager') as typeof import('../../src/manager/StateManager')
const { SemaEngine } = require('../../src/core/SemaEngine') as typeof import('../../src/core/SemaEngine')
const { createSessionEventBus } = require('../../src/events/EventSystem') as typeof import('../../src/events/EventSystem')
const { getCheckpointManager } = require('../../src/manager/CheckpointManager') as typeof import('../../src/manager/CheckpointManager')
const { loadHistory, closeHistory, resolveHistoryFile } = require('../../src/util/history') as typeof import('../../src/util/history')
const { __historyTestHooks } = require('../../src/util/historyStore') as typeof import('../../src/util/historyStore')
const { handleCommand } = require('../../src/services/commands/runCommand') as typeof import('../../src/services/commands/runCommand')
const { getHooksManager } = require('../../src/services/hooks/hooksManager') as typeof import('../../src/services/hooks/hooksManager')
const { firePreCompact, fireSubagentStop } = require('../../src/services/hooks/hookTriggers') as typeof import('../../src/services/hooks/hookTriggers')
const { registerAttachment } = require('../../src/util/attachmentLedger') as typeof import('../../src/util/attachmentLedger')
const { getAttachmentsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')
const message = (uuid: string, content = uuid): Message => ({ type: 'user', uuid: uuid as any, checkpointSeq: 0, message: { role: 'user', content } })
const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const states = getStateManager()
const engines: InstanceType<typeof SemaEngine>[] = []
function session(id: string) {
  const engine = new SemaEngine(id, createSessionEventBus(id))
  engines.push(engine)
  const runtime = states.session(id)
  runtime.setMessageHistory([message('first'), message('second')])
  return { engine, runtime }
}

before(async () => {
  const script = join(root, 'capture.cjs')
  writeFileSync(script, `const fs = require('fs'); const p = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.writeFileSync(${JSON.stringify(root)} + '/' + p.session_id + '-' + p.hook_event_name + '.capture',
      JSON.stringify({ payload: p, main: fs.readFileSync(p.transcript_path, 'utf8'),
        child: p.agent_transcript_path ? fs.readFileSync(p.agent_transcript_path, 'utf8') : null }));`)
  const entry = [{ hooks: [{ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }] }]
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none', hooks: { PreCompact: entry, SubagentStop: entry } })
  await getHooksManager().ready()
})
after(() => {
  for (const engine of engines) { engine.dispose(); states.removeSession(engine.sessionId) }
})

test('rewind commits the truncated pair, branch makes an independent pair without child execution history', async () => {
  const { engine, runtime } = session('branch-rewind')
  runtime.setMessageHistory([message('child')], 'actual-task-id')
  const sourceBytes = readFileSync(runtime.getTranscriptPath())
  const result = await engine.branchToNewChat('second')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual((await loadHistory(result.sessionId, project)).messages.map(m => m.uuid), ['first'])
  const branchStem = resolveHistoryFile(result.sessionId, project).stem
  assert.equal(existsSync(branchStem), false)
  closeHistory(result.sessionId, project)
  assert.deepEqual(readFileSync(runtime.getTranscriptPath()), sourceBytes)
  assert.equal((await engine.rewind('second')).ok, true)
  assert.deepEqual(rows(runtime.getTranscriptPath()).map(m => m.uuid), ['first'])
  assert.equal((await engine.rewind('first')).ok, true)
  assert.equal(readFileSync(runtime.getTranscriptPath(), 'utf8'), '')
  assert.equal(JSON.parse(readFileSync(resolveHistoryFile(engine.sessionId, project).stem + '.meta.json', 'utf8')).messageCount, 0)
})

test('failed rewind publishes no success event, retains editlog, and cannot be overwritten by dispose', async () => {
  const { engine, runtime } = session('failed-rewind')
  const checkpoint = getCheckpointManager()
  const file = join(project, 'rewind-file.txt')
  writeFile(file, 'before')
  checkpoint.beginTurn(engine.sessionId)
  checkpoint.recordPreEdit(engine.sessionId, 'main', file)
  let successes = 0
  engine.on('conversation:usage', () => successes++)
  __historyTestHooks.afterStep = at => { if (at === 'rewrite:intent') throw new Error('disk failed') }
  try { assert.equal((await engine.rewind('second')).ok, false) }
  finally { __historyTestHooks.afterStep = undefined }
  assert.equal(successes, 0)
  assert.equal(runtime.getMessageHistory().length, 2)
  assert.equal(checkpoint.getEditCount(engine.sessionId), 1)
  assert.throws(() => runtime.saveSessionHistory(), { code: 'HISTORY_BUSY' })
  states.removeSession(engine.sessionId)
  assert.deepEqual((await loadHistory(engine.sessionId, project)).messages.map(m => m.uuid), ['first'])
  closeHistory(engine.sessionId, project)
})

test('agent flush uses its own messages; state cleanup and dispose do not erase its file', async () => {
  const { engine, runtime } = session('child-flush')
  const child = runtime.forAgent('task-id-from-nanoid')
  child.setMessageHistory([message('child-one')])
  child.setMessageHistory([...child.getMessageHistory(), message('child-two')], true)
  await child.flushHistory()
  const file = runtime.getTranscriptPath('task-id-from-nanoid')
  assert.deepEqual(rows(file).map(m => m.uuid), ['child-one', 'child-two'])
  fireSubagentStop(engine.sessionId, 'task-id-from-nanoid', 'worker')
  runtime.clearAgentState('task-id-from-nanoid')
  states.removeSession(engine.sessionId)
  const output = join(root, engine.sessionId + '-SubagentStop.capture')
  for (let i = 0; i < 100 && !existsSync(output); i++) await wait(20)
  assert.ok(existsSync(output), 'hook must retain its paths before runtime disposal')
  const captured = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(captured.payload.agent_transcript_path, file)
  assert.equal(captured.child, readFileSync(file, 'utf8'))
  child.setMessageHistory([message('late')])
  assert.equal(rows(file).length, 2)
})

test('PreCompact hook sees current effective full messages, including same-UUID replacement', async () => {
  const { engine, runtime } = session('hook-effective')
  runtime.replaceMessageHistory([message('first', 'compacted content')])
  runtime.setMessageHistory([...runtime.getMessageHistory(), message('pending')], 'main', true)
  await firePreCompact(engine.sessionId, 'auto', '')
  const captured = JSON.parse(readFileSync(join(root, engine.sessionId + '-PreCompact.capture'), 'utf8'))
  assert.equal(captured.payload.transcript_path, runtime.getTranscriptPath())
  assert.deepEqual(captured.main.trim().split('\n').map((line: string) => JSON.parse(line).message.content), ['compacted content', 'pending'])
})

test('/clear waits for active child readers and late writes cannot revive old agents', async () => {
  const { engine, runtime } = session('clear-reader')
  runtime.setMessageHistory([message('child')], 'old-task')
  const lease = runtime.prepareHistoryForHook('old-task')
  await handleCommand('/clear', engine.sessionId)
  assert.equal(readFileSync(runtime.getTranscriptPath(), 'utf8'), '')
  assert.ok(existsSync(lease.agentPath!))
  runtime.setMessageHistory([message('new-child')], 'new-task')
  lease.release()
  assert.equal(existsSync(lease.agentPath!), false)
  runtime.setMessageHistory([message('late')], 'old-task')
  assert.deepEqual(readdirSync(resolveHistoryFile(engine.sessionId, project).stem), ['new-task.jsonl'])
})

test('/clear commit failure preserves attachments and does not emit session:cleared', async () => {
  const { engine, runtime } = session('clear-failure')
  const attachment = join(getAttachmentsDir(), '00000000-0000-4000-8000-000000000111', 'image.png')
  writeFile(attachment, 'image')
  registerAttachment(engine.sessionId, attachment, project)
  let cleared = false
  engine.on('session:cleared', () => { cleared = true })
  __historyTestHooks.afterStep = at => { if (at === 'rewrite:intent') throw new Error('disk failed') }
  try { await assert.rejects(handleCommand('/clear', engine.sessionId), /disk failed/) }
  finally { __historyTestHooks.afterStep = undefined }
  assert.equal(cleared, false)
  assert.ok(existsSync(attachment))
  assert.equal(runtime.getMessageHistory().length, 2)
})

test('input retract persists empty effective history and the previous read timestamps', async () => {
  const { engine, runtime } = session('input-retract')
  let retracted = false
  engine.on('input:retracted', () => { retracted = true })
  await (engine as any).retractInput({ inputId: 'input-id', input: 'cancelled input' }, {
    history: [], readFileTimestamps: { '/old-file': 123 }, planInfoSent: false, designInfoSent: false, imagePaths: [],
  })
  assert.equal(retracted, true)
  assert.equal(readFileSync(runtime.getTranscriptPath(), 'utf8'), '')
  assert.deepEqual((await loadHistory(engine.sessionId, project)).readFileTimestamps, { '/old-file': 123 })
})

test('manual compact commits before compact:exec; persistence failure reports error without success', async () => {
  const { __compactTestHooks } = require('../../src/util/compact') as typeof import('../../src/util/compact')
  __compactTestHooks.setDependencies({ queryLLM: async () => ({
    type: 'assistant', uuid: 'summary-id', durationMs: 0,
    message: { id: 'summary', type: 'message', role: 'assistant', model: 'test', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'A summary of the work completed.' }], usage: { input_tokens: 100, output_tokens: 10 } },
  } as any) })
  try {
    const { engine, runtime } = session('manual-compact')
    runtime.setReadFileTimestamps({ '/stale-file': 1 })
    let compacted = 0
    engine.on('compact:exec', () => {
      compacted++
      assert.equal(rows(runtime.getTranscriptPath()).length, 1)
    })
    await handleCommand('/compact', engine.sessionId)
    assert.equal(compacted, 1)
    assert.equal(runtime.getMessageHistory().length, 1)
    assert.deepEqual((await loadHistory(engine.sessionId, project)).readFileTimestamps, {})
    const failed = session('compact-failure')
    let successes = 0, failures = 0
    failed.engine.on('compact:exec', () => successes++)
    failed.engine.on('session:error', () => failures++)
    __historyTestHooks.afterStep = at => { if (at === 'rewrite:intent') throw new Error('disk failed') }
    try { await handleCommand('/compact', failed.engine.sessionId) }
    finally { __historyTestHooks.afterStep = undefined }
    assert.equal(successes, 0)
    assert.equal(failures, 1)
    assert.equal(failed.runtime.getMessageHistory().length, 2)
  } finally { __compactTestHooks.resetDependencies() }
})

test('plan context reset commits empty task state while retaining the long-term goal', async () => {
  const { engine, runtime } = session('plan-context')
  const goal = { text: 'finish implementation', status: 'paused' as const, round: 1, maxRounds: 10, idleRounds: 0, createdAt: 1, updatedAt: 1 }
  runtime.setGoal(goal)
  runtime.setReadFileTimestamps({ '/old': 1 })
  const { PlanToAgent } = require('../../src/tools/PlanToAgent') as typeof import('../../src/tools/PlanToAgent')
  const planFile = join(project, 'implementation-plan.md')
  writeFile(planFile, 'Implement the approved change')
  runtime.agentMode = 'Plan'
  engine.once('plan:exit:request', () => setImmediate(() => engine.emit('plan:exit:response', { agentId: 'main', selected: 'clearContextAndStart' })))
  let implemented = false
  engine.on('plan:implement', () => { implemented = true; assert.equal(runtime.agentMode, 'Agent') })
  for await (const _ of PlanToAgent.call({ plan_file_path: planFile }, { sessionId: engine.sessionId, agentId: 'main', abortController: new AbortController() })) {}
  assert.equal(implemented, true)
  const restored = await loadHistory(engine.sessionId, project)
  assert.equal(restored.messages.length, 1)
  assert.match(JSON.stringify(restored.messages[0]), /Implement the approved change/)
  assert.deepEqual(restored.goal, goal)
  assert.deepEqual(restored.todos, [])
  assert.deepEqual(restored.todoTasks, [])
  assert.deepEqual(restored.readFileTimestamps, {})
})

test('automatic compact persists the result before notification and preserves the latest user input', async () => {
  const { autoCompact, __compactTestHooks } = require('../../src/util/compact') as typeof import('../../src/util/compact')
  const summary = {
    type: 'assistant', uuid: 'summary-id', durationMs: 0,
    message: { id: 'summary', type: 'message', role: 'assistant', model: 'test', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Summarized previous work.' }], usage: { input_tokens: 100, output_tokens: 10 } },
  } as Message
  __compactTestHooks.setDependencies({ queryLLM: async () => summary as any })
  try {
    const { engine, runtime } = session('auto-compact')
    runtime.setMessageHistory([message('old'), summary, message('latest-input')])
    let committed = false, notified = false
    engine.on('compact:exec', () => { notified = true; assert.equal(committed, true) })
    const result = await autoCompact(runtime.getMessageHistory(), new AbortController(), engine.sessionId, {
      commit: messages => { runtime.replaceMessageHistory(messages, undefined, {}); committed = true },
    })
    assert.equal(result.changed, true)
    assert.equal(notified, true)
    assert.deepEqual(rows(runtime.getTranscriptPath()).map(m => m.uuid), result.messages.map(m => m.uuid))
    assert.equal(result.messages[result.messages.length - 1].uuid, 'latest-input')
    notified = false
    await assert.rejects(autoCompact([message('old'), summary, message('latest-input')], new AbortController(), engine.sessionId, {
      commit: () => { throw new Error('commit failed') },
    }), /commit failed/)
    assert.equal(notified, false)
  } finally { __compactTestHooks.resetDependencies() }
})
