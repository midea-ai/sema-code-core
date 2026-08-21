/**
 * 渲染预览用 mock 消息块：覆盖 chat 中全部块类型与工具卡片，便于对样式。
 *
 * 用法（改常量后刷新页面即可）：
 *   PREVIEW_COMPONENTS = null            → 预览全部组件
 *   PREVIEW_COMPONENTS = ['Edit','Shell'] → 只预览指定组件（key 见 mockBlockMap）
 *   PREVIEW_COMPONENTS = []              → 关闭预览（正常模式，侧栏不出现预览会话）
 *   PREVIEW_PROCESSING = true            → 预览会话状态为「处理中」（显示状态行/计时）
 */
import type { Block, SessionSnapshot, TodoItem } from '../../../shared/types';

/** 手动切换预览范围：null = 全部，['xx'] = 指定组件，[] = 关闭 */
export const PREVIEW_COMPONENTS: string[] | null = [];
/** 预览会话是否处于「处理中」状态 */
export const PREVIEW_PROCESSING = false;

/** 是否开启预览 */
export const PREVIEW_MODE = PREVIEW_COMPONENTS === null || (PREVIEW_COMPONENTS as string[]).length > 0;

let seq = 0;
const T0 = Date.now() - 10 * 60_000;
const nextId = () => `mock-${++seq}`;
const nextTs = () => T0 + seq * 1500;
const base = () => ({ id: nextId(), ts: nextTs() });

const MAIN = 'main';

const NEW_FILE_DIFF = {
  type: 'new' as const,
  patch: [{
    oldStart: 0, oldLines: 0, newStart: 1, newLines: 6,
    lines: [
      '+export class ConfigCache {',
      '+    private store = new Map<string, any>();',
      '+    get(key: string) { return this.store.get(key); }',
      '+    set(key: string, val: any) { this.store.set(key, val); }',
      '+    has(key: string) { return this.store.has(key); }',
      '+}',
    ],
  }],
  diffText: '',
};

const LONG_SHELL = `python3 -c "
import pandas as pd
import openpyxl
# Step 1: Read all sheet names and data
wb = openpyxl.load_workbook('/Users/zhoujie195/ReactProject/sema-design-test/src/估价样例.xlsx', data_only=False)
print('=== Sheet Names ===')
print(wb.sheetnames)
print()
" 2>&1`;

const ASK_FORM = {
  agentId: 'mock-agent-history',
  estimatedTime: '30 秒',
  intro: '回答后我会基于这些选择直接生成首屏方案',
  questions: [
    { type: 'radio', id: 'visual_style', label: '视觉气质', required: true, options: ['极简高级 / Apple 风格', '科技未来感', '商务稳重', '活泼年轻'] },
    { type: 'checkbox', id: 'core_modules', label: '核心模块', required: true, options: ['游戏核心逻辑', 'UI界面渲染', '输入控制系统', '动画效果', '数据存储'], maxSelections: 3 },
    { type: 'select', id: 'page_count', label: '大概多少页面？', options: ['1-3 页', '4-6 页', '7-10 页', '10 页以上'] },
    { type: 'text', id: 'project_name', label: '项目名称', placeholder: '请输入项目名称' },
    { type: 'textarea', id: 'extra_notes', label: '其他备注', placeholder: '可选：补充任何需要特别说明的内容' },
  ],
};

const PLAN_CONTENT = '# Optimization Plan\n\n## Steps\n1. ~~Analyze codebase~~ ✅\n2. ~~Add caching~~ ✅\n3. Update `callers`\n4. Write testsebase~~ ✅\n2. ~~Add caching~~ ✅\n3. Update `callers`\n4. Write testsebase~~ ✅\n2. ~~Add caching~~ ✅\n3. Update `callers`\n4. Write tests';

