import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'

// /clear：对话清空立即落盘，本会话登记的附件随之清理
isolate('clear-command')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleCommand } = require('../../src/services/commands/runCommand') as typeof import('../../src/services/commands/runCommand')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getStateManager, MAIN_AGENT_ID } = require('../../src/manager/StateManager') as typeof import('../../src/manager/StateManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHistory } = require('../../src/util/history') as typeof import('../../src/util/history')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerAttachment } = require('../../src/util/attachmentLedger') as typeof import('../../src/util/attachmentLedger')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAttachmentsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')

const attachmentsDir = getAttachmentsDir()
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const exists = (id: string) => existsSync(join(attachmentsDir, id))

/** 建一个有一条消息的会话并落盘历史 */
async function sessionWithHistory(sessionId: string): Promise<void> {
  const runtime = getStateManager().session(sessionId)
  runtime.forAgent(MAIN_AGENT_ID).setMessageHistory([
    { type: 'user', uuid: `${sessionId}-u1`, message: { role: 'user', content: '画一张深色版' } },
  ] as any[])
  await runtime.saveSessionHistory()
}

function attachmentFor(sessionId: string, id: string): void {
  const file = join(attachmentsDir, id, 'image.png')
  writeFile(file, 'x')
  registerAttachment(sessionId, file)
}

test('/clear 后磁盘上的历史立即为空', async () => {
  await sessionWithHistory('c1')
  assert.equal((await loadHistory('c1')).messages.length, 1)

  await handleCommand('/clear', 'c1')
  assert.equal((await loadHistory('c1')).messages.length, 0)
})

test('/clear 清掉本会话登记的附件，其他会话还登记着的保留', async () => {
  await sessionWithHistory('c2')
  await sessionWithHistory('c3')
  attachmentFor('c2', ID(1))
  attachmentFor('c2', ID(2))
  // ID(2) 同时被另一个会话登记（分支出去的会话）
  registerAttachment('c3', join(attachmentsDir, ID(2), 'image.png'))

  await handleCommand('/clear', 'c2')
  assert.equal(exists(ID(1)), false)
  assert.equal(exists(ID(2)), true)

  // 清空后新产生的附件重新登记，不受上一轮清理影响
  attachmentFor('c2', ID(3))
  assert.equal(exists(ID(3)), true)
  await handleCommand('/clear', 'c2')
  assert.equal(exists(ID(3)), false)
})
