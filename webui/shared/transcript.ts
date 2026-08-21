/**
 * 事件 → 消息块 reducer。服务端（维护快照/落盘）与前端（实时应用）共用同一份逻辑，
 * 保证刷新恢复后的画面与实时画面一致。
 *
 * 约定：所有更新返回新的对象/数组（不原地改旧引用），便于前端按引用做渲染优化。
 */
import type {
  AgentBlock, Block, FileChange, NoticeBlock, PermissionBlock, SessionSnapshot, ToolBlock,
} from './types';
import { CRON_TOOLS, FILE_EDIT_TOOLS, MAIN_AGENT_ID } from './protocol';

export function createSnapshot(init: Pick<SessionSnapshot, 'sessionId' | 'workingDir' | 'agentMode' | 'permissionLevel'>): SessionSnapshot {
  return {
    ...init,
    seq: 0,
    state: 'idle',
    todos: [],
    blocks: [],
    turn: null,
  };
}

// ==================== 基础操作 ====================

function findBlock(blocks: Block[], pred: (b: Block) => boolean): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (pred(b)) return b;
    if (b.kind === 'agent') {
      const inner = findBlock(b.blocks, pred);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** 在 blocks（含 agent 子块）中按谓词更新第一个（从后往前）匹配块，返回新数组；未命中返回原数组 */
function updateIn(blocks: Block[], pred: (b: Block) => boolean, fn: (b: Block) => Block): { blocks: Block[]; hit: boolean } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (pred(b)) {
      const next = blocks.slice();
      next[i] = fn(b);
      return { blocks: next, hit: true };
    }
    if (b.kind === 'agent') {
      const r = updateIn(b.blocks, pred, fn);
      if (r.hit) {
        const next = blocks.slice();
        next[i] = { ...b, blocks: r.blocks };
        return { blocks: next, hit: true };
      }
    }
  }
  return { blocks, hit: false };
}

function updateBlock(snap: SessionSnapshot, pred: (b: Block) => boolean, fn: (b: Block) => Block): boolean {
  const r = updateIn(snap.blocks, pred, fn);
  if (r.hit) snap.blocks = r.blocks;
  return r.hit;
}

/** 追加块：agentId 非主代理时挂入对应子代理卡片，找不到则退回主流 */
function pushBlock(snap: SessionSnapshot, block: Block, agentId?: string) {
  if (agentId && agentId !== MAIN_AGENT_ID) {
    const hit = updateBlock(
      snap,
      b => b.kind === 'agent' && b.id === agentId,
      b => ({ ...(b as AgentBlock), blocks: [...(b as AgentBlock).blocks, block] }),
    );
    if (hit) return;
  }
  snap.blocks = [...snap.blocks, block];
}

function notice(snap: SessionSnapshot, seq: number, noticeType: NoticeBlock['noticeType'], level: NoticeBlock['level'], text: string, detail?: string, agentId?: string) {
  pushBlock(snap, { kind: 'notice', id: `notice:${seq}`, ts: Date.now(), noticeType, level, text, detail }, agentId);
}

/** 统计增删行；新建文件的预览 hunk 只带前几行（lines 少于 newLines），按 newLines 计 */
function countPatch(patch: any[] | undefined): { additions: number; removals: number } {
  let additions = 0, removals = 0;
  for (const h of patch || []) {
    let a = 0;
    for (const l of h.lines || []) {
      if (l.startsWith('+')) a++;
      else if (l.startsWith('-')) removals++;
    }
    additions += h.oldLines === 0 && typeof h.newLines === 'number' && h.newLines > a ? h.newLines : a;
  }
  return { additions, removals };
}

function mergeFileChange(snap: SessionSnapshot, toolName: string, title: string, content: any) {
  if (!snap.turn) snap.turn = { files: {} };
  const diff = content && typeof content === 'object' && Array.isArray(content.patch) ? content : null;
  const { additions, removals } = countPatch(diff?.patch);
  const prev = snap.turn.files[title];
  const change: FileChange = prev
    ? {
      ...prev,
      toolName,
      additions: prev.additions + additions,
      removals: prev.removals + removals,
      patch: [...prev.patch, ...(diff?.patch || [])],
    }
    : { path: title, toolName, type: diff?.type === 'new' ? 'new' : 'diff', additions, removals, patch: diff?.patch || [] };
  snap.turn = { ...snap.turn, files: { ...snap.turn.files, [title]: change } };
}

