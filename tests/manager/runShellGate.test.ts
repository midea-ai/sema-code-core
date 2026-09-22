import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyRunShellGate } from '../../src/manager/runShellGate'
import { GATE_CASES } from './runShellGate.cases'

// run_shell 前置闸门回归：命令会不会被确定性拦截 / 放行，还是交 AutoRun 模型。
// 与 PermissionManager 线上逻辑同源（classifyRunShellGate），用例见 runShellGate.cases.ts；
// 单条命令即时查看用 npx tsx tests/manager/runShellGate.probe.ts '<命令>'。

for (const c of GATE_CASES) {
  test(`${c.expect.padEnd(5)} ${c.name}`, () => {
    const gate = classifyRunShellGate(c.command)
    assert.equal(gate.verdict, c.expect, `stage=${gate.stage} detail=${gate.detail}\n${c.command}`)
  })
}
