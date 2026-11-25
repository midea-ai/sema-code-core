import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, KEY, OTHER_KEY, rejectsWithCode } from '../helpers/isolate'

// 本进程传了 encryption（keyId k1），没有 hooks 也照常保存完整历史
const { project } = isolate('history-enc')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptLine, decryptLine } = require('../../src/util/cipher') as typeof import('../../src/util/cipher')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHistory, saveHistory, resolveHistoryFile, deleteSessionHistory, getHistoryStore } = require('../../src/util/history') as typeof import('../../src/util/history')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snap = require('../../src/util/snapshotStore') as typeof import('../../src/util/snapshotStore')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProjectHistoryDir, getProjectSnapshotsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')
// eslint-disable-next-line @typescript-eslint/no-require-imports

const historyDir = getProjectHistoryDir(project)
const snapDir = getProjectSnapshotsDir(project)

// 一轮对话：用户输入 → 模型激活 skill → skill 正文作为 text 块进入上下文
const messages = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: '画一个内径 50 的法兰盘' } },
  { type: 'assistant', uuid: 'a1', durationMs: 1, message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't1', name: 'skill', input: { skill: 'draw-flange' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'activated' }, { type: 'text', text: '壁厚取内径的 0.08 倍且不小于 6mm' }] } },
] as any[]

const SECRET = '壁厚取内径的 0.08 倍'
const listHistory = () => readdirSync(historyDir)
const readSingleLine = (file: string) => {
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 1, '整个文件应是一行密文')
  return raw.trim()
}

test('新会话保存：元信息与逐行密文消息分离，正文不泄露，读回一致', async () => {
  await saveHistory('s1', messages, [], project, undefined, undefined, false)

  const files = listHistory()
  const enc = files.find(f => f.endsWith('_s1.meta.json.enc'))
  assert.ok(enc, `应有带日期的 .json.enc：${files.join(', ')}`)
  assert.equal(files.some(f => f.endsWith('_s1.json')), false, '不应留明文')

  const line = readSingleLine(join(historyDir, enc!))
  assert.ok(line.startsWith('SEMA1:k1:'))
  assert.equal(line.includes(SECRET), false)
  assert.equal(JSON.parse(decryptLine(KEY, line).toString('utf8')).version, 2)
  const jsonl = getHistoryStore('s1', project).messagePath
  assert.deepEqual(readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(decryptLine(KEY, l).toString('utf8'))), messages)

  const loaded = await loadHistory('s1', project)
  assert.deepEqual(loaded.messages, messages)
})

test('升级迁移：升级前的明文历史能打开，下一次保存写成密文并删除明文', async () => {
  const plain = join(historyDir, 's2.json')
  writeFile(plain, JSON.stringify({ messages: messages.slice(0, 1), todos: [] }))

  const before = resolveHistoryFile('s2', project)
  assert.equal(before.encrypted, false)
  assert.equal(before.noDate, true)
  assert.deepEqual((await loadHistory('s2', project)).messages, messages.slice(0, 1))

  await saveHistory('s2', messages, [], project, undefined, undefined, true)
  assert.equal(existsSync(plain), false, '明文应被删除')
  assert.equal(existsSync(join(historyDir, 's2.meta.json.enc')), true)
  assert.deepEqual((await loadHistory('s2', project)).messages, messages)
})

test('跨天恢复：按会话 id 扫到旧日期的 .json.enc，保存仍写回原文件', async () => {
  const old = join(historyDir, '2020-01-01_s3.json.enc')
  writeFile(old, encryptLine(KEY, JSON.stringify({ messages: messages.slice(0, 1), todos: [] }), 'k1') + '\n')

  const resolved = resolveHistoryFile('s3', project)
  assert.equal(resolved.path, old)
  assert.equal(resolved.encrypted, true)
  assert.equal(resolved.noDate, false)
  assert.deepEqual((await loadHistory('s3', project)).messages, messages.slice(0, 1))

  await saveHistory('s3', messages, [], project, undefined, undefined, false)
  assert.deepEqual(listHistory().filter(f => f.includes('s3') && !f.endsWith('.lock')).sort(), ['2020-01-01_s3.jsonl.enc', '2020-01-01_s3.meta.json.enc'])
})

test('重装后密钥换了：打开旧会话报 HISTORY_DECRYPT_FAILED，文件原样保留，不会被当空会话覆盖', async () => {
  const file = join(historyDir, 's4.json.enc')
  const content = encryptLine(OTHER_KEY, JSON.stringify({ messages, todos: [] })) + '\n'
  writeFile(file, content)

  await rejectsWithCode(loadHistory('s4', project), 'HISTORY_DECRYPT_FAILED')
  assert.equal(readFileSync(file, 'utf8'), content)
})