function finishTurn(snap: SessionSnapshot, seq: number) {
  if (snap.turn) {
    const files = Object.values(snap.turn.files);
    if (files.length) {
      pushBlock(snap, { kind: 'file-changes', id: `files:${seq}`, ts: Date.now(), inputId: snap.turn.inputId, files });
    }
  }
  snap.turn = null;
}

function closeStreaming(snap: SessionSnapshot) {
  if (!snap.streamingId) return;
  const id = snap.streamingId;
  updateBlock(snap, b => b.kind === 'assistant' && b.id === id, b => ({ ...b, done: true } as Block));
  snap.streamingId = undefined;
}

/** 中断/结束时把未决交互卡片作废 */
function voidPending(snap: SessionSnapshot) {
  const mark = (blocks: Block[]): Block[] => blocks.map(b => {
    if (b.kind === 'permission' && !b.resolved) return { ...b, resolved: '__interrupted' };
    if (b.kind === 'pick' && !b.answered) return { ...b, answered: true, resolved: null };
    if (b.kind === 'plan-exit' && !b.resolved) return { ...b, resolved: '__interrupted' };
    if (b.kind === 'agent') return { ...b, blocks: mark(b.blocks) };
    return b;
  });
  snap.blocks = mark(snap.blocks);
}

// ==================== 事件应用 ====================

/**
 * 应用一条 core 事件。会**就地修改** snap 的顶层字段（blocks 数组本身按不可变方式替换）。
 * 调用方应先浅拷贝 snapshot 再传入（前端 store 里如此），服务端直接持有可变快照。
 */
/**
 * create_cron / del_cron 成功结果 → 定时任务卡片。
 * 工具 UI 结果无结构化字段，从 title/summary 解析：
 *   create: title=`<cron表达式>: <短标题>`，summary=`Scheduled <id> (<人话计划>)`
 *   delete: title=<id>
 */
function pushCronBlock(snap: SessionSnapshot, toolId: string, now: number, data: any): void {
  const title = String(data?.title || '');
  const summary = String(data?.summary || '');
  if (data?.toolName === 'create_cron') {
    const m = /^Scheduled\s+(\S+)\s*(?:\((.*)\))?/.exec(summary);
    if (!m) return;
    const colon = title.indexOf(': ');
    pushBlock(snap, { kind: 'cron', id: `cron:${toolId}`, ts: now, action: 'create', taskId: m[1], title: colon >= 0 ? title.slice(colon + 2) : undefined, schedule: m[2] || undefined });
  } else {
    const taskId = title.trim();
    if (!taskId) return;
    pushBlock(snap, { kind: 'cron', id: `cron:${toolId}`, ts: now, action: 'delete', taskId });
  }
}

