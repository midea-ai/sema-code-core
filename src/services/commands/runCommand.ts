import type Anthropic from '@anthropic-ai/sdk';
import { logInfo, logDebug, logError } from '../../util/log';
import { EventBus } from '../../events/EventSystem';
import { getStateManager, MAIN_AGENT_ID } from '../../manager/StateManager';
import { compactMessages, collectSkillActivations } from '../../util/compact';
import { CompactExecData } from '../../events/types';
import { isInterruptedException } from '../../types/errors';
import { getCommandsManager } from './commandsManager';
import { buildUserMsg } from '../../util/message';
import { getTokens } from '../../util/tokens';
import { getTaskManager } from '../../manager/TaskManager';
import { getAvailableTools } from '../../tools/base/tools';
import { TOOL_NAME_SKILL } from '../../prompt/tool';
import { generatePostCompactReminders } from '../agents/genSystemReminder';
import { wrapCompactSummary } from '../../prompt/compact';
import { GOAL_START_PROMPT, GOAL_UPDATE_PROMPT } from '../../prompt/goal';
import { GOAL_MAX_ROUNDS } from '../../conf/config';
import type { GoalState, GoalInputMark } from '../../types/goal';
import type { InputSource } from '../../types/message';
import type { GoalUpdateData } from '../../events/types';
import { t } from '../../util/i18n';

interface CustomCommandResult {
  processedText: string;
  blocks: Anthropic.ContentBlockParam[];
}

// false = 非系统命令；true = 已完全处理；CustomCommandResult = 继续 query 流程
type SystemCommandHandleResult = false | true | CustomCommandResult;

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function handleCommand(input: string, sessionId: string): Promise<CustomCommandResult | null> {
  const systemResult = await handleSystemCommand(input, sessionId);
  if (systemResult === true) return null;
  if (systemResult !== false) return systemResult;
  return handleCustomCommand(input);
}

// ─── 系统命令 ────────────────────────────────────────────────────────────────

async function handleSystemCommand(input: string, sessionId: string): Promise<SystemCommandHandleResult> {
  if (input === '/compact' || input.startsWith('/compact ')) {
    // /compact <指示>：指示作为附加要求传给摘要过程（截断至 2000 字符）；无参行为不变
    const instructions = input.slice('/compact'.length).trim().slice(0, 2000);
    await handleCompactCommand(sessionId, instructions || undefined);
    return true;
  }

  if (input === '/clear' || input.startsWith('/clear ')) {
    await handleClearCommand(sessionId);
    return true;
  }

  if (input === '/goal' || input.startsWith('/goal ')) {
    return handleGoalCommand(input.slice('/goal'.length).trim(), sessionId);
  }

  return false;
}

// ─── /goal 长期目标 ───────────────────────────────────────────────────────────
// 用户输入只接受两种形态；暂停 / 删除 / 恢复 / 改文本走会话级接口（SemaSession.pauseGoal 等），不排队、立即生效
// /goal            回显状态（reason status），不进 ReAct
// /goal <文本>     目标非 running（含无目标）→ 设定新目标并跑第一轮；running → 只改文本（reason updated），
//                  本轮以一句触发语进 ReAct 让模型按新目标继续，按插话轮计（不加 round）
// 状态反馈不加 i18n 文案，统一经 goal:update 事件的 reason 交给宿主展示
function handleGoalCommand(arg: string, sessionId: string): SystemCommandHandleResult {
  const runtime = getStateManager().session(sessionId);
  const emitGoal = (data: GoalUpdateData) => EventBus.getInstance().emit('goal:update', data, sessionId);
  const goal = runtime.getGoal();

  if (arg === '') {
    emitGoal({ goal, reason: 'status' });
    return true;
  }

  if (goal?.status === 'running') {
    const updated: GoalState = { ...goal, text: arg, updatedAt: Date.now() };
    runtime.setGoal(updated);
    emitGoal({ goal: updated, reason: 'updated' });
    return { processedText: GOAL_UPDATE_PROMPT, blocks: [{ type: 'text', text: GOAL_UPDATE_PROMPT }] };
  }

  const now = Date.now();
  const created: GoalState = {
    text: arg,
    status: 'running',
    round: 1,
    maxRounds: GOAL_MAX_ROUNDS,
    idleRounds: 0,
    createdAt: now,
    updatedAt: now,
  };
  runtime.setGoal(created);
  emitGoal({ goal: created, reason: 'set' });
  return { processedText: GOAL_START_PROMPT, blocks: [{ type: 'text', text: GOAL_START_PROMPT }] };
}

/**
 * 计算一条输入的长期目标标记（挂到 input:received / input:processing 与持久化 UserMsg）。
 * - source='goal' 的自动续轮输入 → round（轮数取当前目标）
 * - /goal <文本> → 目标 running 时 update，否则 set（round 1）；裸 /goal 与其他输入无标记
 * 按调用时刻的目标状态判定：input:received 在排队时是预判，input:processing 紧邻命令执行，以它为准
 */
export function goalInputMark(input: string, source: InputSource | undefined, sessionId: string): GoalInputMark | undefined {
  const goal = getStateManager().session(sessionId).getGoal();
  if (source === 'goal') {
    return goal ? { action: 'round', round: goal.round, maxRounds: goal.maxRounds } : undefined;
  }
  if (!input.startsWith('/goal ') || input.slice('/goal '.length).trim() === '') return undefined;
  return goal?.status === 'running'
    ? { action: 'update', round: goal.round, maxRounds: goal.maxRounds }
    : { action: 'set', round: 1, maxRounds: GOAL_MAX_ROUNDS };
}

