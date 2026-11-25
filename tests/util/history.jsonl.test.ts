import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isolate, writeFile } from '../helpers/isolate'
import type { Message } from '../../src/types/message'

const { project, root } = isolate('history-jsonl')
const { HistoryStore, __historyTestHooks, tryLockHistory, releaseLock } = require('../../src/util/historyStore') as typeof import('../../src/util/historyStore')
const { getProjectHistoryDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')
const { loadHistory, saveHistory, closeHistory, resolveHistoryFile, deleteSessionHistory, deleteProjectHistory } = require('../../src/util/history') as typeof import('../../src/util/history')
const { historySessionIds } = require('../../src/util/historyFiles') as typeof import('../../src/util/historyFiles')
const dir = getProjectHistoryDir(project)
const message = (uuid: string, content = uuid): Message => ({ type: 'user', uuid: uuid as any, message: { role: 'user', content } })
const exitedPid = (): number => spawnSync(process.execPath, ['-e', '']).pid as number
const data = (messages: Message[]) => ({ messages, todos: [] })
const meta = (stem: string) => JSON.parse(readFileSync(stem + '.meta.json', 'utf8'))

test('append serializes only new messages; metadata-only and repeat saves leave message bytes untouched', () => {
  const store = new HistoryStore(join(dir, 'append'), 'append')
  let serializations = 0
  const first = message('1', '大'.repeat(100_000))
  Object.defineProperty(first, 'toJSON', { value() { serializations++; return { type: first.type, uuid: first.uuid, message: first.message } } })
  store.save(data([first]))
  const before = readFileSync(store.messagePath)
  const second = message('2', '含\n换行和 Unicode 😀')
  store.save(data([first, second]))
  assert.equal(serializations, 1)
  assert.deepEqual(readFileSync(store.messagePath).subarray(0, before.length), before)
  const inode = statSync(store.messagePath).ino
  const revision = meta(store.stem).revision
  store.save(data([first, second]))
  assert.equal(meta(store.stem).revision, revision)
  const mtime = statSync(store.messagePath).mtimeMs
  store.save({ ...data([first, second]), readFileTimestamps: { '/file': 42 } })
  assert.equal(statSync(store.messagePath).ino, inode)
  assert.equal(statSync(store.messagePath).mtimeMs, mtime)
  assert.equal(serializations, 1)
  assert.equal(meta(store.stem).committedBytes, statSync(store.messagePath).size)
  assert.equal(meta(store.stem).historyEpoch, 1)
  store.close()
})

test('same UUID and count with changed content rewrites; empty history is a real commit', () => {
  const store = new HistoryStore(join(dir, 'micro'), 'micro')
  store.save(data([message('same', 'large tool result')]))
  store.save(data([message('same', '<cleared>')]))
  assert.equal(meta(store.stem).historyEpoch, 2)
  assert.deepEqual(store.load().messages, [message('same', '<cleared>')])
  store.save(data([]))
  assert.equal(meta(store.stem).messageCount, 0)
  assert.equal(meta(store.stem).lastMessageUuid, null)
  assert.deepEqual(store.load().messages, [])
  store.close()
})

test('resume initializes append cursor without duplicating old messages', () => {
  const stem = join(dir, 'resume')
  const first = new HistoryStore(stem, 'resume')
  first.save(data([message('1')]))
  first.close()
  const reopened = new HistoryStore(stem, 'resume')
  const loaded = reopened.load()
  reopened.save(data([...loaded.messages, message('2')]))
  assert.equal(meta(stem).historyEpoch, 1)
  assert.deepEqual(reopened.load().messages.map(m => m.uuid), ['1', '2'])
  reopened.close()
})

test('uncommitted full lines and partial tails are excluded, then removed before append', () => {
  const store = new HistoryStore(join(dir, 'tail'), 'tail')
  store.save(data([message('1')]))
  appendFileSync(store.messagePath, JSON.stringify(message('uncommitted')) + '\n{"half":')
  const loaded = store.load()
  assert.deepEqual(loaded.messages.map(m => m.uuid), ['1'])
  store.save(data([...loaded.messages, message('2')]))
  assert.deepEqual(store.load().messages.map(m => m.uuid), ['1', '2'])
  store.close()
})

for (const boundary of ['append:messages', 'append:meta']) {
  test(`failed ${boundary} can be retried without duplicate messages`, () => {
    const store = new HistoryStore(join(dir, boundary.replace(':', '-')), boundary)
    const one = message('1'), two = message('2')
    store.save(data([one]))
    __historyTestHooks.afterStep = at => { if (at === boundary) throw new Error('injected disk failure') }
    try { assert.throws(() => store.save(data([one, two])), /injected/) }
    finally { __historyTestHooks.afterStep = undefined }
    store.save(data([one, two]))
    assert.deepEqual(store.load().messages.map(m => m.uuid), ['1', '2'])
    store.close()
  })
}

for (const boundary of ['rewrite:intent', 'rewrite:messages', 'rewrite:meta']) {
  test(`rewrite recovers after ${boundary}, including interrupted empty-history replacement`, () => {
    const id = boundary.replace(':', '-')
    const store = new HistoryStore(join(dir, id), id)
    store.save(data([message('old')]))
    __historyTestHooks.afterStep = at => { if (at === boundary) throw new Error('injected exit') }
    try { assert.throws(() => store.save(data([]), true), /injected/) }
    finally { __historyTestHooks.afterStep = undefined; store.close() }
    const reopened = new HistoryStore(join(dir, id), id)
    assert.deepEqual(reopened.load().messages, [])
    assert.equal(existsSync(reopened.stem + '.rewrite.json'), false)
    assert.equal(readdirSync(dir).some(f => f.startsWith(id + '.txn-')), false)
    reopened.close()
  })
}

test('v1 migration replaces same-name transcript using the legacy JSON as authority', async () => {
  const stem = join(dir, '2020-01-01_legacy')
  writeFile(stem + '.json', JSON.stringify(data([message('valid')])))
  writeFile(stem + '.jsonl', JSON.stringify(message('reverted-old-transcript')) + '\n')
  const loaded = await loadHistory('legacy', project)
  saveHistory('legacy', [...loaded.messages, message('new')], [], project)
  assert.equal(resolveHistoryFile('legacy', project).stem, stem)
  assert.equal(existsSync(stem + '.json'), false)
  assert.deepEqual((await loadHistory('legacy', project)).messages.map(m => m.uuid), ['valid', 'new'])
  closeHistory('legacy', project)
})

test('committed corruption never falls back to stale v1 or overwrites it as an empty conversation', async () => {
  saveHistory('corrupt', [message('new')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('corrupt', project).stem
  closeHistory('corrupt', project)
  writeFile(stem + '.json', JSON.stringify(data([message('old')])) )
  truncateSync(stem + '.jsonl', 1)
  await assert.rejects(loadHistory('corrupt', project), { code: 'HISTORY_CORRUPT' })
  assert.equal(statSync(stem + '.jsonl').size, 1)
  assert.equal(existsSync(stem + '.json'), true)
})

test('invalid committed JSON is not silently skipped', () => {
  const store = new HistoryStore(join(dir, 'bad-line'), 'bad-line')
  store.save(data([message('a')]))
  const bytes = readFileSync(store.messagePath)
  bytes[0] = 33
  writeFileSync(store.messagePath, bytes)
  assert.throws(() => store.load(), { code: 'HISTORY_CORRUPT' })
  store.close()
})

test('subagents use their actual IDs, retain full images and cannot recreate files after clear', () => {
  const store = new HistoryStore(join(dir, 'children'), 'children')
  store.save(data([message('parent')]))
  assert.equal(existsSync(store.stem), false)
  const child = message('child')
  child.message.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'encoded-image' } }]
  store.saveAgent('real-task_ID', [child])
  store.saveAgent('other-task_ID', [message('other')])
  assert.deepEqual(readdirSync(store.stem).sort(), ['other-task_ID.jsonl', 'real-task_ID.jsonl'])
  assert.deepEqual(JSON.parse(readFileSync(store.agentPath('real-task_ID'), 'utf8')), child)
  store.clearAgents()
  store.saveAgent('real-task_ID', [child, message('late')])
  assert.equal(existsSync(store.stem), false)
  store.saveAgent('new-task_ID', [message('new child')])
  assert.equal(existsSync(store.agentPath('new-task_ID')), true)
  store.close()
})

