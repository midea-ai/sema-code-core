import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, KEY, OTHER_KEY, writeFile } from '../helpers/isolate'

// 会话基线 diff：基线 = 本会话有效 EditLog 中该文件最早一条改前镜像，
// 右侧 = 查询时磁盘内容。这里直接驱动 CheckpointManager，不建会话。
const { project } = isolate('file-changes')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCheckpointManager } = require('../../src/manager/CheckpointManager') as typeof import('../../src/manager/CheckpointManager')

const cm = getCheckpointManager()
const p = (name: string) => join(project, name)
const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

before(async () => {
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none' })
  setHostConfig({})
})

test('新建文件：状态 added，按整文件新增统计', async () => {
  const sid = 'new-file'
  const file = p('src/new.ts')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file) // 捕获时文件还不存在
  writeFile(file, 'a\nb\n')

  const list = await cm.getFileChanges(sid)
  assert.equal(list.length, 1)
  assert.equal(list[0].state, 'added')
  assert.equal(list[0].baselineExists, false)
  assert.equal(list[0].status, 'ok')
  assert.equal(list[0].additions, 2)
  assert.equal(list[0].removals, 0)
  assert.equal(list[0].line, 1)

  const diff = await cm.getFileDiff(sid, 'src/new.ts') // 相对工作目录的写法也认
  assert.equal(diff.currentExists, true)
  assert.equal(diff.baselineText, '')
  assert.equal(diff.currentText, 'a\nb\n')
})

test('修改既有文件：基线取最早一条，统计为首个变更行', async () => {
  const sid = 'modify-file'
  const file = p('src/app.ts')
  writeFile(file, 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'l1\nl2\nl3\nl4\nl5\nL6\nl7\nl8\nl9\nl10\n')
  // 同一回合再改一次不应覆盖基线
  writeFile(file, 'l1\nl2\nl3\nl4\nl5\nL6\nl7\nl8\nl9\nl10\nl11\n')

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'modified')
  assert.equal(item.baselineExists, true)
  assert.equal(item.additions, 2)
  assert.equal(item.removals, 1)
  assert.equal(item.line, 6)
})

test('文件被删除：状态 deleted，删除行数为基线行数', async () => {
  const sid = 'delete-file'
  const file = p('src/gone.ts')
  writeFile(file, 'a\nb\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'a\n') // 先改
  // 再删
  rmSync(file)

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'deleted')
  assert.equal(item.removals, 2)
  assert.equal(item.additions, 0)

  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.currentExists, false)
  assert.equal(diff.currentText, '')
  assert.equal(diff.baselineText, 'a\nb\n')
})

test('改回原样：列表隐藏，详情为 unchanged', async () => {
  const sid = 'reverted-file'
  const file = p('src/same.ts')
  writeFile(file, 'x\ny\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'x\nY\n')
  writeFile(file, 'x\ny\n')

  assert.deepEqual(await cm.getFileChanges(sid), [])
  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.state, 'unchanged')
  assert.equal(diff.additions, 0)
  assert.equal(diff.removals, 0)
  assert.equal(diff.rawChanged, undefined)
})

test('仅换行形式变化：文本零增删但标记 rawChanged', async () => {
  const sid = 'line-ending'
  const file = p('src/eol.ts')
  writeFile(file, 'a\nb\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFileSync(file, 'a\r\nb\r\n')

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'modified')
  assert.equal(item.additions, 0)
  assert.equal(item.removals, 0)
  assert.equal(item.rawChanged, true)
})

test('新增空文件：增删为零也保留 added 状态', async () => {
  const sid = 'empty-file'
  const file = p('src/empty.ts')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, '')

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'added')
  assert.equal(item.additions, 0)
  assert.equal(item.removals, 0)
})

test('UTF-16LE：按原编码解码，只算真实改动行', async () => {
  const sid = 'utf16'
  const file = p('src/u16.ts')
  writeFileSync(file, utf16('a\nb\nc\n'))
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFileSync(file, utf16('a\nB\nc\n'))

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.additions, 1)
  assert.equal(item.removals, 1)

  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.baselineText, '\uFEFFa\nb\nc\n')
  assert.equal(diff.currentText, '\uFEFFa\nB\nc\n')
})

