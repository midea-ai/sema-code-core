import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolate, throwsWithCode, writeFile } from '../helpers/isolate'

// 构造参数 configFile 的读取与合并规则（纯函数 resolveConfigFile）：
// 从 JSON 文件读构造配置，构造参数里显式传的顶层键整体覆盖文件里的，{ "$file": "路径" } 换成文件文本；
// 读不到或不合法抛 CONFIG_INVALID。接到 SemaCore 上的效果见 configFile.core.test.ts
const { root, project } = isolate('config-file')
// ~/ 展开到用户目录：把用户目录指到隔离根目录下
const home = join(root, 'home')
process.env.HOME = home
process.env.USERPROFILE = home

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveConfigFile } = require('../../src/conf/configFile') as typeof import('../../src/conf/configFile')

const confDir = join(root, 'conf')
const write = (name: string, data: unknown) => {
  const file = join(confDir, name)
  writeFile(file, typeof data === 'string' ? data : JSON.stringify(data))
  return file
}
/** 断言抛 CONFIG_INVALID 且文案包含给定片段 */
const invalidWith = (fn: () => unknown, ...parts: string[]) => assert.throws(fn, (err: any) => {
  assert.equal(err.code, 'CONFIG_INVALID', err.message)
  for (const p of parts) assert.ok(err.message.includes(p), `文案应包含 "${p}"，实际：${err.message}`)
  return true
})

// ==================== 不传 configFile ====================

test('没传 configFile：原样返回同一个对象，现有宿主不受影响', () => {
  const config = { workingDir: project, stream: true }
  assert.equal(resolveConfigFile(config), config)
  const withUndefined = { workingDir: project, configFile: undefined }
  assert.equal(resolveConfigFile(withUndefined), withUndefined)
})

// ==================== 合并 ====================

test('合并：文件里有而构造参数没传的键取文件的', () => {
  const file = write('only-file.json', { workingDir: '/from/file', stream: true, maxSessions: 3, useTools: ['view_file'] })
  const merged = resolveConfigFile({ configFile: file })
  assert.equal(merged.workingDir, '/from/file')
  assert.equal(merged.stream, true)
  assert.equal(merged.maxSessions, 3)
  assert.deepEqual(merged.useTools, ['view_file'])
})

test('合并：构造参数显式传的顶层键整体覆盖文件里的，不做深合并', () => {
  const file = write('merge.json', {
    workingDir: '/from/file',
    customRules: 'file rules',
    skills: { dirs: ['/file/skills'], items: [{ name: 'a', description: 'd', prompt: 'p' }] },
    scopes: { skills: ['host'], plugins: [] },
  })
  const merged = resolveConfigFile({ configFile: file, workingDir: project, skills: { dirs: ['/arg/skills'] }, scopes: { mcp: ['host'] } })
  assert.equal(merged.workingDir, project)
  assert.equal(merged.customRules, 'file rules')
  assert.deepEqual(merged.skills, { dirs: ['/arg/skills'] }, '文件里的 skills.items 不保留')
  assert.deepEqual(merged.scopes, { mcp: ['host'] }, '文件里的 scopes.skills / plugins 不保留')
})

test('合并：undefined 视为没传，null / false / 空串是显式值', () => {
  const file = write('explicit.json', { customRules: 'file rules', useTools: ['view_file'], stream: true, systemPrompt: 'file prompt' })
  const merged = resolveConfigFile({ configFile: file, customRules: undefined, useTools: null, stream: false, systemPrompt: '' })
  assert.equal(merged.customRules, 'file rules')
  assert.equal(merged.useTools, null)
  assert.equal(merged.stream, false)
  assert.equal(merged.systemPrompt, '')
})

test('合并：结果里的 configFile 是构造参数传的那个，文件里写的 configFile 被忽略；入参对象不被改动', () => {
  const file = write('nested.json', { configFile: '/another.json', stream: true })
  const input = { configFile: file, thinking: true }
  const merged = resolveConfigFile(input)
  assert.equal(merged.configFile, file)
  assert.equal(merged.stream, true)
  assert.deepEqual(input, { configFile: file, thinking: true })
})

// ==================== 路径 ====================

test('configFile 路径：绝对路径与 ~/ 都能读', () => {
  writeFile(join(home, 'my-app', 'core.json'), JSON.stringify({ thinking: true }))
  assert.equal(resolveConfigFile({ configFile: '~/my-app/core.json' }).thinking, true)
  assert.equal(resolveConfigFile({ configFile: join(home, 'my-app', 'core.json') }).thinking, true)
})