test('快照：blob 与 editlog 都是密文，撤销时能读回；清理按明文名识别，解不开的一律不删', () => {
  const original = Buffer.from('function old() {}\n')
  const hash = snap.writeBlob(original, project)
  assert.equal(hash, createHash('sha256').update(original).digest('hex'), 'hash 按明文算')
  assert.equal(existsSync(join(snapDir, 'blobs', hash + '.enc')), true)
  assert.equal(existsSync(join(snapDir, 'blobs', hash)), false)
  assert.equal(readFileSync(join(snapDir, 'blobs', hash + '.enc'), 'utf8').includes('function old'), false)
  assert.deepEqual(snap.readBlob(hash, project), original)

  const records = [{ turn: 1, file: 'a.ts', blobHash: hash }] as any
  snap.saveEditLog('s1', records, project)
  assert.equal(existsSync(join(snapDir, 's1.editlog.json.enc')), true)
  assert.deepEqual(snap.loadEditLog('s1', project), records)

  // 已退场会话的 editlog 和无引用 blob 被回收，存活会话（s1 的历史还在）引用的 blob 保留
  snap.saveEditLog('ghost', [{ turn: 1, file: 'b.ts', blobHash: 'deadbeef' }] as any, project)
  const orphan = snap.writeBlob(Buffer.from('orphan'), project)
  snap.cleanupProjectSnapshots(project)
  assert.equal(existsSync(join(snapDir, 'ghost.editlog.json.enc')), false)
  assert.equal(existsSync(join(snapDir, 'blobs', orphan + '.enc')), false)
  assert.equal(existsSync(join(snapDir, 'blobs', hash + '.enc')), true)
  assert.equal(existsSync(join(snapDir, 's1.editlog.json.enc')), true)
})

test('子代理也保存完整逐行密文，不生成额外主 transcript', () => {
  const store = getHistoryStore('s1', project)
  store.saveAgent('actual-task-id', messages)
  const agentPath = store.agentPath('actual-task-id')
  assert.ok(agentPath.endsWith('/actual-task-id.jsonl.enc'))
  assert.deepEqual(readFileSync(agentPath, 'utf8').trim().split('\n').map(l => JSON.parse(decryptLine(KEY, l).toString('utf8'))), messages)
  assert.equal(readFileSync(agentPath, 'utf8').includes(SECRET), false)
})

test('删除会话：.json.enc 与同主干的 .jsonl.enc 一起删掉', () => {
  assert.equal(listHistory().some(f => f.includes('_s1.')), true)
  deleteSessionHistory('s1', project)
  assert.deepEqual(listHistory().filter(f => f.includes('_s1.')), [])
})

test('密文追加不重加密旧行，重写中断后以同一密钥恢复完整文件组', () => {
  const { HistoryStore, __historyTestHooks } = require('../../src/util/historyStore') as typeof import('../../src/util/historyStore')
  const store = new HistoryStore(join(historyDir, 'enc-recover'), 'enc-recover')
  store.save({ messages: messages.slice(0, 1), todos: [] })
  const prefix = readFileSync(store.messagePath)
  store.save({ messages, todos: [] })
  assert.deepEqual(readFileSync(store.messagePath).subarray(0, prefix.length), prefix)
  __historyTestHooks.afterStep = at => { if (at === 'rewrite:messages') throw new Error('exit') }
  try { assert.throws(() => store.save({ messages: [], todos: [] }, true), /exit/) }
  finally { __historyTestHooks.afterStep = undefined; store.close() }
  const reopened = new HistoryStore(store.stem, store.sessionId)
  assert.deepEqual(reopened.load().messages, [])
  assert.equal(existsSync(store.stem + '.rewrite.json.enc'), false)
  assert.equal(listHistory().some(f => f.startsWith('enc-recover.') && !f.endsWith('.enc') && !f.endsWith('.lock')), false)
  reopened.close()
})

test('v2 已提交消息换钥或被破坏时报错，不删除密文或回退旧格式', async () => {
  const { closeHistory } = require('../../src/util/history') as typeof import('../../src/util/history')
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  saveHistory('v2-wrong-key', messages.slice(0, 1), [], project, undefined, undefined, true)
  const store = getHistoryStore('v2-wrong-key', project)
  const file = store.messagePath
  closeHistory('v2-wrong-key', project)
  const wrong = encryptLine(OTHER_KEY, JSON.stringify(messages[0]), 'k1') + '\n'
  writeFileSync(file, wrong)
  await rejectsWithCode(loadHistory('v2-wrong-key', project), 'HISTORY_DECRYPT_FAILED')
  assert.equal(readFileSync(file, 'utf8'), wrong)
})