export function applyEvent(snap: SessionSnapshot, event: string, data: any, seq: number): SessionSnapshot {
  snap.seq = seq;
  const now = Date.now();
  switch (event) {
    case 'session:ready':
      snap.historyLoaded = !!data?.historyLoaded;
      if (Array.isArray(data?.todos) && data.todos.length) snap.todos = data.todos;
      // WebUI 侧有记录但 core 历史已过期（被上限清理）：提示将作为新对话继续
      if (!snap.historyLoaded && snap.blocks.some(b => b.kind === 'user')) {
        const last = snap.blocks[snap.blocks.length - 1];
        if (!(last?.kind === 'notice' && last.noticeType === 'history-expired')) {
          notice(snap, seq, 'history-expired', 'warn', '历史已过期，模型侧无上下文，将作为新对话继续');
        }
      }
      break;

    case 'state:update': {
      snap.state = data?.state === 'processing' ? 'processing' : 'idle';
      if (snap.state === 'idle') {
        closeStreaming(snap);
        finishTurn(snap, seq);
        voidPending(snap);
        updateBlock(snap, b => b.kind === 'user' && !b.doneTs, b => ({ ...b, doneTs: now } as Block));
      }
      break;
    }

    case 'input:received': {
      pushBlock(snap, {
        kind: 'user', id: `user:${data?.inputId || seq}`, ts: now,
        inputId: data?.inputId, text: data?.originalInput || data?.input || '', queued: !!data?.queued,
        ...(data?.source && data.source !== 'user' ? { source: data.source } : {}),
      });
      break;
    }

    case 'input:processing': {
      const inputId = data?.inputId;
      const attachments = Array.isArray(data?.attachments)
        ? data.attachments.map((a: any) => ({ media_type: a.media_type, dataUrl: a.data ? `data:${a.media_type};base64,${a.data}` : undefined }))
        : undefined;
      const src = data?.source && data.source !== 'user' ? { source: data.source } : {};
      const hit = updateBlock(snap, b => b.kind === 'user' && b.inputId === inputId, b => ({ ...b, queued: false, ...src, ...(attachments?.length ? { attachments } : {}) } as Block));
      if (!hit) {
        pushBlock(snap, { kind: 'user', id: `user:${inputId || seq}`, ts: now, inputId, text: data?.originalInput || data?.input || '', attachments, ...src });
      }
      // 新一轮：上一轮若未收尾（异常路径）先落文件卡片
      if (snap.turn && Object.keys(snap.turn.files).length) finishTurn(snap, seq);
      snap.turn = { inputId, files: {} };
      break;
    }

    case 'message:thinking:chunk':
    case 'message:text:chunk': {
      const id = String(data?.id ?? '');
      const delta = String(data?.delta ?? '');
      const field = event === 'message:text:chunk' ? 'text' : 'thinking';
      const hit = updateBlock(snap, b => b.kind === 'assistant' && b.id === id && !b.done, b => ({ ...b, [field]: (b as any)[field] + delta } as Block));
      if (!hit) {
        closeStreaming(snap);
        pushBlock(snap, { kind: 'assistant', id, ts: now, agentId: MAIN_AGENT_ID, thinking: field === 'thinking' ? delta : '', text: field === 'text' ? delta : '', done: false });
      }
      snap.streamingId = id;
      break;
    }

    case 'message:complete': {
      const id = String(data?.id ?? '');
      const agentId = data?.agentId || MAIN_AGENT_ID;
      const content = String(data?.content ?? '');
      const reasoning = String(data?.reasoning ?? '');
      const hit = agentId === MAIN_AGENT_ID && updateBlock(
        snap, b => b.kind === 'assistant' && b.id === id,
        b => ({ ...b, text: content || (b as any).text, thinking: reasoning || (b as any).thinking, done: true } as Block),
      );
      if (!hit && (content || reasoning)) {
        pushBlock(snap, { kind: 'assistant', id: agentId === MAIN_AGENT_ID ? id : `${agentId}:${id}`, ts: now, agentId, thinking: reasoning, text: content, done: true }, agentId);
      }
      if (agentId === MAIN_AGENT_ID && snap.streamingId === id) snap.streamingId = undefined;
      break;
    }

    case 'tool:permission:request': {
      const block: PermissionBlock = {
        kind: 'permission', id: String(data?.toolId ?? `perm:${seq}`), ts: now, agentId: data?.agentId || MAIN_AGENT_ID,
        toolName: data?.toolName, title: data?.title, content: data?.content, options: data?.options || {},
      };
      pushBlock(snap, block, block.agentId);
      break;
    }

    case 'tool:permission:auto':
      notice(snap, seq, 'auto-permission', 'info', data?.content || '已由模型安全判断自动放行', data?.toolName, data?.agentId);
      break;

    case 'tool:execution:chunk': {
      const toolId = String(data?.toolId ?? '');
      const delta = typeof data?.content === 'string' ? data.content : JSON.stringify(data?.content ?? '');
      const hit = updateBlock(snap, b => b.kind === 'tool' && b.id === toolId, b => ({ ...b, output: ((b as ToolBlock).output || '') + delta } as Block));
      if (!hit) {
        pushBlock(snap, {
          kind: 'tool', id: toolId, ts: now, agentId: data?.agentId || MAIN_AGENT_ID, toolName: data?.toolName,
          title: data?.title || data?.toolName, summary: data?.summary, output: delta, status: 'running',
        }, data?.agentId);
      }
      break;
    }

    case 'tool:execution:complete': {
      const toolId = String(data?.toolId ?? `tool:${seq}`);
      const patch = { title: data?.title || data?.toolName, summary: data?.summary, content: data?.content, status: 'done' as const };
      const hit = updateBlock(snap, b => b.kind === 'tool' && b.id === toolId, b => ({ ...b, ...patch } as Block));
      if (!hit) {
        pushBlock(snap, { kind: 'tool', id: toolId, ts: now, agentId: data?.agentId || MAIN_AGENT_ID, toolName: data?.toolName, ...patch }, data?.agentId);
      }
      if (FILE_EDIT_TOOLS.has(data?.toolName)) mergeFileChange(snap, data.toolName, data?.title || '', data?.content);
      if (CRON_TOOLS.has(data?.toolName)) pushCronBlock(snap, toolId, now, data);
      break;
    }

    case 'tool:execution:error': {
      const toolId = String(data?.toolId ?? `toolerr:${seq}`);
      const patch = { title: data?.title || data?.toolName, content: data?.content, status: 'error' as const, input: data?.input };
      const hit = updateBlock(snap, b => b.kind === 'tool' && b.id === toolId, b => ({ ...b, ...patch } as Block));
      if (!hit) {
        pushBlock(snap, { kind: 'tool', id: toolId, ts: now, agentId: data?.agentId || MAIN_AGENT_ID, toolName: data?.toolName, ...patch }, data?.agentId);
      }
      break;
    }

    case 'task:agent:start': {
      pushBlock(snap, {
        kind: 'agent', id: String(data?.taskId), ts: now, agentType: data?.agent_type || '', title: data?.title || '',
        instructions: data?.instructions || '', status: 'running', blocks: [],
      });
      break;
    }

    case 'task:agent:end': {
      const taskId = String(data?.taskId);
      updateBlock(snap, b => b.kind === 'agent' && b.id === taskId, b => ({ ...b, status: data?.status || 'completed', result: data?.content } as Block));
      break;
    }

    case 'task:start':
    case 'task:transfer':
      notice(snap, seq, 'info', 'info', `后台任务${event === 'task:transfer' ? '（已转后台）' : ''}：${data?.command || data?.taskId || ''}`);
      break;
    case 'task:end':
      notice(snap, seq, 'info', data?.status === 'failed' ? 'warn' : 'info', `后台任务结束（${data?.status}）：${data?.summary || ''}`);
      break;

    case 'todos:update': {
      const todos = Array.isArray(data) ? data : [];
      snap.todos = todos;
      // 同一轮内原地更新（最后一个 user 块之后的 todos 块）
      let idx = -1;
      for (let i = snap.blocks.length - 1; i >= 0; i--) {
        const b = snap.blocks[i];
        if (b.kind === 'user') break;
        if (b.kind === 'todos') { idx = i; break; }
      }
      if (idx >= 0) {
        const next = snap.blocks.slice();
        next[idx] = { ...(next[idx] as any), todos };
        snap.blocks = next;
      } else {
        pushBlock(snap, { kind: 'todos', id: `todos:${seq}`, ts: now, todos });
      }
      break;
    }

    case 'pick:option:request':
      pushBlock(snap, {
        kind: 'pick', id: `pick:${seq}`, ts: now, agentId: data?.agentId || MAIN_AGENT_ID,
        questions: data?.questions || [], intro: data?.intro, estimatedTime: data?.estimatedTime,
      }, data?.agentId);
      break;

    case 'plan:exit:request':
      pushBlock(snap, {
        kind: 'plan-exit', id: `plan:${seq}`, ts: now, agentId: data?.agentId || MAIN_AGENT_ID,
        planFilePath: data?.planFilePath || '', planContent: data?.planContent || '', options: data?.options || {},
      }, data?.agentId);
      break;

    case 'plan:implement':
      notice(snap, seq, 'plan-implement', 'info', `已清理上下文，开始实施计划：${data?.planFilePath || ''}`, data?.planContent);
      break;

    case 'compact:exec':
      notice(snap, seq, 'compact', 'info',
        data?.mode === 'failed' ? `上下文压缩失败：${data?.errMsg || ''}` : `上下文已压缩：${data?.tokenBefore ?? '?'} → ${data?.tokenCompact ?? '?'} tokens`);
      break;
    case 'compact:micro':
      notice(snap, seq, 'compact-micro', 'info', `已清理 ${data?.clearedCount ?? 0} 条旧工具结果（约省 ${data?.estimatedSavedTokens ?? 0} tokens）`);
      break;

    case 'conversation:usage':
      if (data?.usage) snap.usage = data.usage;
      break;

    case 'permissionLevel:update':
      if (data?.level) snap.permissionLevel = data.level;
      break;

    case 'session:error':
      notice(snap, seq, 'error', 'error', data?.error?.message || data?.type || '会话出错', data?.error?.code);
      break;

    case 'session:interrupted': {
      const agentId = data?.agentId || MAIN_AGENT_ID;
      if (agentId !== MAIN_AGENT_ID) {
        updateBlock(snap, b => b.kind === 'agent' && b.id === agentId, b => ({ ...b, status: 'interrupted', result: data?.content } as Block));
      } else {
        closeStreaming(snap);
        voidPending(snap);
        notice(snap, seq, 'interrupted', 'warn', data?.content || '已中断');
      }
      break;
    }

    case 'session:cleared':
      snap.blocks = [];
      snap.todos = [];
      snap.turn = null;
      snap.streamingId = undefined;
      notice(snap, seq, 'cleared', 'info', '会话已清空');
      break;

    case 'hook:notice': {
      const kind = data?.kind;
      notice(snap, seq, 'hook', kind === 'systemMessage' ? 'info' : 'warn',
        `${kind === 'blocked' ? '输入被 hook 拦截：' : ''}${data?.message || ''}`, data?.hookEvent);
      break;
    }

    default:
      // topic:update / file:reference / quickchat:response 等不改变消息流
      break;
  }
  return snap;
}