test('configFile 路径：相对路径、空串、非字符串都不接受', () => {
  write('core.json', {})
  invalidWith(() => resolveConfigFile({ configFile: 'core.json' }), 'core.json')
  invalidWith(() => resolveConfigFile({ configFile: './core.json' }), './core.json')
  invalidWith(() => resolveConfigFile({ configFile: '../conf/core.json' }))
  invalidWith(() => resolveConfigFile({ configFile: '' }))
  invalidWith(() => resolveConfigFile({ configFile: 123 as any }))
})

// ==================== $file ====================

test('$file：相对配置文件所在目录（含 ../）、~/、绝对路径都能读', () => {
  writeFile(join(confDir, 'prompts', 'system.md'), 'SYSTEM\n第二行')
  writeFile(join(root, 'shared', 'bare.md'), 'UP ONE LEVEL')
  writeFile(join(home, 'rules.md'), 'HOME RULES')
  const abs = join(root, 'elsewhere', 'skill.md')
  writeFile(abs, 'SKILL BODY')
  const file = write('refs.json', {
    systemPrompt: { $file: './prompts/system.md' },
    customRules: { $file: '~/rules.md' },
    skills: { items: [{ name: 'a', description: { $file: '../shared/bare.md' }, prompt: { $file: abs } }] },
  })
  const merged = resolveConfigFile({ configFile: file })
  assert.equal(merged.systemPrompt, 'SYSTEM\n第二行')
  assert.equal(merged.customRules, 'HOME RULES')
  assert.equal(merged.skills?.items?.[0].description, 'UP ONE LEVEL')
  assert.equal(merged.skills?.items?.[0].prompt, 'SKILL BODY')
})

test('$file：不带 ./ 的相对路径同样相对配置文件所在目录，与进程 cwd 无关', () => {
  writeFile(join(confDir, 'plain.md'), 'PLAIN')
  const file = write('plain.json', { systemPrompt: { $file: 'plain.md' } })
  const cwd = process.cwd()
  process.chdir(root)
  try {
    assert.equal(resolveConfigFile({ configFile: file }).systemPrompt, 'PLAIN')
  } finally {
    process.chdir(cwd)
  }
})

test('$file：数组元素与对象深层都替换，其余值原样', () => {
  writeFile(join(confDir, 'arg.txt'), 'ARG FROM FILE')
  writeFile(join(confDir, 'token.txt'), 'TOKEN')
  const file = write('deep.json', {
    maxSessions: 5,
    stream: false,
    useTools: null,
    mcpServers: [{ name: 'm', transport: 'stdio', command: 'node', args: ['a', { $file: 'arg.txt' }], env: { TOKEN: { $file: 'token.txt' } }, enabled: true }],
  })
  const merged = resolveConfigFile({ configFile: file })
  assert.equal(merged.maxSessions, 5)
  assert.equal(merged.stream, false)
  assert.equal(merged.useTools, null)
  assert.deepEqual(merged.mcpServers, [{ name: 'm', transport: 'stdio', command: 'node', args: ['a', 'ARG FROM FILE'], env: { TOKEN: 'TOKEN' }, enabled: true }])
})

test('$file：文本原样取用，不去空白、不当 JSON 解析、不再展开其中的 $file', () => {
  const body = '  # 标题\n\n{ "$file": "./other.md" }\n'
  writeFile(join(confDir, 'raw.md'), body)
  const file = write('raw.json', { systemPrompt: { $file: 'raw.md' } })
  assert.equal(resolveConfigFile({ configFile: file }).systemPrompt, body)
})

test('$file：只对配置文件里的内容生效，构造参数里的同形对象不处理', () => {
  const file = write('arg-ref.json', { stream: true })
  const ref = { $file: './whatever.md' }
  const merged = resolveConfigFile({ configFile: file, systemPrompt: ref as any })
  assert.equal(merged.systemPrompt, ref)
})

