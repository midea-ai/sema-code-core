import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'

// 附件归属清单：写入时登记、跟随会话退场、期限兜底、体积上限
const { root, project } = isolate('attachment-ledger')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ledger = require('../../src/util/attachmentLedger') as typeof import('../../src/util/attachmentLedger')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deleteSessionHistory, deleteProjectHistory } = require('../../src/util/history') as typeof import('../../src/util/history')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProjectHistoryDir, getAttachmentsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')

const attachmentsDir = getAttachmentsDir()
const historyDir = getProjectHistoryDir(project)
const otherProject = join(root, 'other-project')
const otherHistoryDir = getProjectHistoryDir(otherProject)

const DAY = 24 * 60 * 60 * 1000
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LIMITS = { retainCount: 100, retainMs: 30 * DAY, maxBytes: 1024 * 1024 * 1024, emptyDirTtl: 60 * 60 * 1000 }

/** 每个用例从空的附件目录和历史目录开始 */
function reset(): void {
  for (const dir of [attachmentsDir, historyDir, otherHistoryDir]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
}

/** 建一个附件目录并写入一个文件，返回文件路径；ageMs 把目录修改时间拨到这么久以前 */
function attachment(id: string, opts: { bytes?: number; ageMs?: number; name?: string } = {}): string {
  const file = join(attachmentsDir, id, opts.name ?? 'image.png')
  writeFile(file, 'x'.repeat(opts.bytes ?? 10))
  if (opts.ageMs) {
    const when = new Date(Date.now() - opts.ageMs)
    utimesSync(join(attachmentsDir, id), when, when)
  }
  return file
}

function history(dir: string, sessionId: string): void {
  writeFile(join(dir, `2026-01-01_${sessionId}.json`), '{"messages":[],"todos":[]}')
}

const ledgerLines = (dir: string, sessionId: string) => readFileSync(join(dir, `${sessionId}.attachments`), 'utf8').split('\n').filter(Boolean)
const exists = (id: string) => existsSync(join(attachmentsDir, id))

test('登记：附件目录下的文件记入会话清单，重复不追加，其他路径忽略', () => {
  reset()
  const file = attachment(ID(1))
  ledger.registerAttachment('s1', file, project)
  ledger.registerAttachment('s1', file, project)
  ledger.registerAttachment('s1', join(attachmentsDir, ID(1), 'image-2.png'), project)
  ledger.registerAttachment('s1', join(project, 'src', 'index.ts'), project)
  ledger.registerAttachment('s1', join(attachmentsDir, 'not-an-id', 'x.txt'), project)
  assert.deepEqual(ledgerLines(historyDir, 's1'), [ID(1)])

  // 没用到附件的会话不产生清单文件
  ledger.registerAttachment('s2', join(project, 'README.md'), project)
  assert.equal(existsSync(join(historyDir, 's2.attachments')), false)
})

test('删除会话：附件一起删，清单文件随之删除', () => {
  reset()
  ledger.registerAttachment('s1', attachment(ID(1)), project)
  ledger.registerAttachment('s1', attachment(ID(2)), project)
  history(historyDir, 's1')

  deleteSessionHistory('s1', project)
  assert.equal(exists(ID(1)), false)
  assert.equal(exists(ID(2)), false)
  assert.deepEqual(readdirSync(historyDir), [])
})

test('分支会话：复制清单后，原会话删除不带走仍被登记的附件', () => {
  reset()
  ledger.registerAttachment('a', attachment(ID(1)), project)
  ledger.registerAttachment('a', attachment(ID(2)), project)
  history(historyDir, 'a')

  ledger.copyAttachmentLedger('a', 'b', project)
  ledger.registerAttachment('b', attachment(ID(3)), project)
  history(historyDir, 'b')
  assert.deepEqual(ledgerLines(historyDir, 'b'), [ID(1), ID(2), ID(3)])

  deleteSessionHistory('a', project)
  assert.deepEqual([ID(1), ID(2), ID(3)].map(exists), [true, true, true])

  deleteSessionHistory('b', project)
  assert.deepEqual([ID(1), ID(2), ID(3)].map(exists), [false, false, false])
})

test('历史文件还在时不清附件', () => {
  reset()
  ledger.registerAttachment('s1', attachment(ID(1)), project)
  history(historyDir, 's1')
  ledger.releaseSessionAttachments(historyDir, ['s1'])
  assert.equal(exists(ID(1)), true)
  assert.deepEqual(ledgerLines(historyDir, 's1'), [ID(1)])
})

test('删除项目：该项目所有会话的附件一起删，其他项目登记过的保留', () => {
  reset()
  ledger.registerAttachment('s1', attachment(ID(1)), project)
  ledger.registerAttachment('s2', attachment(ID(2)), project)
  history(historyDir, 's1')
  history(historyDir, 's2')
  // 另一个项目的会话引用过 ID(2)
  ledger.registerAttachment('x1', join(attachmentsDir, ID(2), 'image.png'), otherProject)
  history(otherHistoryDir, 'x1')

  deleteProjectHistory(project)
  assert.equal(exists(ID(1)), false)
  assert.equal(exists(ID(2)), true)
  assert.equal(existsSync(historyDir), false)
})

// 目录设为只读来模拟"历史文件被占用 / 无权限删不掉"；Windows 的 chmod 不限制删除，root 不受权限约束，这两种环境跳过
const canBlockDelete = process.platform !== 'win32' && process.getuid?.() !== 0

test('删除项目：历史目录删不掉时，附件和清单原样保留', { skip: !canBlockDelete }, () => {
  reset()
  ledger.registerAttachment('s1', attachment(ID(1)), project)
  history(historyDir, 's1')

  chmodSync(historyDir, 0o555)
  try {
    deleteProjectHistory(project)
  } finally {
    chmodSync(historyDir, 0o755)
  }
  assert.equal(existsSync(join(historyDir, '2026-01-01_s1.json')), true)
  assert.equal(exists(ID(1)), true)
  assert.deepEqual(ledgerLines(historyDir, 's1'), [ID(1)])

  // 权限恢复后再删，附件随之删除
  deleteProjectHistory(project)
  assert.equal(existsSync(historyDir), false)
  assert.equal(exists(ID(1)), false)
})

test('期限兜底：未登记、超过期限且排在保留个数之外才删，已登记的不删', () => {
  reset()
  attachment(ID(1), { ageMs: 1 * DAY })
  attachment(ID(2), { ageMs: 40 * DAY })   // 未登记，旧，排名第 2：在保留个数内
  attachment(ID(3), { ageMs: 50 * DAY })   // 未登记，旧，排名第 3：删
  attachment(ID(4), { ageMs: 60 * DAY })   // 已登记，旧，排名第 4：留
  ledger.registerAttachment('s1', join(attachmentsDir, ID(4), 'image.png'), project)
  history(historyDir, 's1')

  ledger.evictAttachments({ ...LIMITS, retainCount: 2 })
  assert.deepEqual([ID(1), ID(2), ID(3), ID(4)].map(exists), [true, true, false, true])
})

test('期限兜底：期限内的未登记附件即使排在保留个数之外也不删', () => {
  reset()
  attachment(ID(1), { ageMs: 1 * DAY })
  attachment(ID(2), { ageMs: 2 * DAY })
  attachment(ID(3), { ageMs: 3 * DAY })
  ledger.evictAttachments({ ...LIMITS, retainCount: 1 })
  assert.deepEqual([ID(1), ID(2), ID(3)].map(exists), [true, true, true])
})

test('空目录：超过保留时长删除，刚建的保留', () => {
  reset()
  mkdirSync(join(attachmentsDir, ID(1)))
  mkdirSync(join(attachmentsDir, ID(2)))
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(join(attachmentsDir, ID(1)), old, old)
  ledger.evictAttachments(LIMITS)
  assert.deepEqual([ID(1), ID(2)].map(exists), [false, true])
})

test('体积上限：从最旧的删起，先删未登记的，不够再删已登记的', () => {
  reset()
  attachment(ID(1), { bytes: 400, ageMs: 4 * DAY })   // 已登记，最旧
  attachment(ID(2), { bytes: 400, ageMs: 3 * DAY })   // 未登记
  attachment(ID(3), { bytes: 400, ageMs: 2 * DAY })   // 未登记
  attachment(ID(4), { bytes: 400, ageMs: 1 * DAY })   // 已登记，最新
  ledger.registerAttachment('s1', join(attachmentsDir, ID(1), 'image.png'), project)
  ledger.registerAttachment('s1', join(attachmentsDir, ID(4), 'image.png'), project)
  history(historyDir, 's1')

  // 1600 → 上限 1000：删两个未登记的即回到 800
  ledger.evictAttachments({ ...LIMITS, maxBytes: 1000 })
  assert.deepEqual([ID(1), ID(2), ID(3), ID(4)].map(exists), [true, false, false, true])

  // 800 → 上限 500：未登记的已删完，轮到已登记里最旧的
  ledger.evictAttachments({ ...LIMITS, maxBytes: 500 })
  assert.deepEqual([ID(1), ID(4)].map(exists), [false, true])
})

test('无历史的清单：超过保留时长视为无效并删除，期限内的照常保护附件', () => {
  reset()
  attachment(ID(1), { ageMs: 40 * DAY })
  attachment(ID(2), { ageMs: 41 * DAY })
  ledger.registerAttachment('stale', join(attachmentsDir, ID(1), 'image.png'), project)
  ledger.registerAttachment('fresh', join(attachmentsDir, ID(2), 'image.png'), project)
  const old = new Date(Date.now() - 2 * DAY)
  utimesSync(join(historyDir, 'stale.attachments'), old, old)

  ledger.evictAttachments({ ...LIMITS, retainCount: 0 })
  assert.equal(existsSync(join(historyDir, 'stale.attachments')), false)
  assert.equal(exists(ID(1)), false)
  assert.equal(exists(ID(2)), true)
})

test('附件根目录下非附件形状的条目不受兜底影响', () => {
  reset()
  writeFileSync(join(attachmentsDir, 'notes.txt'), 'keep')
  mkdirSync(join(attachmentsDir, 'custom-folder'))
  const old = new Date(Date.now() - 90 * DAY)
  utimesSync(join(attachmentsDir, 'custom-folder'), old, old)
  ledger.evictAttachments({ ...LIMITS, retainCount: 0, maxBytes: 0 })
  assert.deepEqual(readdirSync(attachmentsDir).sort(), ['custom-folder', 'notes.txt'])
})