test('二进制文件：只表达状态，不给增删行', async () => {
  const sid = 'binary'
  const file = p('assets/pic.png')
  writeFile(file, 'not really a png')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'changed bytes')

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'modified')
  assert.equal(item.status, 'binary')
  assert.equal(item.additions, undefined)

  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.status, 'binary')
  assert.equal(diff.baselineText, undefined)
})

test('超出文本比较上限：标记 tooLarge，基线仍在', async () => {
  const sid = 'too-large'
  const file = p('data/big.txt')
  writeFile(file, 'small basline\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, `${'x'.repeat(1024 * 1024 + 1)}\n`)

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'modified')
  assert.equal(item.status, 'tooLarge')
  assert.equal(item.additions, undefined)
})

test('换掉密钥后基线读不出来：标记 baselineUnavailable，不当成新增', async () => {
  const sid = 'no-baseline'
  const file = p('src/secret.ts')
  writeFile(file, 'old\n')
  setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'new\n')
  setHostConfig({ encryption: { key: OTHER_KEY, keyId: 'k2' } })

  const [item] = await cm.getFileChanges(sid)
  assert.equal(item.state, 'modified')
  assert.equal(item.status, 'baselineUnavailable')
  assert.equal(item.baselineExists, true)

  assert.equal((await cm.getFileDiff(sid, file)).status, 'baselineUnavailable')
  setHostConfig({})
})

test('没有记录的路径：详情报 baselineUnavailable，不造空基线 diff', async () => {
  const file = p('src/untouched.ts')
  writeFile(file, 'hello\n')
  const diff = await cm.getFileDiff('no-record', file)
  assert.equal(diff.status, 'baselineUnavailable')
  assert.equal(diff.state, 'unknown')
  assert.equal(diff.currentExists, true)
  assert.equal(diff.baselineText, undefined)
})

test('放弃修改：修改写回、新建删除、删除重建，做完列表为空', async () => {
  const sid = 'revert'
  const modified = p('src/r-modified.ts')
  const created = p('src/r-created.ts')
  const deleted = p('src/r-deleted.ts')
  writeFile(modified, 'old\n')
  writeFile(deleted, 'gone\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', modified)
  cm.recordPreEdit(sid, 'main', created)
  cm.recordPreEdit(sid, 'main', deleted)
  writeFile(modified, 'new\n')
  writeFile(created, 'created\n')
  rmSync(deleted)

  const results = await cm.revertFileChanges(sid)
  assert.deepEqual(results.map(r => r.action), ['restored', 'deleted', 'restored'])
  assert.equal(readFileSync(modified, 'utf8'), 'old\n')
  assert.equal(existsSync(created), false)
  assert.equal(readFileSync(deleted, 'utf8'), 'gone\n')
  assert.deepEqual(await cm.getFileChanges(sid), [])

  // 只处理指定文件
  writeFile(modified, 'again\n')
  const one = await cm.revertFileChanges(sid, ['src/r-modified.ts'])
  assert.equal(one.length, 1)
  assert.equal(readFileSync(modified, 'utf8'), 'old\n')
})

