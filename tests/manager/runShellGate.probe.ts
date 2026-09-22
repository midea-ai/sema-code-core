// run_shell 前置闸门探针：输入终端命令，输出会被直接放行 / 交 AutoRun 模型 / 确定性转人工。
// 与 PermissionManager 线上逻辑同源（classifyRunShellGate），相对路径按当前目录（项目根）解析。
//
//   npx tsx tests/manager/runShellGate.probe.ts 'cd /tmp && rm -rf x'   # 单条
//   npx tsx tests/manager/runShellGate.probe.ts < commands.txt          # 每行一条
//   npx tsx tests/manager/runShellGate.probe.ts --cases                  # 跑用例表（无参数且 stdin 是终端时同此）
import { readFileSync } from 'node:fs'
import { classifyRunShellGate } from '../../src/manager/runShellGate'
import { GATE_CASES } from './runShellGate.cases'

const LABEL = { allow: '直接放行', model: '交模型', human: '前置拦截→人工' } as const

function show(command: string, expect?: string): boolean {
  const gate = classifyRunShellGate(command)
  const ok = expect === undefined || gate.verdict === expect
  const mark = expect === undefined ? '' : ok ? ' ✓' : ` ✗ 期望 ${expect}`
  const oneLine = command.replace(/\n/g, '⏎').slice(0, 120)
  console.log(`${LABEL[gate.verdict].padEnd(9, '　')} [${gate.stage}/${gate.detail}]${mark}  ${oneLine}`)
  return ok
}

const args = process.argv.slice(2)
const runCases = args[0] === '--cases' || (args.length === 0 && process.stdin.isTTY)
if (!runCases && args.length > 0) {
  show(args.join(' '))
} else if (!runCases) {
  const lines = readFileSync(0, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) show(line)
} else {
  let failed = 0
  for (const c of GATE_CASES) if (!show(c.command, c.expect)) failed++
  console.log(`\n${GATE_CASES.length - failed}/${GATE_CASES.length} 符合预期`)
  process.exitCode = failed ? 1 : 0
}