test('ownership discovery groups v1/v2/encryption/transactions into logical session IDs', () => {
  assert.deepEqual([...historySessionIds(['2026-11-25_s.meta.json', '2026-11-25_s.json', '2026-11-25_s.meta.json.enc', 'fixed.rewrite.json.enc', 'fixed.txn-1.meta.tmp', 's.attachments'])].sort(), ['fixed', 's'])
})

test('delete removes the child directory together with both main files', () => {
  saveHistory('delete-tree', [message('1')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('delete-tree', project).stem
  writeFile(join(stem, 'real-agent.jsonl'), JSON.stringify(message('child')) + '\n')
  deleteSessionHistory('delete-tree', project)
  assert.equal(existsSync(stem), false)
  assert.equal(existsSync(stem + '.jsonl'), false)
  assert.equal(existsSync(stem + '.meta.json'), false)
})

test('another live writer is rejected rather than interleaving appends', () => {
  const stem = join(dir, 'locked')
  const first = new HistoryStore(stem, 'locked')
  first.save(data([message('1')]))
  const second = new HistoryStore(stem, 'locked')
  assert.throws(() => second.load(), { code: 'HISTORY_BUSY' })
  first.close()
})

test('real process exit during rewrite recovers with a stale process lock', () => {
  const stem = join(dir, 'process-exit')
  const store = new HistoryStore(stem, 'process-exit')
  store.save(data([message('old')]))
  store.close()
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/historyCrash.ts'), stem], { env: { ...process.env, SEMA_ROOT: root }, encoding: 'utf8' })
  assert.equal(result.status, 37, result.stderr)
  const reopened = new HistoryStore(stem, 'process-exit')
  assert.deepEqual(reopened.load().messages.map(m => m.uuid), ['replacement'])
  reopened.close()
})

test('deletion reclaims a lock left by an exited process instead of keeping the files', () => {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  saveHistory('dead-lock', [message('1')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('dead-lock', project).stem
  closeHistory('dead-lock', project)
  writeFile(stem + '.lock', JSON.stringify({ pid, token: 'dead' }))
  deleteSessionHistory('dead-lock', project)
  assert.equal(existsSync(stem + '.jsonl'), false)
  assert.equal(existsSync(stem + '.meta.json'), false)
  assert.equal(existsSync(stem + '.lock'), false)
})

test('a lock held by a live writer still keeps the history', () => {
  const stem = join(dir, 'live-lock')
  const store = new HistoryStore(stem, 'live-lock')
  store.save(data([message('1')]))
  deleteSessionHistory('live-lock', project)
  assert.equal(existsSync(stem + '.jsonl'), true)
  store.close()
})

test('project deletion reclaims stale locks instead of reporting the project in use', () => {
  const other = join(root, 'stale-project')
  mkdirSync(join(other, '.sema'), { recursive: true })
  saveHistory('stale', [message('1')], [], other, undefined, undefined, true)
  const stem = resolveHistoryFile('stale', other).stem
  closeHistory('stale', other)
  writeFile(stem + '.lock', JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, token: 'dead' }))
  deleteProjectHistory(other)
  assert.equal(existsSync(getProjectHistoryDir(other)), false)
})

test('a crashed writer leaves nothing behind that blocks deleting its session', () => {
  const stem = join(dir, 'crash-delete')
  const store = new HistoryStore(stem, 'crash-delete')
  store.save(data([message('old')]))
  store.close()
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/historyCrash.ts'), stem, 'crash-delete'], { env: { ...process.env, SEMA_ROOT: root }, encoding: 'utf8' })
  assert.equal(result.status, 37, result.stderr)
  assert.equal(existsSync(stem + '.lock'), true)
  assert.equal(existsSync(stem + '.rewrite.json'), true)
  deleteSessionHistory('crash-delete', project)
  assert.equal(existsSync(stem + '.jsonl'), false)
  assert.equal(existsSync(stem + '.meta.json'), false)
  assert.equal(existsSync(stem + '.rewrite.json'), false)
  assert.equal(existsSync(stem + '.lock'), false)
})

test('an empty lock left by a dead publisher is reclaimed on load and on delete', () => {
  const store = new HistoryStore(join(dir, 'empty-lock'), 'empty-lock')
  store.save(data([message('1')]))
  store.close()
  const stem = store.stem
  writeFile(stem + '.lock', '')
  const reopened = new HistoryStore(stem, 'empty-lock')
  assert.deepEqual(reopened.load().messages.map(m => m.uuid), ['1'])
  reopened.close()
  writeFile(stem + '.lock', '')
  deleteSessionHistory('empty-lock', project)
  assert.equal(existsSync(stem + '.jsonl'), false)
  assert.equal(existsSync(stem + '.lock'), false)
})

test('a lock taken over while being reclaimed keeps its files', () => {
  saveHistory('taken-over', [message('1')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('taken-over', project).stem
  closeHistory('taken-over', project)
  const lock = stem + '.lock'
  writeFile(lock, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, token: 'dead' }))
  // 判定属主已退出之后、回收之前，另一个进程接替了这个会话
  __historyTestHooks.beforeLockReclaim = file => writeFile(file, JSON.stringify({ pid: process.pid, token: 'taken' }))
  try { deleteSessionHistory('taken-over', project) }
  finally { __historyTestHooks.beforeLockReclaim = undefined }
  assert.equal(existsSync(stem + '.jsonl'), true)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'taken')
})

test('a reclaim in progress holds the session against other reclaimers', () => {
  saveHistory('guarded', [message('1')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('guarded', project).stem
  closeHistory('guarded', project)
  const lock = stem + '.lock'
  writeFile(lock, JSON.stringify({ pid: exitedPid(), token: 'dead' }))
  writeFile(lock + '.reclaim', JSON.stringify({ pid: process.pid, token: 'guard' }))
  deleteSessionHistory('guarded', project)
  assert.equal(existsSync(stem + '.jsonl'), true)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'dead')
})

test('a reclaim guard left by an exited process is taken over', () => {
  saveHistory('guarded-dead', [message('1')], [], project, undefined, undefined, true)
  const stem = resolveHistoryFile('guarded-dead', project).stem
  closeHistory('guarded-dead', project)
  const lock = stem + '.lock'
  writeFile(lock, JSON.stringify({ pid: exitedPid(), token: 'dead' }))
  writeFile(lock + '.reclaim', JSON.stringify({ pid: exitedPid(), token: 'guard' }))
  deleteSessionHistory('guarded-dead', project)
  assert.equal(existsSync(stem + '.jsonl'), false)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(lock + '.reclaim'), false)
})

test('competing recovery of a dead guard never gives two writers a lock', t => {
  const fs = require('node:fs') as typeof import('node:fs')
  const stem = join(dir, 'guard-race')
  const lock = stem + '.lock'
  const guard = lock + '.reclaim'
  const pid = exitedPid()
  writeFile(lock, JSON.stringify({ pid, token: 'dead-writer' }))
  writeFile(guard, JSON.stringify({ pid, token: 'dead-reclaimer' }))
  const rename = fs.renameSync
  const unlink = fs.unlinkSync
  let competed = false
  let moved = false
  let duringB = false
  let modifyGuard: (() => void) | undefined
  const acquired: string[] = []
  const acquire = () => {
    const token = tryLockHistory(stem)
    if (token) acquired.push(token)
  }
  const compete = (modify: () => void) => {
    // A paused immediately before modifying the stale guard. Let B try to take it.
    competed = true
    modifyGuard = modify
    duringB = true
    try { acquire() } finally { duringB = false }
    if (!moved) modify()
  }
  t.mock.method(fs, 'renameSync', (source: string, target: string) => {
    if (source === guard && !competed) return compete(() => rename(source, target))
    return rename(source, target)
  })
  t.mock.method(fs, 'unlinkSync', (file: string) => {
    if (file === guard && !competed) return compete(() => unlink(file))
    if (file === lock && duringB && !moved) {
      // B passed its final lock check. A must not displace B's guard and let C in.
      moved = true
      modifyGuard!()
      acquire()
    }
    return unlink(file)
  })
  try {
    acquire()
    assert.equal(competed, true)
    assert.equal(acquired.length, 1, 'only one of A, B and C may acquire the writer lock')
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, acquired[0])
    assert.equal(tryLockHistory(stem), null, 'the winning writer remains protected')
  } finally {
    t.mock.restoreAll()
    for (const token of acquired) releaseLock(lock, token)
  }
})