test('回退截断 / 分支复制：基线跟随有效记录', async () => {
  const sid = 'truncate'
  const file = p('src/t.ts')
  writeFile(file, 'a\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'b\n')
  assert.equal((await cm.getFileChanges(sid)).length, 1)

  cm.copyEditLog(sid, 'truncate-branch', cm.getEditCount(sid))
  assert.equal((await cm.getFileChanges('truncate-branch')).length, 1)

  cm.truncateEditLog(sid, 0)
  assert.deepEqual(await cm.getFileChanges(sid), [])
})

test('/clear 清空基线：清单与详情都不再返回旧改动', async () => {
  const sid = 'clear'
  const file = p('src/c.ts')
  writeFile(file, 'a\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'b\n')
  assert.equal((await cm.getFileChanges(sid)).length, 1)

  cm.clearEditLog(sid)
  assert.deepEqual(await cm.getFileChanges(sid), [])
  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.status, 'baselineUnavailable')
})

test('放弃修改传空数组：什么都不做，不能当成"全部"', async () => {
  const sid = 'revert-empty'
  const modified = p('src/e-modified.ts')
  const created = p('src/e-created.ts')
  writeFile(modified, 'old\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', modified)
  cm.recordPreEdit(sid, 'main', created)
  writeFile(modified, 'new\n')
  writeFile(created, 'created\n')

  assert.deepEqual(await cm.revertFileChanges(sid, []), [])
  assert.equal(readFileSync(modified, 'utf8'), 'new\n')
  assert.equal(readFileSync(created, 'utf8'), 'created\n')
})

test('编码从 UTF-16LE 改成 UTF-8：当前内容按字节解码，不用过期的路径编码缓存', async () => {
  const sid = 'encoding-switch'
  const file = p('src/switch.ts')
  writeFileSync(file, utf16('hello\n'))
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file) // 捕获时嗅探并缓存 utf16le
  writeFile(file, 'hello\n')          // 随后另存为 UTF-8

  const diff = await cm.getFileDiff(sid, file)
  assert.equal(diff.currentText, 'hello\n') // 不能解成 敨汬
  assert.equal(diff.baselineText, '\uFEFFhello\n')
})

test('stat 失败（父目录不可访问）：状态 unknown 且仍留在清单里，不当作已删除', { skip: process.getuid?.() === 0 }, async () => {
  const sid = 'unreadable-dir'
  const dir = join(project, 'locked')
  const file = join(dir, 'x.ts')
  writeFile(file, 'a\n')
  cm.beginTurn(sid)
  cm.recordPreEdit(sid, 'main', file)
  writeFile(file, 'b\n')

  chmodSync(dir, 0o000)
  try {
    const list = await cm.getFileChanges(sid)
    assert.equal(list.length, 1, '读不出来的文件不能被过滤掉')
    assert.equal(list[0].state, 'unknown')
    assert.equal(list[0].status, 'currentUnreadable')
    assert.equal(list[0].additions, undefined)

    const diff = await cm.getFileDiff(sid, file)
    assert.equal(diff.state, 'unknown')
    assert.equal(diff.status, 'currentUnreadable')
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('超过捕获上限：只保留"被改过"，回退与放弃修改都不碰文件', async () => {
  const sid = 'oversized'
  const file = p('src/big.log')
  const before = 'x'.repeat(64)
  const after = 'y'.repeat(64)
  writeFile(file, before)
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none', maxCheckpointBytes: 8 })
  try {
    cm.beginTurn(sid)
    cm.recordPreEdit(sid, 'main', file)
    writeFile(file, after)

    const [item] = await cm.getFileChanges(sid)
    assert.equal(item.state, 'modified')
    assert.equal(item.status, 'baselineUnavailable')

    // 回退计划里直接跳过，执行回退也不动文件
    assert.deepEqual(cm.computeRestorePlan(sid, 0), [])
    assert.deepEqual(cm.applyRestore(cm.computeRestorePlan(sid, 0)), [])
    assert.equal(readFileSync(file, 'utf8'), after)

    // 放弃修改报失败，且不能因为"没有基线"就把文件删掉
    const results = await cm.revertFileChanges(sid)
    assert.equal(results.length, 1)
    assert.equal(results[0].action, 'failed')
    assert.equal(readFileSync(file, 'utf8'), after)
  } finally {
    await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none' })
  }
})

test('maxCheckpointBytes 为 0：不限制，照常存快照', async () => {
  const sid = 'no-cap'
  const file = p('src/nocap.ts')
  writeFile(file, 'a\n')
  await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none', maxCheckpointBytes: 0 })
  try {
    cm.beginTurn(sid)
    cm.recordPreEdit(sid, 'main', file)
    writeFile(file, 'b\n')
    const [item] = await cm.getFileChanges(sid)
    assert.equal(item.status, 'ok')
    assert.equal(item.additions, 1)
    assert.equal(item.removals, 1)
  } finally {
    await getConfManager().setCoreConfig({ workingDir: project, logLevel: 'none' })
  }
})