const MOCK_TODOS: TodoItem[] = [
  { id: '1', title: '分析代码结构', status: 'completed', progressText: '' },
  { id: '2', title: '添加缓存层', status: 'completed', progressText: '' },
  { id: '3', title: '更新所有调用方', status: 'in_progress', progressText: '正在更新 src/app/index.ts ...' },
  { id: '4', title: '添加缓存失效逻辑', status: 'pending', progressText: '' },
  { id: '5', title: '编写集成测试', status: 'pending', progressText: '' },
];

/** ForkDialog：回退预览（session.getForkPreview 的 mock 返回） */
export const MOCK_FORK_PREVIEW = {
  messageUuid: 'mock-fork-uuid-1',
  canRestoreFiles: true,
  files: [
    { filePath: '/ws/src/utils/config.ts', displayPath: 'src/utils/config.ts', effect: 'modify', additions: 12, removals: 5 },
    { filePath: '/Users/zhoujie195/midea-code/sema-vscode-extension/ws/src/app/index.ts', displayPath: '/Users/zhoujie195/midea-code/sema-vscode-extension/src/app/index.ts', effect: 'modify', additions: 3, removals: 2 },
    { filePath: '/ws/src/legacy/oldLoader.ts', displayPath: 'src/legacy/oldLoader.ts', effect: 'recreate', additions: 40, removals: 0 },
    { filePath: '/ws/src/utils/configCache.ts', displayPath: 'src/utils/configCache.ts', effect: 'delete', additions: 0, removals: 6 },
    { filePath: '/ws/assets/logo.png', displayPath: 'assets/logo.png', effect: 'modify', additions: 0, removals: 0, binary: true },
  ],
};

/**
 * 与 sema-vscode-extension 的 mockMessages.ts 一一对应（key 同名、文本相同），WebUI 不支持的类型省略：
 * FileReference / ProcessingSpinner / ModelConfigReminder / QuickChatDialog（无对应块），ForkDialog 见 MOCK_FORK_PREVIEW。
 * 注意 ChatView 以用户消息为界切分「轮次」，轮次内的工具默认折叠，因此 UserInput 放在最后，其余块平铺渲染。
 */
