import test from 'node:test'
import assert from 'node:assert/strict'

import { formatOutput } from '../../src/util/shell'

const out = (content: string, opts?: { resolveCR?: boolean }) =>
  formatOutput(content, undefined, opts).truncatedContent

// Windows 上 Python / PowerShell / cmd 每行都以 \r\n 结尾。行尾的 \r 不是终端重绘，
// 不能参与「只保留最后一次 \r 之后内容」的折叠，否则每一行都会被抹成空串。
test('CRLF 多行输出保留全部行', () => {
  assert.equal(out('0\r\n1\r\n2'), '0\n1\n2')
})

test('LF 多行输出不受影响', () => {
  assert.equal(out('0\n1\n2'), '0\n1\n2')
})

// 折叠逻辑本身要保留：行内的 \r 是真正的进度条重绘。
test('行内 \r 仍折叠为最终状态', () => {
  assert.equal(out('Progress: 50%\rProgress: 100%'), 'Progress: 100%')
})

test('CRLF 行尾与行内重绘混排时各自处理', () => {
  assert.equal(
    out('a\r\nProgress: 50%\rProgress: 100%\r\nb'),
    'a\nProgress: 100%\nb',
  )
})

// 程序自己写了 \r\n、运行时又把 \n 翻译了一次，得到 \r\r\n。
test('连续 \r 结尾归一为单个换行', () => {
  assert.equal(out('a\r\r\nb'), 'a\nb')
})

test('空输入返回空串', () => {
  assert.equal(out(''), '')
})

// 流式 chunk 走 resolveCR: false，保留原始 \r 才能让 UI 实时渲染进度条。
test('resolveCR 为 false 时原样返回，\r 不动', () => {
  assert.equal(out('0\r\n1\r\n2', { resolveCR: false }), '0\r\n1\r\n2')
  assert.equal(
    out('Progress: 50%\rProgress: 100%', { resolveCR: false }),
    'Progress: 50%\rProgress: 100%',
  )
})
