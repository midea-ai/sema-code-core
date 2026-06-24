/**
 * 入口 2：一次性执行（非交互）
 *
 * 用法：
 *   npm run exec <项目路径> "<用户输入>" [详略档位]
 *
 * 例：
 *   npm run exec /path/to/project "列出 src 下的所有文件" verbose
 *
 * 参数：
 *   1) 项目路径   Agent 操作的目标仓库
 *   2) 用户输入   要执行的指令（含空格请加引号）
 *   3) 详略档位   verbose | medium | simple | minimal（缺省 verbose）
 *
 * 详略档位（所有工具都只打印「标题」）：
 *   verbose  详细：AI 文本 + 全部工具标题 + 错误 + 子代理 + todos
 *   medium   中等：AI 文本 + 仅文件编辑/终端工具标题
 *   simple   简单：仅同步 AI 文本内容
 *   minimal  极简：仅同步最终结论
 *
 * 模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
 */
import { SemaCore } from 'sema-core';
import { MAIN_AGENT_ID } from 'sema-core/types';
import type {
  TextChunkData,
  MessageCompleteData,
  ToolExecutionCompleteData,
  SessionErrorData,
} from 'sema-core/event';
import fs from 'node:fs';

type Verbosity = 'verbose' | 'medium' | 'simple' | 'minimal';

// 文件编辑 / 终端类工具名（medium 档位只展示这些工具的标题）
const EDIT_TERMINAL_TOOLS = new Set(['write_file', 'patch_file', 'edit_notebook', 'run_shell']);
// 文件编辑类（不含 run_shell）：标题后附带 +增 -删 行数
const FILE_EDIT_TOOLS = new Set(['write_file', 'patch_file', 'edit_notebook']);

const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// 按工具类型给区分化图标，比单一 🔧 更易辨认
function toolIcon(toolName: string): string {
  if (FILE_EDIT_TOOLS.has(toolName)) return '📝';
  if (toolName === 'run_shell') return '💻';
  if (toolName === 'skill') return '🧩';
  if (toolName.startsWith('mcp__')) return '🔌';
  if (toolName === 'fetch_url') return '🌐';
  return '🔧';
}

// 从工具 content（结构 {type, patch}）统计 +增 -删，如 "+12 -2" / "+12" / ""
function formatDiffStat(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: string; patch?: Array<{ newLines?: number; lines?: string[] }> };
  if (!Array.isArray(c.patch)) return '';
  let added = 0;
  let removed = 0;
  if (c.type === 'new') {
    for (const h of c.patch) added += h.newLines ?? 0;
  } else {
    for (const h of c.patch) {
      for (const line of h.lines ?? []) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
  }
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join(' ');
}

// 只读探查类工具归桶：查看文件 / 搜索 / ls 列目录 / find·pwd·探查链；其余返回 null 照常单条展示
type ReadBucket = '文件' | '搜索' | '目录' | '探查';
function readToolBucket(toolName: string, title: string): ReadBucket | null {
  if (toolName === 'view_file') return '文件';
  if (toolName === 'search_files' || toolName === 'search_content') return '搜索';
  if (toolName === 'run_shell') {
    if (isLsCommand(title)) return '目录';
    if (isFindCommand(title) || isPwdCommand(title) || isExploratoryCommand(title)) return '探查';
  }
  return null;
}

// title 形如 `cd a && ls foo`：跳过开头的 cd 段后剩余命令以 ls 开头即视为列目录
function isLsCommand(title: string): boolean {
  const segs = title.trim().split(/\s+&&\s+/).map((s) => s.trim()).filter(Boolean);
  let i = 0;
  while (i < segs.length - 1 && /^cd(?:\s|$)/.test(segs[i])) i++;
  return /^ls(?:\s|$)/.test(segs[i] ?? '');
}

// find 查找（排除 -delete/-exec 等有副作用的破坏性用法）
function isFindCommand(title: string): boolean {
  const c = title.trim();
  if (!/^find(?:\s|$)/.test(c)) return false;
  return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/.test(c);
}

function isPwdCommand(title: string): boolean {
  return /^pwd(?:\s+-(?:L|P))*\s*$/.test(title.trim());
}