for (const boundary of ['before', 'after']) {
  test(`recovery survives a process exit ${boundary} removing a dead reclaim guard`, () => {
    const id = `guard-crash-${boundary}`
    const stem = join(dir, id)
    const store = new HistoryStore(stem, id)
    store.save(data([message('preserved')]))
    store.close()
    const pid = exitedPid()
    writeFile(stem + '.lock', JSON.stringify({ pid, token: 'dead-writer' }))
    writeFile(stem + '.lock.reclaim', JSON.stringify({ pid, token: 'dead-reclaimer' }))
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/historyLockCrash.ts'), stem, boundary], {
      env: { ...process.env, SEMA_ROOT: root }, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 38, result.stderr)
    const reopened = new HistoryStore(stem, id)
    try {
      assert.deepEqual(reopened.load().messages.map(m => m.uuid), ['preserved'])
      assert.throws(() => new HistoryStore(stem, id).load(), { code: 'HISTORY_BUSY' })
    } finally { reopened.close() }
    deleteSessionHistory(id, project)
    assert.equal(existsSync(stem + '.jsonl'), false)
  })
}

test('unsupported hard links fail without publishing an incomplete lock', t => {
  const fs = require('node:fs') as typeof import('node:fs')
  const stem = join(dir, 'unsupported-lock')
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) })
  assert.throws(() => tryLockHistory(stem), { code: 'HISTORY_WRITE_FAILED' })
  assert.equal(existsSync(stem + '.lock'), false)
})