export const mockBlockMap: Record<string, Block[]> = {
  AssistantThinking: [
    { ...base(), kind: 'assistant', agentId: MAIN, done: false, text: '', thinking: '让我先读取这个文件，了解它的结构和逻辑，然后分析性能瓶颈。\n\n我需要关注以下几点：\n1. 是否有不必要的重复计算\n2. 数据结构是否合理\n3. 是否有可以缓存的结果' },
  ],

  Read: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'view_file', title: 'src/utils/config.ts:1-30', status: 'done', content: '' },
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'view_file', title: '/Users/user/outside-project/image.jpg', status: 'done', content: '' },
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'view_file', title: 'notebooks/analysis.ipynb:1-10', status: 'done', content: '# Notebook cell contents...' },
  ],

  Glob: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'search_files', title: 'src/**/*.config.ts', input: { pattern: 'src/**/*.config.ts' }, summary: '3 files found', status: 'done', content: 'src/utils/config.ts\nsrc/app/app.config.ts\nsrc/test/test.config.ts' },
  ],

  Grep: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'search_content', title: 'getConfig', input: { pattern: 'getConfig' }, summary: '5 files matched', status: 'done', content: 'src/utils/config.ts:12: export function getConfig()\nsrc/app/index.ts:5: import { getConfig } from "../utils/config"\nsrc/app/index.ts:18: const cfg = getConfig()\nsrc/test/config.test.ts:8: getConfig()\nsrc/test/config.test.ts:15: getConfig("custom.json")' },
  ],

  McpTool: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'mcp__github__search_repositories', title: 'query: sema-code language:typescript', summary: '2 repositories found', status: 'done', content: 'sema-code/vscode-extension ⭐ 128\nsema-code/cli ⭐ 56' },
  ],

  BackgroundJob: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'peek_bg_job', title: 'a3f2b1c0', status: 'done', content: '[12:00:01] Starting compilation...\n[12:00:03] Found 0 errors. Watching for file changes.\n[12:00:15] File change detected. Starting incremental compilation...\n[12:00:16] Found 0 errors. Watching for file changes.\n[12:00:15] File change detected. Starting incremental compilation...\n[12:00:16] Found 0 errors. Watching for file changes.' },
  ],

  StopBackgroundJob: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'stop_bg_job', title: 'a3f2b1c0', status: 'done', content: 'npm run dev · stopped' },
  ],

  Edit: [
    {
      ...base(), kind: 'tool', agentId: MAIN, toolName: 'patch_file', title: 'src/utils/config.ts', status: 'done',
      content: {
        type: 'diff' as const,
        patch: [{
          oldStart: 10, oldLines: 5, newStart: 10, newLines: 7,
          lines: [
            ' import { readFileSync } from "fs";',
            '-const config = JSON.parse(readFileSync(configPath, "utf-8"));',
            '-export function getConfig() {',
            '-    return config;',
            '-}',
            '+const configCache = new Map<string, any>();',
            '+export function getConfig(path: string = configPath) {',
            '+    if (configCache.has(path)) {',
            '+        return configCache.get(path);',
            '+    }',
            '+    const config = JSON.parse(readFileSync(path, "utf-8"));',
            '+    configCache.set(path, config);',
            '+    return config;',
            '+}',
          ],
        }],
        diffText: '',
      },
    },
    {
      ...base(), kind: 'tool', agentId: MAIN, toolName: 'patch_file', title: 'src/components/UpdateCodeDiff.tsx', status: 'done',
      content: {
        type: 'diff' as const,
        patch: [{
          oldStart: 119, oldLines: 19, newStart: 119, newLines: 21,
          lines: [
            '-const renderContent = (row: RenderRow): React.ReactNode => {',
            '+const renderContent = (row: RenderRow, language: string): React.ReactNode => {',
            '   if (!row.content) return <span>&#x200B;</span>;',
            ' ',
            "   if ((row.type === 'removed' || row.type === 'added') && row.diffParts) {",
            '     return (',
            '       <span>',
            '         {row.diffParts.map((part, i) => {',
            '+          const html = getHighlightedHtml(part.value, language);',
            '           if (part.removed)',
            '-            return <span key={i} className="diff-highlight diff-highlight-removed">{part.value}</span>;',
            '+            return <span key={i} className="diff-highlight diff-highlight-removed" dangerouslySetInnerHTML={{ __html: html }} />;',
            '           if (part.added)',
            '-            return <span key={i} className="diff-highlight diff-highlight-added">{part.value}</span>;',
            '-          return <span key={i}>{part.value}</span>;',
            '+            return <span key={i} className="diff-highlight diff-highlight-added" dangerouslySetInnerHTML={{ __html: html }} />;',
            '+          return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;',
            '         })}',
            '       </span>',
            '     );',
            '   }',
            ' ',
            '-  return <span>{row.content}</span>;',
            '+  const html = getHighlightedHtml(row.content, language);',
            '+  return <span dangerouslySetInnerHTML={{ __html: html }} />;',
            ' };',
          ],
        }],
        diffText: '',
      },
    },
    {
      ...base(), kind: 'tool', agentId: MAIN, toolName: 'patch_file', title: 'src/utils/diff.ts', status: 'done',
      content: {
        type: 'diff' as const,
        patch: [{
          oldStart: 215, oldLines: 17, newStart: 215, newLines: 19,
          lines: [
            "         while (i < result.length && result[i].type === 'added') i++;",
            '         const addedEnd = i;',
            ' ',
            '-        // 只对第一行做词级 diff',
            '-        if (removedEnd > removedStart && addedEnd > addedStart) {',
            '+        const pairCount = Math.min(removedEnd - removedStart, addedEnd - addedStart);',
            '+        for (let k = 0; k < pairCount; k++) {',
            '+          const removedIdx = removedStart + k;',
            '+          const addedIdx = addedStart + k;',
            '           const changes = diffWordsWithSpace(',
            '-            result[removedStart].content,',
            '-            result[addedStart].content,',
            '+            result[removedIdx].content,',
            '+            result[addedIdx].content,',
            '           );',
            '           const total = changes.reduce((s, c) => s + c.value.length, 0);',
            '           const changed = changes.reduce((s, c) => s + (c.added || c.removed ? c.value.length : 0), 0);',
            '           if (total === 0 || changed / total <= WORD_DIFF_MAX_CHANGE_RATIO) {',
            '-            result[removedStart].diffParts = changes.filter((c) => !c.added);',
            '-            result[addedStart].diffParts = changes.filter((c) => !c.removed);',
            '+            result[removedIdx].diffParts = changes.filter((c) => !c.added);',
            '+            result[addedIdx].diffParts = changes.filter((c) => !c.removed);',
            '           }',
            '         }',
            '       } else {',
          ],
        }],
        diffText: '',
      },
    },
  ],

  Write: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'write_file', title: 'src/utils/configCache.ts', status: 'done', content: NEW_FILE_DIFF },
  ],

  NotebookEdit: [
    {
      ...base(), kind: 'tool', agentId: MAIN, toolName: 'edit_notebook', title: 'notebooks/analysis.ipynb cell:4', status: 'done',
      content: {
        type: 'diff' as const,
        patch: [{
          oldStart: 1, oldLines: 3, newStart: 1, newLines: 5,
          lines: [
            ' import pandas as pd',
            '-df = pd.read_csv("data.csv")',
            '-print(df.head())',
            '+import numpy as np',
            '+df = pd.read_csv("data.csv", dtype={"id": np.int64})',
            '+df = df.dropna(subset=["value"])',
            '+print(f"Loaded {len(df)} rows")',
            '+df.head()',
          ],
        }],
        diffText: '',
      },
    },
  ],

  Shell: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'run_shell', summary: '读取 Excel 所有工作表名称并打印', title: LONG_SHELL, status: 'done', content: 'PASS  src/utils/config.test.ts\n  ✓ should load config (12ms)\n  ✓ should validate schema (8ms)\n  ✓ should merge defaults (5ms)\n\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 tbvjhsbvhktal\nTime:        1.234s' },
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'run_shell', summary: '对 config.ts 运行 eslint 检查，这是一段足够长的摘要用于验证页面太窄时的省略号效果', title: 'npx eslint src/utils/config.ts', status: 'done', content: '' },
  ],

  AssistantMarkdown: [
    {
      ...base(), kind: 'assistant', agentId: MAIN, thinking: '', done: true,
      text: `我已经完成了以下优化：

1. **添加了缓存层** - 使用 \`Map\` 缓存已解析的配置，避免重复 IO 和 JSON 解析
2. **新建了 \`configCache.ts\`** - 抽离缓存逻辑为独立模块

\`\`\`typescript
// 优化前：每次调用都读取文件
const config = JSON.parse(readFileSync(configPath, "utf-8"));

// 优化后：首次读取后缓存
const configCache = new Map<string, any>();
export function getConfig(path: string) {
    if (configCache.has(path)) return configCache.get(path);
    // ...
}
\`\`\`

> 测试全部通过，共 3 个用例。`,
    },
    {
      ...base(), kind: 'assistant', agentId: MAIN, thinking: '', done: true,
      text: `### 4.1 多租户隔离模型

当 Sema Core 被嵌入多租户环境时（例如一个同时服务多个用户的 Agent 平台），多个引擎实例必须在同一进程内并发运行。传统的全局单例设计中，$n$ 个 Agent 实例 $\\mathcal{A} = \\{A_1, A_2, \\ldots, A_n\\}$ 共享状态空间 $\\mathcal{S}$，任意 $A_i$ 的状态写入 $A_i \\xrightarrow{w} \\mathcal{S}$ 都可能被 $A_j\\ (j \\neq i)$ 的读操作 $A_j \\xrightarrow{r} \\mathcal{S}$ 观测到，产生不可预期的状态污染——一个用户的对话历史泄露到另一个用户的上下文中，或一个实例的中断操作意外终止了另一个实例的任务。

Sema Core 采用 Node.js 的 **AsyncLocalStorage（ALS）** 机制实现按实例的状态隔离。每个引擎实例 $E_i$ 拥有独立的资源束：

$$\\mathcal{R}_i = \\langle \\text{EventBus}_i,\\ \\text{StateManager}_i,\\ \\text{MCPManager}_i,\\ \\text{Config}_i \\rangle$$

Bash 层针对管道组合和命令注入两类风险分别处理：

$$P_{\\text{Bash}}(c) = \\text{allow} \\iff \\begin{cases} \\text{head}(c) \\in \\mathcal{W} & c \\text{ 为单一命令} \\\\ \\forall i:\\ \\text{head}(c_i) \\in \\mathcal{W} & c = c_1 \\mid \\cdots \\mid c_p \\text{ 为管道} \\end{cases}$$`,
    },
    {
      ...base(), kind: 'assistant', agentId: MAIN, thinking: '', done: true,
      text: `## 关键结论

| 项目 | 情况 |
|---|---|
| **技术栈** | 纯 Python 3 标准库，零第三方依赖 |
| **源码** | 仅 \`src/sort.py\`，递归实现**快速排序**（非原地、纯函数式写法，取首元素为 pivot） |
| **入口** | \`if __name__ == "__main__":\` 块（第 11–13 行），对 \`[5, 2, 9, 1, 7, 3]\` 排序输出 \`[1, 2, 3, 5, 7, 9]\` |
| **运行方式** | \`python3 src/sort.py\` |
| **工程化配置** | 全部缺失：无测试、无构建配置、无 CI、无 Dockerfile、无 lint 配置 |
| **Git** | 非 Git 仓库（无 \`.git\` 目录） |

## 网络

本地预览 http://localhost:3000 ，局域网 http://192.168.1.100:3000 ，
文档见 [Vite](https://vitejs.dev) 或 [React](https://react.dev)，
反馈去 [GitHub](https://github.com/vitejs/vite)。

## 图片渲染示例
远程图片（点击在浏览器打开）：
![shields](https://img.shields.io/badge/build-passing-brightgreen)
<img src="https://github.com/midea-ai/sema-code-core/raw/main/images/semacode-logo.png" />
`,
    },
    {
      ...base(), kind: 'assistant', agentId: MAIN, thinking: '', done: true,
      text: `- **概述**
  - [项目概述](https://midea-ai.github.io/sema-code-core/#/wiki/overview/project)
  - [架构设计](sort.py)
`,
    },
    {
      ...base(), kind: 'assistant', agentId: MAIN, thinking: '', done: true,
      text: `**Layout 在 iiQWorks.PLC UNI 中指的是 VS（Visual Components / iiQWorks.Sim）的 3D 场景视图**，用于查看和操作虚拟设备模型。

关键引用：
> **"PLC工程无法单独保存，layout中新建任意元素才可保存工程"** — 来自 \`(CN) iiQWorks.PLC UNI 1.0.pdf\` p.20 [1]

### 请确认

你说的 **"layout"** 具体是指：
- **iiQWorks.PLC UNI 中的编程布局界面**（软件主界面）
- **iiQWorks.Sim / Visual Components 中的 3D Layout 场景视图**（虚拟调试的 3D 场景）

可以告诉我你的具体场景，我给出更精确的操作指引。

---

## 参考文献
[1] [iiQWorks.PLC UNI 1.0 手册 p.20](file:///Users/allen/.cache/plc-knowledge-base/originals/iiqworks/%28CN%29%20iiQWorks.PLC%20UNI%201.0.pdf#page=20)
[2] [iiQWorks.PLC UNI 入门指南 (虚拟调试) p.18](file:///Users/allen/.cache/plc-knowledge-base/originals/iiqworks/%28CN%29%20iiQWorks.PLC%20UNI%20%E5%85%A5%E9%97%A8%E6%8C%87%E5%8D%97%20%28%E8%99%9A%E6%8B%9F%E8%B0%83%E8%AF%95%29%20.pdf#page=18)`,
    },
  ],

  AskQuestion: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'ask_form', title: 'User Response', status: 'done', content: '· Which library to use?: → Zod\n· Auth method?: → JWT' },
  ],

  PermissionRefused: [
    { ...base(), kind: 'permission', agentId: MAIN, toolName: 'run_shell', title: LONG_SHELL, content: '', options: {}, resolved: 'refuse' },
  ],

  PermissionInterrupted: [
    { ...base(), kind: 'permission', agentId: MAIN, toolName: 'write_file', title: 'src/utils/configCache.ts', content: NEW_FILE_DIFF, options: {}, resolved: '__interrupted' },
  ],

  AskFormHistory: [
    {
      ...base(), kind: 'pick', agentId: ASK_FORM.agentId, intro: ASK_FORM.intro, estimatedTime: ASK_FORM.estimatedTime, questions: ASK_FORM.questions, answered: true,
      resolved: '- 视觉气质: 极简高级 / Apple 风格\n- 核心模块: 游戏核心逻辑; UI界面渲染\n- 大概多少页面？: 4-6 页\n- 项目名称: sema-demo\n- 其他备注: 希望首屏加载在 2s 内',
    },
  ],

  ToolError: [
    { ...base(), kind: 'tool', agentId: MAIN, toolName: 'run_shell', title: 'npm run build', status: 'error', content: 'Error: Cannot find module \'typescript\'\n    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1075:15)' },
  ],

  Interrupted: [
    { ...base(), kind: 'notice', level: 'warn', noticeType: 'interrupted', text: '[Request interrupted by user]' },
  ],

  Compact: [
    { ...base(), kind: 'notice', level: 'info', noticeType: 'compact', text: 'Compacted' },
  ],

  Clear: [
    { ...base(), kind: 'notice', level: 'info', noticeType: 'cleared', text: '(no content)' },
  ],

  SessionError: [
    { ...base(), kind: 'notice', level: 'error', noticeType: 'error', text: 'Session expired. Please restart the conversation.' },
  ],

  TaskEndCompleted: [
    { ...base(), kind: 'notice', level: 'info', noticeType: 'info', text: '后台任务结束（completed）：Bash "ls -la /tmp" completed' },
  ],

  TaskEndFailed: [
    { ...base(), kind: 'notice', level: 'warn', noticeType: 'info', text: '后台任务结束（failed）：Agent "Analyze codebase and generate a detailed repor..." failed' },
  ],

  TaskEndKilled: [
    { ...base(), kind: 'notice', level: 'info', noticeType: 'info', text: '后台任务结束（killed）：Agent "Refactor all API endpoints to use new schema" killed' },
  ],

  Agent: [
    {
      ...base(), kind: 'agent', agentType: 'SearchCodebase', title: 'Search config usage', instructions: 'Find all usages of getConfig in the codebase', status: 'completed',
      result: 'Found 12 usages of getConfig across 5 files.\n- src/app/index.ts (3 calls)\n- src/utils/loader.ts (4 calls)\n- src/test/config.test.ts (5 calls)',
      blocks: [
        { ...base(), kind: 'user', text: '帮我看一下 src/utils/config.ts 这个文件的逻辑，然后优化一下性能' },
        { ...base(), kind: 'assistant', agentId: 'agent-mock-1', done: false, text: '', thinking: '让我先读取这个文件，了解它的结构和逻辑，然后分析性能瓶颈。我需要关注以下几点：\n1. 是否有不必要的重复计算\n2. 数据结构是否合理\n3. 是否有可以缓存的结果' },
        { ...base(), kind: 'tool', agentId: 'agent-mock-1', toolName: 'search_files', title: 'src/**/*.config.ts', input: { pattern: 'src/**/*.config.ts' }, summary: '3 files found', status: 'done', content: 'src/utils/config.ts\nsrc/app/app.config.ts\nsrc/test/test.config.ts' },
        { ...base(), kind: 'notice', level: 'warn', noticeType: 'interrupted', text: '[Request interrupted by user]' },
      ],
    },
  ],

  PlanImplement: [
    { ...base(), kind: 'notice', level: 'info', noticeType: 'plan-implement', text: '已清理上下文，开始实施计划：/workspace/plan.md', detail: PLAN_CONTENT },
  ],

  // ---------- 以下对应 mockDialogMap（未决交互 / 面板） ----------

  PermissionDialog: [
    { ...base(), kind: 'permission', agentId: 'main', toolName: 'view_file', title: '/Users/sema/design-spec.md', content: '', options: { agree: '确认', allow: '确认，本次会话不再询问 /Users/sema 目录下的读取', refuse: '拒绝' } },
    { ...base(), kind: 'permission', agentId: 'mock-agent-1', toolName: 'run_shell', title: 'rm -rf node_modules && npm install', content: '重装依赖', options: { agree: '确认', allow: '确认，本项目不再询问 `npm` 开头的命令', refuse: '拒绝' } },
    { ...base(), kind: 'permission', agentId: 'main', toolName: 'write_file', title: 'src/utils/configCache.ts', content: NEW_FILE_DIFF, options: { agree: '确认', allow: '确认, 本次会话不再询问文件编辑', refuse: '拒绝' } },
  ],

  WebFetchPermissionDialog: [
    { ...base(), kind: 'permission', agentId: 'main', toolName: 'fetch_url', title: 'https://github.com/midea-ai/sema-code-core', content: '', options: { agree: '确认', allow: '确认，本项目不再询问 github.com 域名', refuse: '拒绝' } },
  ],

  McpToolPermissionDialog: [
    {
      ...base(), kind: 'permission', agentId: 'main', toolName: 'mcp__github__search_repositories', title: 'query: sema-code language:typescript',
      content: { query: 'sema-code language:typescript', perPage: 10, sort: 'stars', query1: 'sema-code language:typescript', perPage1: 10, sort1: 'stars', query2: 'sema-code language:typescript', perPage2: 10, sort2: 'stars' },
      options: { agree: '确认', allow: '确认，本项目不再询问 `github` MCP 工具', refuse: '拒绝' },
    },
  ],

  SkillPermissionDialog: [
    {
      ...base(), kind: 'permission', agentId: 'main', toolName: 'skill', title: 'xlsx-pricing',
      content: `python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx                 # structure discovery
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --json         # formula validation
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --report      # standardized report
python3 SKILL_DIR/scripts/xlsx_unpack.py in.xlsx /tmp/work/         # unpack for XML editing
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/work/ out.xlsx          # repack after editing
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/work/ insert 5 1  # shift rows for insertion
python3 SKILL_DIR/scripts/xlsx_add_column.py /tmp/work/ --col G ... # add column with formulas
python3 SKILL_DIR/scripts/xlsx_insert_row.py /tmp/work/ --at 6 ...  # insert row with data`,
      options: { agree: '确认', allow: '确认，本次会话不再询问 `xlsx-pricing` Skill', refuse: '拒绝' },
    },
  ],

  AskFormDialog: [
    {
      ...base(), kind: 'pick', agentId: 'mock-agent-2', estimatedTime: '30 秒', intro: '回答后我会基于这些选择直接生成首屏方案',
      questions: [
        { type: 'radio', id: 'visual_style', label: '视觉气质', required: true, options: ['极简高级 / Apple 风格', '科技未来感', '商务稳重', '活泼年轻'] },
        { type: 'checkbox', id: 'core_modules', label: '核心模块（可多选，最多 3 项）', required: true, options: ['游戏核心逻辑', 'UI界面渲染', '输入控制系统', '动画效果', '数据存储'], maxSelections: 3 },
        { type: 'select', id: 'page_count', label: '大概多少页面？', options: ['1-3 页', '4-6 页', '7-10 页', '10 页以上'] },
        { type: 'text', id: 'project_name', label: '项目名称', placeholder: '请输入项目名称' },
        { type: 'textarea', id: 'extra_notes', label: '其他备注', placeholder: '可选：补充任何需要特别说明的内容' },
      ],
    },
  ],

  PlanExitDialog: [
    { ...base(), kind: 'plan-exit', agentId: 'mock-agent-3', planFilePath: '/workspace/plan.md', planContent: PLAN_CONTENT, options: { startEditing: '开始代码编辑', clearContextAndStart: '清理上下文，并开始代码编辑' } },
  ],

  TodosPanel: [
    { ...base(), kind: 'todos', todos: MOCK_TODOS },
  ],

  CronPanel: [
    { ...base(), kind: 'cron', action: 'create', taskId: 'a1b2c3d4', title: '构建状态检查', schedule: '每天 09:00' },
    { ...base(), kind: 'cron', action: 'delete', taskId: 'a1b2c3d4' },
  ],

  FileChangesPanel: [
    {
      ...base(), kind: 'file-changes',
      files: [
        { path: '/Users/zhoujie195/midea-code/sema-vscode-extension/src/utils/config.ts', toolName: 'patch_file', type: 'diff', additions: 12, removals: 5, patch: [] },
        { path: 'src/utils/configCache.ts', toolName: 'write_file', type: 'new', additions: 6, removals: 0, patch: [] },
        { path: 'src/app/index.ts', toolName: 'patch_file', type: 'diff', additions: 3, removals: 2, patch: [] },
        { path: 'notebooks/analysis.ipynb', toolName: 'edit_notebook', type: 'diff', additions: 0, removals: 0, patch: [] },
      ],
    },
  ],

  // 放最后：其后无内容，不会把上面的块折叠进轮次
  UserInput: [
    { ...base(), kind: 'user', inputId: 'mock-fork-uuid-1', text: '帮我看一下 src/utils/config.ts 这个文件的逻辑，然后优化一下性能', doneTs: 0 },
  ],
};

