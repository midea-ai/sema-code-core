import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, KEY, OTHER_KEY } from '../helpers/isolate'

// blob 按内容寻址、跨会话复用。换密钥或关掉加密后，新会话遇到相同内容不能复用自己读不出来的旧文件：
// 否则写入看着成功，撤销时才发现解不开。
// 宿主只有一把固定密钥：读不出来的旧密文直接按当前配置重写，不保留旧密钥那份（换了密钥旧会话本来就打不开）
const { project } = isolate('snapshot-key-change')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setHostConfig } = require('../../src/conf/hostConfig') as typeof import('../../src/conf/hostConfig')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snap = require('../../src/util/snapshotStore') as typeof import('../../src/util/snapshotStore')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProjectSnapshotsDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')

const blobPath = (hash: string) => join(getProjectSnapshotsDir(project), 'blobs', hash)
const content = Buffer.from('export const answer = 42\n')

test('换密钥：相同内容再写一次后，用新密钥读得回来', () => {
  setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
  const hash = snap.writeBlob(content, project)
  assert.deepEqual(snap.readBlob(hash, project), content)

  setHostConfig({ encryption: { key: OTHER_KEY, keyId: 'k2' } })
  assert.equal(snap.writeBlob(content, project), hash)
  assert.deepEqual(snap.readBlob(hash, project), content)
})

test('关掉加密：相同内容再写一次后，不带密钥读得回来', () => {
  setHostConfig({})
  const hash = snap.writeBlob(content, project)
  assert.deepEqual(snap.readBlob(hash, project), content)
})

test('重新带上密钥：密文和明文都在时仍然读得回来', () => {
  setHostConfig({ encryption: { key: OTHER_KEY, keyId: 'k2' } })
  const hash = snap.writeBlob(content, project)
  assert.deepEqual(snap.readBlob(hash, project), content)
})

test('升级前的明文 blob：带密钥后照常复用，不重写', () => {
  setHostConfig({})
  const legacy = Buffer.from('legacy plain blob\n')
  const hash = snap.writeBlob(legacy, project)

  setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
  assert.equal(snap.writeBlob(legacy, project), hash)
  assert.equal(existsSync(blobPath(hash)), true, '明文原样保留')
  assert.equal(existsSync(blobPath(hash) + '.enc'), false, '没有另写一份密文')
  assert.deepEqual(snap.readBlob(hash, project), legacy)
})

test('读不出来的 blob：报错而不是返回别的内容', () => {
  setHostConfig({ encryption: { key: KEY, keyId: 'k1' } })
  const hash = snap.writeBlob(Buffer.from('only under k1\n'), project)
  setHostConfig({ encryption: { key: OTHER_KEY, keyId: 'k2' } })
  assert.throws(() => snap.readBlob(hash, project))
  setHostConfig({})
  assert.throws(() => snap.readBlob(hash, project))
})