test('project deletion discards a rewrite transaction left by a crashed writer', () => {
  const other = join(root, 'crash-project')
  mkdirSync(join(other, '.sema'), { recursive: true })
  const stem = join(getProjectHistoryDir(other), 'crash-rewrite')
  const store = new HistoryStore(stem, 'crash-rewrite')
  store.save(data([message('old')]))
  store.close()
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/historyCrash.ts'), stem, 'crash-rewrite'], { env: { ...process.env, SEMA_ROOT: root }, encoding: 'utf8' })
  assert.equal(result.status, 37, result.stderr)
  assert.equal(existsSync(stem + '.rewrite.json'), true)
  deleteProjectHistory(other)
  assert.equal(existsSync(getProjectHistoryDir(other)), false)
})

test('cross-date orphan JSONL is reported instead of creating a second history', async () => {
  const stem = join(dir, '2020-01-01_orphan')
  writeFile(stem + '.jsonl', JSON.stringify(message('orphan')) + '\n')
  await assert.rejects(loadHistory('orphan', project), { code: 'HISTORY_CORRUPT' })
  assert.equal(resolveHistoryFile('orphan', project).stem, stem)
})

test('an unreadable entry in the directory scan is skipped instead of failing the lookup', { skip: process.platform === 'win32' }, () => {
  const stem = join(dir, '2020-01-02_readable')
  const store = new HistoryStore(stem, 'readable')
  store.save(data([message('1')]))
  store.close()
  const dangling = join(dir, '2099-01-01_readable.json')
  symlinkSync(join(dir, 'missing-target'), dangling)
  try { assert.equal(resolveHistoryFile('readable', project).stem, stem) }
  finally { unlinkSync(dangling) }
})

test('unpublished temporary files are reclaimed without changing committed data', () => {
  const store = new HistoryStore(join(dir, 'staged'), 'staged')
  store.save(data([message('valid')]))
  writeFile(store.stem + '.txn-abandoned.messages.tmp', 'incomplete')
  assert.deepEqual(store.load().messages.map(m => m.uuid), ['valid'])
  assert.equal(existsSync(store.stem + '.txn-abandoned.messages.tmp'), false)
  store.close()
})
