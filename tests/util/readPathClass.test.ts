import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SEMA_ROOT 在首次 getSemaRootDir() 时缓存，必须在加载被测模块前设好；import 会被提升，故用 require 延后加载
const root = mkdtempSync(join(tmpdir(), 'sema-root-'))
process.env.SEMA_ROOT = root
mkdirSync(join(root, 'attachments'), { recursive: true })

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAttachmentPath, classifyReadPath } = require('../../src/util/readPathClass') as typeof import('../../src/util/readPathClass')

const uuid = '3f2b9c1e-7a4d-4e8b-9c2f-1d5e6a7b8c9d'

// SEMA_ROOT/attachments 是宿主转存粘贴 / 可视化产物的目录：读取归 trusted，编辑放行（PermissionManager 硬规则并入）
test('attachments 目录内文件属于附件路径', () => {
  assert.equal(isAttachmentPath(join(root, 'attachments', uuid, 'chart.html')), true)
  assert.equal(isAttachmentPath(join(root, 'attachments', uuid, 'pasted-text.txt')), true)
})

test('attachments 目录本身也算', () => {
  assert.equal(isAttachmentPath(join(root, 'attachments')), true)
})

test('SEMA_ROOT 下其他目录与前缀相似的路径不算', () => {
  assert.equal(isAttachmentPath(join(root, 'skills', 'visualize', 'SKILL.md')), false)
  assert.equal(isAttachmentPath(join(root, 'attachments-old', 'x.html')), false)
  assert.equal(isAttachmentPath(join(root, 'attachments', '..', 'settings.json')), false)
})

test('attachments 读取归 trusted', () => {
  assert.equal(classifyReadPath(join(root, 'attachments', uuid, 'chart.html')), 'trusted')
})

test.after(() => rmSync(root, { recursive: true, force: true }))
