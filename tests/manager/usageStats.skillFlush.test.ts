import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SEMA_ROOT 在首次 getSemaRootDir() 时缓存，必须在加载被测模块前设好；import 会被提升，故用 require 延后加载
const root = mkdtempSync(join(tmpdir(), 'sema-stats-'))
process.env.SEMA_ROOT = root

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UsageStatsManager } = require('../../src/manager/UsageStatsManager') as typeof import('../../src/manager/UsageStatsManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getEventBus } = require('../../src/events/EventSystem') as typeof import('../../src/events/EventSystem')

interface StatLine {
  tools: Record<string, { calls: number }>
  skills: Record<string, { calls: number }>
}

function readLines(product: string): StatLine[] {
  const dir = join(root, 'stats', product)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap(n =>
    readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as StatLine),
  )
}

const skillCalls = (product: string, title: string): number =>
  readLines(product).reduce((sum, l) => sum + (l.skills[title]?.calls ?? 0), 0)

/** 模拟 skill 工具完成时的 complete 事件（skill 明细只在这里记） */
const emitSkillComplete = (title: string): void => {
  getEventBus().emit('tool:execution:complete', {
    agentId: 'main', toolId: 't1', toolName: 'skill', title, summary: '', content: '',
  })
}

test('skill 等待期间已落盘一次，完成后读统计仍能看到它', async () => {
  const product = 'test-skill-read'
  const m = new UsageStatsManager()
  m.init(product)

  m.recordToolCall('skill')
  // skill 等权限超过 10s：定时器到点把这次调用先写走、清空账本（直接调落盘函数，省掉真等 10s）
  await (m as any).flushAsync()
  emitSkillComplete('commit')

  // 此刻账本里只有 skills，requests / tools 都空；读完不应丢
  const data = await m.getUsageStats({ product })
  const day = Object.keys(data.days)[0]
  assert.equal(data.days[day].skills.commit.calls, 1)
  m.dispose()
})

test('只有 skill 明细时 dispose 也会落盘', async () => {
  const product = 'test-skill-dispose'
  const m = new UsageStatsManager()
  m.init(product)

  m.recordToolCall('skill')
  await (m as any).flushAsync()
  emitSkillComplete('weekly-report')

  m.dispose()
  assert.equal(skillCalls(product, 'weekly-report'), 1)
})
