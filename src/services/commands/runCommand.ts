import type Anthropic from '@anthropic-ai/sdk';
import { logInfo, logDebug, logError } from '../../util/log';
import { EventBus } from '../../events/EventSystem';
import { getStateManager, MAIN_AGENT_ID } from '../../manager/StateManager';
import { compactMessages } from '../../util/compact';
import { CompactExecData } from '../../events/types';
import { isInterruptedException } from '../../types/errors';
import { getCommandsManager } from './commandsManager';
import { buildUserMsg } from '../../util/message';
import { getTokens } from '../../util/tokens';
import { getTaskManager } from '../../manager/TaskManager';

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
  if (input === '/compact') {
    await handleCompactCommand(sessionId);
    return true;
  }

  if (input === '/clear' || input.startsWith('/clear ')) {
    await handleClearCommand(sessionId);
    return true;
  }

  return false;
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

  mainAgentState.setMessageHistory([]);
  mainAgentState.updateState('idle');
  eventBus.emit('session:cleared', { sessionId }, sessionId);
  eventBus.emit('conversation:usage', { usage: getTokens([]) }, sessionId);
  runtime.clearAllState();
}

async function handleCompactCommand(sessionId: string): Promise<void> {
  logInfo('执行压缩命令...');

  // 关闭本会话的后台进程
  getTaskManager().disposeSession(sessionId);

  const eventBus = EventBus.getInstance();
  const runtime = getStateManager().session(sessionId);
  const mainAgentState = runtime.forAgent(MAIN_AGENT_ID);
  const messages = mainAgentState.getMessageHistory();

  if (messages.length === 0) {
    const errMsg = 'Empty history, skip compact';
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
    });

    if (result.kind === 'unchanged') {
      logInfo('Not enough history to compact, skip compact');
      return;
    }

    if (result.kind !== 'summary') {
      const errorMsg = `Compact did not produce a valid summary: ${result.kind}`;
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

    // 压缩后清空 todos 和 readFileTimestamps（历史上下文已丢失，它们不再有意义）
    mainAgentState.updateTodosIntelligently([]);
    mainAgentState.setReadFileTimestamps({});

    mainAgentState.setMessageHistory([
      buildUserMsg(result.summary),
    ]);

    logDebug('压缩完成，已替换为 local-command 格式消息历史');
  } catch (error) {
    if (isInterruptedException(error)) {
      logInfo('压缩操作被用户中断');
      return;
    }
    const errorMsg = `压缩失败: ${error instanceof Error ? error.message : String(error)}`;
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