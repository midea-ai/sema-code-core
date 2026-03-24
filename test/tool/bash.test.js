import { BashTool } from '../../dist/tools/Bash/Bash.js';
import { getEventBus } from '../../dist/events/EventSystem.js';

// ─── 测试工具 ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`断言失败: ${msg}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function printResult(data, { elapsed, chunkCount } = {}) {
  const gar = BashTool.genResultForAssistant(data);
  const gtr = BashTool.genToolResultMessage(data);
  console.log(`     ┌─ 执行结果 ──────────────────────`);
  console.log(`     │ stdout    : ${JSON.stringify(data.stdout.trim()) || '(空)'}`);
  console.log(`     │ stderr    : ${JSON.stringify(data.stderr.trim()) || '(空)'}`);
  console.log(`     │ interrupted: ${data.interrupted}`);
  if (elapsed !== undefined) console.log(`     │ 耗时      : ${elapsed}ms`);
  if (chunkCount !== undefined) console.log(`     │ chunk事件 : ${chunkCount} 个`);
  console.log(`     │ genResultForAssistant : ${JSON.stringify(gar.trim()) || '(空)'}`);
  console.log(`     │ genToolResult         : ${JSON.stringify(gtr.content)}`);
  console.log(`     └────────────────────────────────`);
}

/** 执行 BashTool 并返回最终 result.data */
async function run(command, { timeout = 5000, description = 'test', abortController, agentId = 'main' } = {}) {
  const ac = abortController ?? new AbortController();
  const agentContext = { abortController: ac, agentId, currentToolUseID: 'test-tool-id' };
  const input = { command, timeout, description };
  let data;
  for await (const result of BashTool.call(input, agentContext)) {
    if (result.type === 'result') data = result.data;
  }
  return data;
}

// ─── Case 1: 终端信息有变化，5秒内完成，触发 chunk 事件 ──────────────────────

console.log('\n【Case 1: 终端信息变化，5秒内结束】');

await test('每隔0.6s输出一行，约3s内完成，应触发多个 chunk 事件', async () => {
  const chunks = [];
  const eventBus = getEventBus();
  const handler = (data) => {
    chunks.push(data);
    console.log(`     [chunk #${chunks.length}] ${JSON.stringify(data.content)}`);
  };
  eventBus.on('tool:execution:chunk', handler);

  const data = await run(
    'for i in 1 2 3 4; do echo "line$i"; sleep 0.6; done',
    { timeout: 5000, description: '流式输出测试' }
  );

  eventBus.off('tool:execution:chunk', handler);
  printResult(data, { chunkCount: chunks.length });

  assert(data.interrupted === false, `命令应正常完成，interrupted=${data.interrupted}`);
  assert(data.stdout.includes('line1'), `stdout 应含输出，实际=${data.stdout}`);
  assert(chunks.length > 0, `应触发 chunk 事件，实际收到 ${chunks.length} 个`);
  assert(chunks.some(c => c.content.includes('line')), `chunk 内容应含输出，实际=${JSON.stringify(chunks.map(c => c.content))}`);
});

// ─── Case 2: 终端信息无变化，快速结束 ────────────────────────────────────────

console.log('\n【Case 2: 终端信息无变化，快速结束】');

await test('echo fast：快速完成，不触发或仅触发极少 chunk 事件', async () => {
  const chunks = [];
  const eventBus = getEventBus();
  const handler = (data) => {
    chunks.push(data);
    console.log(`     [chunk #${chunks.length}] ${JSON.stringify(data.content)}`);
  };
  eventBus.on('tool:execution:chunk', handler);

  const data = await run('echo fast', { timeout: 5000, description: '快速命令' });

  eventBus.off('tool:execution:chunk', handler);
  printResult(data, { chunkCount: chunks.length });

  assert(data.interrupted === false, `命令应正常完成，interrupted=${data.interrupted}`);
  assert(data.stdout.includes('fast'), `stdout 应含 fast，实际=${data.stdout}`);
  assert(chunks.length <= 1, `快速命令 chunk 数应 <=1，实际=${chunks.length}`);
});

// ─── Case 3: 设置 4s 超时，超时后返回中间输出 + 超时信息 ─────────────────────

console.log('\n【Case 3: 设置4秒超时，超时退出，返回中间输出和超时信息】');

