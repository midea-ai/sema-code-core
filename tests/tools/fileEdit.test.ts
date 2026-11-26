import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'

/**
 * 编辑工具（patch_file / write_file / view_file）的行为验收清单。
 *
 * 每个用例断言的是"应有行为"：修复前红、修复后绿。
 * P1 = 立刻修的小改动；P2 = 需要设计的中等改动（失败诊断）。
 */
const { root, project } = isolate('file-edit')

// SEMA_ROOT 在首次 getSemaRootDir() 时缓存，必须在加载被测模块前设好；import 会被提升，故用 require 延后加载
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyEdit, findOccurrences, normalizeLF } = require('../../src/util/edit') as typeof import('../../src/util/edit')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PatchFile } = require('../../src/tools/PatchFile') as typeof import('../../src/tools/PatchFile')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WriteFile } = require('../../src/tools/WriteFile') as typeof import('../../src/tools/WriteFile')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ViewFile } = require('../../src/tools/ViewFile') as typeof import('../../src/tools/ViewFile')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getStateManager } = require('../../src/manager/StateManager') as typeof import('../../src/manager/StateManager')

const ctx = { sessionId: 'sess-file-edit', agentId: 'main' }
const agentState = () => getStateManager().session(ctx.sessionId).forAgent(ctx.agentId)

/** 把文件标记为"已读"，让 patch_file 的已读校验通过 */
function markRead(filePath: string): void {
  agentState().setReadFileTimestamp(filePath, statSync(filePath).mtimeMs)
}

async function runPatch(input: { file_path: string; search_text: string; replacement: string; global_replace?: boolean }): Promise<void> {
  for await (const _ of PatchFile.call({ global_replace: false, ...input }, ctx)) { /* drain */ }
}

// ==================== P1：写盘内容被改写 ====================

test('P1 applyEdit: replacement 里的 $& 必须按字面写入', () => {
  const file = join(project, 'dollar-amp.ts')
  writeFile(file, 'const a = 1\nconst b = 2\n')

  const { updatedFile } = applyEdit(file, 'const a = 1', 'const a = "$&"')

  assert.equal(updatedFile, 'const a = "$&"\nconst b = 2\n')
})

test('P1 applyEdit: replacement 里的 $$ 必须按字面写入', () => {
  const file = join(project, 'pid.sh')
  writeFile(file, 'echo start\n')

  const { updatedFile } = applyEdit(file, 'start', '$$')

  assert.equal(updatedFile, 'echo $$\n')
})

test('P1 patch_file: 结果回显（片段）不展开 $ 特殊字符', () => {
  const message = PatchFile.genResultForAssistant({
    filePath: '/tmp/x.ts',
    originalFile: 'const a = 1\nconst b = 2\n',
    oldString: 'const a = 1',
    newString: 'const a = 2 // $&',
    structuredPatch: [],
  })

  assert.ok(typeof message === 'string' && message.includes('// $&'), String(message))
})

test('applyEdit: 删除整行时连带行尾换行（回归基线，不应被改动破坏）', () => {
  const file = join(project, 'delete-line.ts')
  writeFile(file, 'a\nb\nc\n')

  const { updatedFile } = applyEdit(file, 'b', '')

  assert.equal(updatedFile, 'a\nc\n')
})

// ==================== P1：新建/覆盖判定 ====================

test('P1 write_file: 覆盖已存在的空文件按 update 处理', async () => {
  const file = join(project, 'empty.txt')
  writeFileSync(file, '')
  markRead(file)

  const results: Array<{ data: { type: string } }> = []
  for await (const r of WriteFile.call({ file_path: file, file_content: 'hello\n' }, ctx)) {
    results.push(r as never)
  }

  assert.equal(readFileSync(file, 'utf8'), 'hello\n')
  assert.equal(results[0]!.data.type, 'update')
})

// ==================== P1：view_file 传目录 ====================

test('P1 view_file: 传目录返回可读提示而不是 EISDIR', async () => {
  const dir = join(project, 'a-directory')
  mkdirSync(dir, { recursive: true })

  const result = await ViewFile.validateInput({ file_path: dir } as never, ctx)

  assert.equal(result.result, false)
  assert.match(String(result.message), /director/i)
})

// ==================== P1：权限期间文件被外部改动的报错顺序 ====================

test('P1 patch_file: 权限期间文件被改时报"文件已变"，不报"无改动"', async () => {
  const file = join(project, 'race.ts')
  writeFile(file, 'const a = 1\n')
  markRead(file)

  // 模拟权限对话框期间用户把内容改掉了（search_text 已不存在，mtime 前进）
  writeFile(file, 'completely different\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)

  await assert.rejects(async () => {
    await runPatch({ file_path: file, search_text: 'const a = 1', replacement: 'const a = 3' })
  }, /changed while awaiting permission/i)
})

// ==================== P2：多处匹配的诊断 ====================

test('P2 patch_file: 多处匹配时列出行号', async () => {
  const file = join(project, 'dup.ts')
  writeFile(file, 'foo()\nbar()\nfoo()\n')
  markRead(file)

  const result = await PatchFile.validateInput({
    file_path: file,
    search_text: 'foo()',
    replacement: 'baz()',
    global_replace: false,
  }, ctx)

  assert.equal(result.result, false)
  assert.match(String(result.message), /\blines? 1\b.*\b3\b/)
})

test('P2 findOccurrences: 超过 limit 只回前几条行号，但总数照实报', () => {
  const file = Array.from({ length: 8 }, () => 'x').join('\n')
  const { count, lines } = findOccurrences(file, 'x', 5)

  assert.equal(count, 8)
  assert.deepEqual(lines, [1, 2, 3, 4, 5])
})

// ==================== 附带：normalizeLF 导出仍在用 ====================

test('normalizeLF: CRLF/CR 统一为 LF', () => {
  assert.equal(normalizeLF('a\r\nb\rc\n'), 'a\nb\nc\n')
})

test.after(() => {
  // 隔离目录留给系统清理；这里只回收 manager 状态
  getStateManager().removeSession?.(ctx.sessionId)
  assert.ok(root)
})
