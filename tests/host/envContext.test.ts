import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { isolate, writeFile } from '../helpers/isolate'

// disableEnvContext：主代理与子代理的系统提示词都不拼 env / gitStatus，也不起 git 进程
const { root, project } = isolate('env-context')

// git 垫片是 sh 脚本，Windows 上不跑
const skip = process.platform === 'win32' ? 'git 垫片是 sh 脚本' : false
const gitLog = join(root, 'git-calls.log')

if (!skip) {
  // 项目目录建成真仓库，开着环境上下文时才有 gitStatus 可拼
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  execFileSync(realGit, ['init', '-q'], { cwd: project })

  // PATH 最前面放一个 git 垫片：每次被调用记一行，再转给真 git；用来数 core 起了几次 git 进程
  const shimDir = join(root, 'shim')
  writeFile(join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexec "${realGit}" "$@"\n`)
  chmodSync(join(shimDir, 'git'), 0o755)
  process.env.PATH = `${shimDir}${delimiter}${process.env.PATH}`
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getConfManager } = require('../../src/manager/ConfManager') as typeof import('../../src/manager/ConfManager')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatSystemPrompt, buildAgentSystemPrompt } = require('../../src/services/agents/genSystemPrompt') as typeof import('../../src/services/agents/genSystemPrompt')

const cm = getConfManager()
const gitCalls = () => (existsSync(gitLog) ? readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).length : 0)
const textOf = (blocks: Array<{ text: string }>) => blocks.map(b => b.text).join('\n\n')
const hasEnv = (text: string) => text.includes('<env>')
const hasGitStatus = (text: string) => text.includes('gitStatus:')

test('disableEnvContext：主代理与子代理都不拼 env / gitStatus，不起 git 进程', { skip }, async () => {
  await cm.setCoreConfig({ workingDir: project, disableEnvContext: true })
  const before = gitCalls()

  const main = textOf(await formatSystemPrompt())
  const sub = textOf(await buildAgentSystemPrompt('AGENT BODY'))

  assert.equal(hasEnv(main), false)
  assert.equal(hasGitStatus(main), false)
  assert.equal(hasEnv(sub), false)
  assert.equal(hasGitStatus(sub), false)
  assert.equal(sub.startsWith('AGENT BODY'), true, '子代理自身的提示词照常保留')
  assert.equal(gitCalls(), before, '没有起 git 进程')
})

test('不传 disableEnvContext：主代理与子代理都带 env 与 gitStatus，起了 git 进程', { skip }, async () => {
  await cm.setCoreConfig({ workingDir: project })
  const before = gitCalls()

  const main = textOf(await formatSystemPrompt())
  const sub = textOf(await buildAgentSystemPrompt('AGENT BODY'))

  for (const text of [main, sub]) {
    assert.equal(text.includes(`<env>Working dir: ${project}`), true)
    assert.equal(text.includes('Is a Git repo: Yes'), true)
    assert.equal(text.includes('gitStatus: Git status snapshot'), true)
  }
  assert.equal(gitCalls() > before, true, '起了 git 进程')
})

test('replaceAll 等同 replace：主代理用宿主的 systemPrompt 取代内置提示词，主代理与子代理仍带 env / gitStatus', { skip }, async () => {
  await cm.setCoreConfig({ workingDir: project, systemPromptMode: 'replace', systemPrompt: 'ONLY THIS' })
  const replaced = textOf(await formatSystemPrompt())

  await cm.setCoreConfig({ workingDir: project, systemPromptMode: 'replaceAll', systemPrompt: 'ONLY THIS' })
  const main = textOf(await formatSystemPrompt())
  const sub = textOf(await buildAgentSystemPrompt('AGENT BODY'))

  assert.equal(main.startsWith('ONLY THIS'), true)
  assert.equal(hasEnv(main), true)
  assert.equal(hasGitStatus(main), true)
  // gitStatus 是每次现取的快照，两次之间仓库没变，整段应一字不差
  assert.equal(main, replaced)
  assert.equal(hasEnv(sub), true)
  assert.equal(hasGitStatus(sub), true)
})

test('replaceAll 加 disableEnvContext：提示词模式不影响开关，主代理与子代理都不带 env / gitStatus', { skip }, async () => {
  await cm.setCoreConfig({ workingDir: project, systemPromptMode: 'replaceAll', systemPrompt: 'ONLY THIS', disableEnvContext: true })

  for (const text of [textOf(await formatSystemPrompt()), textOf(await buildAgentSystemPrompt('AGENT BODY'))]) {
    assert.equal(hasEnv(text), false)
    assert.equal(hasGitStatus(text), false)
  }
})