/** 根据 PREVIEW_COMPONENTS 生成最终的 mock 块列表 */
export function getPreviewBlocks(): Block[] {
  if (!PREVIEW_MODE) return [];
  const keys = PREVIEW_COMPONENTS ?? Object.keys(mockBlockMap);
  const blocks = keys.flatMap(k => mockBlockMap[k] ?? []);
  // 已结束轮次的用户消息补上 doneTs（= 该轮最后一块时间），保证「耗时」分隔线可算
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'user' || b.doneTs !== 0) continue;
    let j = i + 1;
    while (j < blocks.length && blocks[j].kind !== 'user') j++;
    b.doneTs = blocks[j - 1].ts + 800;
  }
  return blocks;
}

/** 生成预览会话快照 */
export function getPreviewSnapshot(sessionId: string, workingDir: string): SessionSnapshot {
  const blocks = getPreviewBlocks();
  return {
    sessionId,
    workingDir,
    seq: blocks.length,
    state: PREVIEW_PROCESSING ? 'processing' : 'idle',
    agentMode: 'Agent',
    permissionLevel: 'Bypass',
    usage: { useTokens: 42_000, maxTokens: 200_000, promptTokens: 38_000 },
    todos: MOCK_TODOS,
    blocks,
    turn: null,
    historyLoaded: true,
  };
}