await test('每秒输出一行，共10行，timeout=4000ms：应在4s后被 max timeout 终止', async () => {
  const chunks = [];
  const eventBus = getEventBus();
  const handler = (data) => {
    chunks.push(data);
    console.log(`     [chunk #${chunks.length}] ${JSON.stringify(data.content)}`);
  };
  eventBus.on('tool:execution:chunk', handler);

  const start = Date.now();
  const data = await run(
    'for i in 1 2 3 4 5 6 7 8 9 10; do echo "step$i"; sleep 1; done',
    { timeout: 4000, description: 'max timeout 测试' }
  );
  eventBus.off('tool:execution:chunk', handler);

  const elapsed = Date.now() - start;
  printResult(data, { elapsed, chunkCount: chunks.length });

  assert(
    data.stderr.includes('timed out') || data.interrupted,
    `应被超时终止，stderr=${data.stderr}, interrupted=${data.interrupted}`
  );
  assert(data.stdout.includes('step'), `应包含中间状态输出，stdout=${data.stdout}`);
  assert(elapsed < 6000, `应在6秒内结束，实际耗时=${elapsed}ms`);
});

// ─── Case 4: \r 不做处理，stdout 同时含 data1 和 data2 ───────────────────────

console.log('\n【Case 4: printf \\r 输出，\\r 不做处理，stdout 完整保留】');

await test('printf data1 后 \\r data2：\\r 不处理，stdout 应同时含 data1 和 data2', async () => {
  const chunks = [];
  const eventBus = getEventBus();
  const handler = (data) => {
    chunks.push(data);
    console.log(`     [chunk #${chunks.length}] ${JSON.stringify(data.content)}`);
  };
  eventBus.on('tool:execution:chunk', handler);

  const start = Date.now();
  const data = await run(
    'printf "data1"; sleep 1; printf "\\rdata2\\n"',
    { timeout: 5000, description: '\\r 不处理输出测试' }
  );
  eventBus.off('tool:execution:chunk', handler);

  const elapsed = Date.now() - start;
  printResult(data, { elapsed, chunkCount: chunks.length });

  assert(data.interrupted === false, `命令应正常完成，interrupted=${data.interrupted}`);
  assert(data.stdout.includes('data2'), `stdout 应含 data2，实际=${data.stdout}`);
  assert(data.stdout.includes('data1'), `\\r 不处理，stdout 应保留 data1，实际=${data.stdout}`);
  assert(chunks.length >= 1, `应触发至少1个 chunk 事件，实际=${chunks.length}`);
  assert(chunks.some(c => c.content.includes('data1')), `chunk 应含 data1，实际=${JSON.stringify(chunks.map(c => c.content))}`);
  assert(elapsed >= 1000, `应至少耗时1秒，实际耗时=${elapsed}ms`);
  assert(elapsed < 5000, `应在5秒内完成，实际耗时=${elapsed}ms`);
});

// ─── Case 5: 中断测试 ─────────────────────────────────────────────────────────

console.log('\n【Case 5: 中断测试，1秒后 abort】');

await test('运行长命令，1秒后 abort：应被中断，interrupted=true，1秒内完成', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1000);

  const start = Date.now();
  const data = await run(
    'for i in 1 2 3 4 5 6 7 8 9 10; do echo "step$i"; sleep 1; done',
    { timeout: 30000, description: '中断测试', abortController: ac }
  );
  const elapsed = Date.now() - start;
  printResult(data, { elapsed });

  assert(data.interrupted === true, `应被中断，interrupted=${data.interrupted}`);
  assert(elapsed < 3000, `应在3秒内结束，实际耗时=${elapsed}ms`);
});

// ─── Case 6: sleep 5，应收到空 chunk，最终结果为 "(no content)" ────────────────

console.log('\n【Case 7: sleep 5，应收到 chunk "(no content)"，最终结果为 "(no content)"】');

await test('sleep 6：应收到空 chunk ""，genResultForAssistant 为 "(no content)"', async () => {
  const chunks = [];
  const eventBus = getEventBus();
  const handler = (data) => {
    chunks.push(data);
    console.log(`     [chunk #${chunks.length}] ${JSON.stringify(data.content)}`);
  };
  eventBus.on('tool:execution:chunk', handler);

  const start = Date.now();
  const data = await run('sleep 5', { timeout: 10000, description: 'sleep 测试' });
  eventBus.off('tool:execution:chunk', handler);

  const elapsed = Date.now() - start;
  printResult(data, { elapsed, chunkCount: chunks.length });

  assert(data.interrupted === false, `命令应正常完成，interrupted=${data.interrupted}`);
  assert(chunks.length >= 1, `应触发至少1个 chunk 事件，实际=${chunks.length}`);
  const gar = BashTool.genResultForAssistant(data);
  assert(gar === '(no content)', `genResultForAssistant 应为 "(no content)"，实际=${gar}`);
});

// ─── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
process.exit(failed > 0 ? 1 : 0);