async function handleClearCommand(sessionId: string): Promise<void> {
  logInfo('执行清空命令...');

  // 关闭本会话的后台进程
  getTaskManager().disposeSession(sessionId);

  const eventBus = EventBus.getInstance();
  const runtime = getStateManager().session(sessionId);
  const mainAgentState = runtime.forAgent(MAIN_AGENT_ID);

  // 先清空 todos 和 readFileTimestamps，确保保存到文件时也是空的
  mainAgentState.updateTodosIntelligently([]);
  mainAgentState.setReadFileTimestamps({});
  // 长期目标随 /clear 一并清除（clearAllState 不碰 goal，只在这里清）
  runtime.setGoal(null);

  mainAgentState.setMessageHistory([]);
  mainAgentState.updateState('idle');
  eventBus.emit('session:cleared', { sessionId }, sessionId);
  eventBus.emit('conversation:usage', { usage: getTokens([], sessionId) }, sessionId);
  runtime.clearAllState();
}

async function handleCompactCommand(sessionId: string, customInstructions?: string): Promise<void> {
  logInfo('执行压缩命令...');

  // 关闭本会话的后台进程
  getTaskManager().disposeSession(sessionId);

  const eventBus = EventBus.getInstance();
  const runtime = getStateManager().session(sessionId);
  const mainAgentState = runtime.forAgent(MAIN_AGENT_ID);
  const messages = mainAgentState.getMessageHistory();

  if (messages.length === 0) {
    const errMsg = t('error.compactEmptyHistory');
    logInfo(errMsg);
    eventBus.emit('compact:exec', {
      errMsg,
      tokenBefore: 0,
      tokenCompact: 0,
      compactRate: 0,
    } satisfies CompactExecData, sessionId);
    runtime.currentAbortController = null;
    mainAgentState.updateState('idle');
    return;
  }

  runtime.currentAbortController = new AbortController();

  try {
    logDebug(`开始手动压缩，当前消息数: ${messages.length}`);

    const result = await compactMessages(messages, runtime.currentAbortController, sessionId, {
      allowTruncationFallback: false,
      customInstructions,
    });

    if (result.kind === 'unchanged') {
      logInfo('Not enough history to compact, skip compact');
      return;
    }

    if (result.kind !== 'summary') {
      const errorMsg = t('error.compactNoSummary', { kind: result.kind });
      logError(errorMsg);
      eventBus.emit('session:error', {
        type: 'compact_error',
        error: {
          code: 'COMPACT_FAILED',
          message: errorMsg,
          details: result.kind === 'failed'
            ? { error: result.error }
            : { reason: result.reason },
        },
      }, sessionId);
      return;
    }

    // 压缩后清空 readFileTimestamps（促使模型重新读取文件）；todos 不清空：
    // 模型侧 todo 工具读 todoTasksMap（从未被清），清 UI 投影只造成面板闪空的不一致
    mainAgentState.setReadFileTimestamps({});

    // 与自动压缩路径同口径：重新注入被压掉的 skill 原文与 skills/rules reminder。
    // 手动压缩替换全部历史，被压区间即完整消息列表，无需幸存过滤
    const hasSkillTool = getAvailableTools(undefined, { sessionId })
      .some(tool => tool.name === TOOL_NAME_SKILL);
    const reminders = await generatePostCompactReminders(hasSkillTool, collectSkillActivations(messages));

    // reminder 前置，摘要带续接包装（来源说明 + 直接续做指示）
    mainAgentState.setMessageHistory([
      buildUserMsg([...reminders, { type: 'text', text: wrapCompactSummary(result.summary) }]),
    ]);

    logDebug('压缩完成，已替换为 local-command 格式消息历史');
  } catch (error) {
    if (isInterruptedException(error)) {
      logInfo('压缩操作被用户中断');
      return;
    }
    const errorMsg = t('error.compactFailed', { error: error instanceof Error ? error.message : String(error) });
    logError(errorMsg);
    eventBus.emit('session:error', {
      type: 'compact_error',
      error: { code: 'COMPACT_FAILED', message: errorMsg, details: { error } },
    }, sessionId);
  } finally {
    runtime.currentAbortController = null;
    mainAgentState.updateState('idle');
  }

  logDebug('压缩命令执行完成');
}

// ─── 自定义命令 ──────────────────────────────────────────────────────────────

async function handleCustomCommand(input: string): Promise<CustomCommandResult> {
  const defaultResult: CustomCommandResult = {
    processedText: input,
    blocks: [{ type: 'text', text: input }],
  };

  if (!input.startsWith('/')) return defaultResult;

  const firstSpaceIdx = input.indexOf(' ');
  const commandName = firstSpaceIdx === -1 ? input.slice(1) : input.slice(1, firstSpaceIdx);
  const argsStr = firstSpaceIdx === -1 ? '' : input.slice(firstSpaceIdx + 1).trim();
  const args = argsStr ? argsStr.split(/\s+/) : [];

  const commandConfig = getCommandsManager().getCommandConfig(commandName);
  if (!commandConfig) {
    logDebug(`未找到自定义命令: ${commandName}`);
    return defaultResult;
  }

  const processedPrompt = args.reduce(
    (prompt, arg, i) => prompt.replace(new RegExp(`\\$${i}`, 'g'), () => arg),
    commandConfig.prompt.replace(/\$ARGUMENTS/g, () => argsStr),
  );

  logInfo(`命中自定义命令: ${commandName}，参数: ${argsStr}`);

  return {
    processedText: processedPrompt,
    blocks: [{ type: 'text', text: processedPrompt }],
  };
}