test('$file：被构造参数覆盖的键不读它引用的文件，引用缺失或写错都不报错；没被覆盖的键照常报错', () => {
  writeFile(join(confDir, 'kept.md'), 'KEPT')
  const file = write('overridden.json', {
    systemPrompt: { $file: './missing.md' },
    customRules: { $file: './kept.md' },
    skills: { items: [{ name: 'a', description: 'd', prompt: { $file: './missing-skill.md' } }] },
    agents: { items: [{ name: 'b', description: 'd', prompt: { $file: 1, extra: true } }] },
  })
  const merged = resolveConfigFile({ configFile: file, systemPrompt: 'arg prompt', skills: { dirs: ['/arg/skills'] }, agents: {} })
  assert.equal(merged.systemPrompt, 'arg prompt')
  assert.equal(merged.customRules, 'KEPT')
  assert.deepEqual(merged.skills, { dirs: ['/arg/skills'] })
  assert.deepEqual(merged.agents, {})

  // 显式传 null / 空串同样算覆盖
  assert.equal(resolveConfigFile({ configFile: file, systemPrompt: '', skills: {}, agents: {} }).systemPrompt, '')
  // 传 undefined 不算覆盖：缺失的引用照常报错，文案指向该字段
  invalidWith(() => resolveConfigFile({ configFile: file, systemPrompt: undefined, skills: {}, agents: {} }), 'systemPrompt.$file', 'missing.md')
  // 只覆盖一部分：剩下没覆盖的坏引用照常报错
  invalidWith(() => resolveConfigFile({ configFile: file, systemPrompt: 'x', agents: {} }), 'skills.items[0].prompt.$file')
  invalidWith(() => resolveConfigFile({ configFile: file, systemPrompt: 'x', skills: {} }), 'agents.items[0].prompt')
})

test('带 BOM 的配置文件与外置文本：BOM 去掉', () => {
  writeFile(join(confDir, 'bom.md'), '﻿BOM TEXT')
  const file = write('bom.json', '﻿' + JSON.stringify({ systemPrompt: { $file: 'bom.md' } }))
  assert.equal(resolveConfigFile({ configFile: file }).systemPrompt, 'BOM TEXT')
})

// ==================== 不合法 ====================

test('配置文件读不到：不存在、是目录，文案带路径', () => {
  const missing = join(confDir, 'missing.json')
  invalidWith(() => resolveConfigFile({ configFile: missing }), 'configFile', missing)
  invalidWith(() => resolveConfigFile({ configFile: confDir }), 'configFile', confDir)
})

test('配置文件内容不合法：非 JSON、带注释、尾逗号、顶层不是对象', () => {
  invalidWith(() => resolveConfigFile({ configFile: write('bad.json', '{ stream: true }') }), 'not valid JSON', 'bad.json')
  invalidWith(() => resolveConfigFile({ configFile: write('comment.json', '{ // 注释\n "stream": true }') }), 'not valid JSON')
  invalidWith(() => resolveConfigFile({ configFile: write('block.json', '{ /* 注释 */ "stream": true }') }), 'not valid JSON')
  invalidWith(() => resolveConfigFile({ configFile: write('trailing.json', '{ "stream": true, }') }), 'not valid JSON')
  invalidWith(() => resolveConfigFile({ configFile: write('empty.json', '') }), 'not valid JSON')
  for (const [name, text] of [['array.json', '[]'], ['string.json', '"x"'], ['null.json', 'null'], ['number.json', '1']]) {
    invalidWith(() => resolveConfigFile({ configFile: write(name, text) }), 'JSON object', name)
  }
})

test('$file 写错：多了别的键、路径不是非空字符串，文案指出字段位置', () => {
  invalidWith(() => resolveConfigFile({ configFile: write('ref-extra.json', { systemPrompt: { $file: './a.md', x: 1 } }) }), 'systemPrompt')
  invalidWith(() => resolveConfigFile({ configFile: write('ref-empty.json', { customRules: { $file: '' } }) }), 'customRules')
  invalidWith(() => resolveConfigFile({ configFile: write('ref-number.json', { skills: { items: [{ prompt: { $file: 1 } }] } }) }), 'skills.items[0].prompt')
  invalidWith(() => resolveConfigFile({ configFile: write('ref-null.json', { agents: { items: [{}, { prompt: { $file: null } }] } }) }), 'agents.items[1].prompt')
})

test('$file 指向的文件读不到：不存在、是目录，文案带字段位置与解析后的路径', () => {
  invalidWith(
    () => resolveConfigFile({ configFile: write('ref-missing.json', { skills: { items: [{ prompt: { $file: './nope.md' } }] } }) }),
    'skills.items[0].prompt.$file', join(confDir, 'nope.md'),
  )
  invalidWith(() => resolveConfigFile({ configFile: write('ref-dir.json', { systemPrompt: { $file: './prompts' } }) }), 'systemPrompt.$file', join(confDir, 'prompts'))
})