// ==================== 本地动作（应答后立即标记，两端一致）====================

export type LocalAction =
  | { type: 'permission'; toolId: string; selected: string }
  | { type: 'pick'; id: string; answers: string | null }
  | { type: 'plan-exit'; id: string; selected: string }
  | { type: 'agentMode'; mode: SessionSnapshot['agentMode'] }
  | { type: 'permissionLevel'; level: SessionSnapshot['permissionLevel'] };

export function applyLocal(snap: SessionSnapshot, action: LocalAction): SessionSnapshot {
  switch (action.type) {
    case 'permission':
      updateBlock(snap, b => b.kind === 'permission' && b.id === action.toolId, b => ({ ...b, resolved: action.selected } as Block));
      break;
    case 'pick':
      updateBlock(snap, b => b.kind === 'pick' && b.id === action.id, b => ({ ...b, answered: true, resolved: action.answers } as Block));
      break;
    case 'plan-exit':
      updateBlock(snap, b => b.kind === 'plan-exit' && b.id === action.id, b => ({ ...b, resolved: action.selected } as Block));
      break;
    case 'agentMode':
      snap.agentMode = action.mode;
      break;
    case 'permissionLevel':
      snap.permissionLevel = action.level;
      break;
  }
  return snap;
}

// ==================== 派生 ====================

export function pendingBlocks(snap: SessionSnapshot): Block[] {
  const out: Block[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'permission' && !b.resolved) out.push(b);
      else if (b.kind === 'pick' && !b.answered) out.push(b);
      else if (b.kind === 'plan-exit' && !b.resolved) out.push(b);
      else if (b.kind === 'agent') walk(b.blocks);
    }
  };
  walk(snap.blocks);
  return out;
}

export function firstUserText(snap: SessionSnapshot): string | undefined {
  const b = findBlock(snap.blocks, x => x.kind === 'user');
  // findBlock 从后往前，这里需要第一个
  const first = snap.blocks.find(x => x.kind === 'user') || b;
  return first && first.kind === 'user' ? first.text : undefined;
}
