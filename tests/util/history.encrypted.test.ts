import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, KEY, OTHER_KEY, rejectsWithCode } from '../helpers/isolate'

// 本进程传了 encryption（keyId 'k1'），并配一条 host hook 让 hook 会话记录（transcript）开启写入
const { project } = isolate('history-enc')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
setHostConfig({ encryption: { key: KEY, keyId: 'k1' }, hooks: { Stop: [{ hooks: [{ command: 'true' }] }] } })
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateInitialCwd } = require('../../src/util/cwd') as typeof import('../../src/util/cwd')
updateInitialCwd(project)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptLine, decryptLine } = require('../../src/util/cipher') as typeof import('../../src/util/cipher')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHistory, saveHistory, resolveHistoryFile, deleteSessionHistory } = require('../../src/util/history') as typeof import('../../src/util/history')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snap = require('../../src/util/snapshotStore') as typeof import('../../src/util/snapshotStore')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TranscriptWriter, isTranscriptEnabled } = require('../../src/util/transcript') as typeof import('../../src/util/transcript')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHooksManager } = require('../../src/services/hooks/hooksManager') as typeof import('../../src/services/hooks/hooksManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProjectHistoryDir, getProjectSnapshotsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MAIN_AGENT_ID } = require('../../src/manager/StateManager') as typeof import('../../src/manager/StateManager')

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

test('新会话保存：磁盘上只有 .json.enc，一行密文，skill 正文不以明文出现，读回与保存一致', async () => {
  await saveHistory('s1', messages, [], project, undefined, undefined, false)

  const files = listHistory()
  const enc = files.find(f => f.endsWith('_s1.json.enc'))
  assert.ok(enc, `应有带日期的 .json.enc：${files.join(', ')}`)
  assert.equal(files.some(f => f.endsWith('_s1.json')), false, '不应留明文')

  const line = readSingleLine(join(historyDir, enc!))
  assert.ok(line.startsWith('SEMA1:k1:'))
  assert.equal(line.includes(SECRET), false)
  assert.deepEqual(JSON.parse(decryptLine(KEY, line).toString('utf8')).messages, messages)

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
  assert.equal(existsSync(plain + '.enc'), true)
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
  assert.deepEqual(listHistory().filter(f => f.includes('s3')), ['2020-01-01_s3.json.enc'])
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

test('hook 会话记录：.jsonl.enc 每行一条密文，hook 程序用同一把密钥逐行可解；升级前的明文记录被清掉', async () => {
  await getHooksManager().ready()
  assert.equal(isTranscriptEnabled(), true, 'host hook 应让 transcript 开启')

  const writer = new TranscriptWriter('s1')
  const encPath = writer.getPath(project, false)
  assert.ok(encPath.endsWith('_s1.jsonl.enc'), encPath)
  const plainPath = encPath.slice(0, -'.enc'.length)
  writeFile(plainPath, '{"old":"plain"}\n')

  writer.sync(MAIN_AGENT_ID, messages, project, false)

  assert.equal(existsSync(plainPath), false, '旧明文应被删除')
  const lines = readFileSync(encPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, messages.length)
  const decoded = lines.map(l => JSON.parse(decryptLine(KEY, l).toString('utf8')))
  assert.deepEqual(decoded.map(d => d.uuid), ['u1', 'a1', 'u2'])
  assert.equal(decoded[2].message.content[1].text.includes(SECRET), true)
  assert.equal(readFileSync(encPath, 'utf8').includes(SECRET), false)
})

test('删除会话：.json.enc 与同主干的 .jsonl.enc 一起删掉', () => {
  assert.equal(listHistory().some(f => f.includes('_s1.')), true)
  deleteSessionHistory('s1', project)
  assert.deepEqual(listHistory().filter(f => f.includes('_s1.')), [])
})