// 由 && 串起且每段都是 ls / find / pwd 的纯探查链
function isExploratoryCommand(title: string): boolean {
  const segs = title.trim().split(/\s+&&\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  return segs.every((s) => isLsCommand(s) || isFindCommand(s) || isPwdCommand(s));
}

function parseArgs(): { projectPath: string; userInput: string; verbosity: Verbosity } {
  // 取位置参数（过滤掉 - 开头的 flag，与 cli 一致；无需 -- 透传）
  const [projectPath, userInput, rawVerbosity] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (!projectPath || !userInput) {
    console.error('用法: npm run exec <项目路径> "<用户输入>" [verbose|medium|simple|minimal]');
    process.exit(1);
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    console.error(`项目路径不存在或不是目录: ${projectPath}`);
    process.exit(1);
  }
  const allowed: Verbosity[] = ['verbose', 'medium', 'simple', 'minimal'];
  const verbosity = (rawVerbosity as Verbosity) || 'verbose';
  if (!allowed.includes(verbosity)) {
    console.error(`未知档位 "${rawVerbosity}"，可选：${allowed.join(' | ')}`);
    process.exit(1);
  }
  return { projectPath, userInput, verbosity };
}

async function main(): Promise<void> {
  const { projectPath, userInput, verbosity } = parseArgs();

  const core = new SemaCore({
    workingDir: projectPath,
    logLevel: 'none',
    thinking: true,
    disableTopicDetection: true,
    disableBackgroundTasks: true,
    disabledTools: ['ask_form', 'plan_to_agent'],

    // 非交互：直接跳过所有权限检查，避免一次性执行卡在权限询问
    // （不同于 AutoRun——AutoRun 仍会用快速模型判断，命中风险会转人工，无人应答时会挂起）
    skipShellExecPermission: true,
    skipFileEditPermission: true,
    skipSkillPermission: true,
    skipMCPToolPermission: true,
    skipFetchUrlPermission: true,
    skipExternalFileReadPermission: true,
  });

  const result = await core.createSession();
  if (!result.ok) {
    console.error('创建会话失败:', result.error);
    process.exit(1);
  }
  const session = result.session;

  const isMinimal = verbosity === 'minimal';
  const isVerbose = verbosity === 'verbose';

  let finalText = '';
  let pendingNewline = false; // stdout 是否停在半行（流式写入后未换行）
  // message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内
  let subAgentDepth = 0;

  const isMain = (agentId?: string) => agentId === MAIN_AGENT_ID || !agentId;
  const flushNewline = () => {
    if (pendingNewline) {
      process.stdout.write('\n');
      pendingNewline = false;
    }
  };

  // 连续的只读探查工具先攒着，遇到文字 / 非只读工具 / turn 结束时合并成一条 🔍 汇总，避免逐条刷屏
  const pendingReads: ReadBucket[] = [];
  const flushReadBatch = () => {
    if (pendingReads.length === 0) return;
    const count = (b: ReadBucket) => pendingReads.filter((x) => x === b).length;
    const parts: string[] = [];
    if (count('文件')) parts.push(`读取 ${count('文件')} 个文件`);
    if (count('搜索')) parts.push(`搜索 ${count('搜索')} 次`);
    if (count('目录')) parts.push(`列出 ${count('目录')} 个目录`);
    if (count('探查')) parts.push(`探查 ${count('探查')} 次`);
    pendingReads.length = 0;
    flushNewline();
    console.log(gray(`🔍 ${parts.join('、')}`));
  };

  session.on('task:agent:start', (d: { title: string }) => {
    subAgentDepth++;
    if (isVerbose) {
      flushNewline();
      console.log(gray(`🤖 子代理开始: ${d.title}`));
    }
  });
  session.on('task:agent:end', (d: { title: string }) => {
    if (subAgentDepth > 0) subAgentDepth--;
    if (isVerbose) console.log(gray(`✅ 子代理结束: ${d.title}`));
  });

  // 文本流式（仅主代理）；minimal 不流式，只在 message:complete 记录结论
  if (!isMinimal) {
    session.on('message:text:chunk', ({ delta }: TextChunkData) => {
      if (subAgentDepth > 0 || !delta) return;
      flushReadBatch(); // 主代理开始说话前，先把攒着的只读探查汇总打出来
      process.stdout.write(delta);
      pendingNewline = true;
    });
  }

  session.on('message:complete', (d: MessageCompleteData) => {
    if (!isMain(d.agentId)) return;
    if (!isMinimal) flushNewline();
    // 只在本轮不再调工具（turn 结束）时冲刷；中间的纯工具轮不切断连续的只读探查
    if (!d.hasToolCalls) {
      flushReadBatch();
      if (d.content) finalText = d.content;
    }
  });

  const printTool = (d: ToolExecutionCompleteData) => {
    flushReadBatch();
    flushNewline();
    const label = d.title?.trim() || d.toolName;
    const stat = FILE_EDIT_TOOLS.has(d.toolName) ? formatDiffStat(d.content) : '';
    console.log(gray(`${toolIcon(d.toolName)} ${label}${stat ? ' ' + stat : ''}`));
  };

  const onTool = (d: ToolExecutionCompleteData) => {
    if (!isMain(d.agentId)) return;
    // 只读探查类：verbose 攒着合并汇总；medium 不显示只读信息
    const bucket = readToolBucket(d.toolName, (d.title ?? '').trim());
    if (bucket) {
      if (isVerbose) pendingReads.push(bucket);
      return;
    }
    // medium 只展示文件编辑与终端工具，其余（skill / mcp / fetch 等）不外发
    if (verbosity === 'medium' && !EDIT_TERMINAL_TOOLS.has(d.toolName)) return;
    printTool(d);
  };

  if (isVerbose || verbosity === 'medium') {
    session.on('tool:execution:complete', onTool);
  }
  if (isVerbose) {
    session.on('tool:execution:error', (d: { title?: string; toolName?: string; agentId?: string }) => {
      if (!isMain(d.agentId)) return;
      flushReadBatch();
      flushNewline();
      console.log(gray(`❌ ${d.title?.trim() || d.toolName || '工具执行失败'}`));
    });
    session.on('todos:update', (todos: Array<{ content?: string }>) => {
      flushReadBatch();
      flushNewline();
      console.log(gray(`📋 todos: ${todos.length} 项`));
    });
  }
  // 完成信号：主代理回到 idle（整轮含工具调用结束后只发一次 idle）
  await new Promise<void>((resolve, reject) => {
    session.once('session:error', (d: SessionErrorData) => {
      flushReadBatch();
      reject(new Error(d.error?.message ?? d.type));
    });
    session.on('state:update', ({ state }: { state: string }) => {
      if (state === 'idle') resolve();
    });
    session.once('session:ready', () => session.processUserInput(userInput));
  });

  if (isMinimal) {
    process.stdout.write(green(finalText || '(无结论)') + '\n');
  }

  core.closeSession(session.sessionId);
  await core.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error('错误:', err);
  process.exit(1);
});
