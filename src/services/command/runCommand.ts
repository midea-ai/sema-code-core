import { logInfo, logDebug, logError, logWarn } from '../../util/log';
import { EventBus } from '../../events/EventSystem';
import { getStateManager, MAIN_AGENT_ID } from '../../manager/StateManager';
import { compactMessages } from '../../util/compact';
import { CompactExecData } from '../../events/types';
import { isInterruptedException } from '../../types/errors';
import { getCachedCustomCommands, resolveArguments } from '../plugins/customCommands';

/**
 * 系统命令处理模块
 */

/**
 * 处理系统命令（如 /clear, /compact 等）
 * @returns true 表示是系统命令且已处理，false 表示不是系统命令 无需进入后续步骤
 */
export async function handleSystemCommand(input: string): Promise<boolean> {
  switch (input) {
    case '/clear':
      await handleClearCommand();
      return true;

    case '/compact':
      await handleCompactCommand();
      return true;

    default:
      return false;
  }
}

/**
 * 尝试处理自定义命令
 * @param input 用户输入
 * @returns { processedInput: string, handled: boolean } 处理后的输入和是否被处理标志
 */
export async function tryHandleCustomCommand(input: string): Promise<{
  processedInput: string;
  handled: boolean;
}> {
  const eventBus = EventBus.getInstance();

  // 支持字母、数字、下划线、连字符和冒号分隔符
  const customCommandMatch = input.match(/^\/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)(?:\s+(.*))?$/);

  if (!customCommandMatch) {
    return { processedInput: input, handled: false };
  }

  const [, commandName, args = ''] = customCommandMatch;

  try {
    const customCommands = await getCachedCustomCommands();
    const command = customCommands.find(cmd => cmd.name === commandName);

    if (command) {
      // 找到自定义命令，替换输入内容
      const processedInput = resolveArguments(command.content, args);
      logInfo(`Custom command '/${commandName}' resolved, content length: ${processedInput.length}`);

      // 发出自定义命令处理事件
      eventBus.emit('command:custom:resolved', {
        commandName,
        displayName: command.displayName,
        description: command.description,
        scope: command.scope,
        args,
        originalInput: input,
        processedContent: processedInput
      });

      return { processedInput, handled: true };
    } else {
      // 命令不存在，保持原输入，让 LLM 处理
      logDebug(`Custom command '/${commandName}' not found, treating as normal input`);
      return { processedInput: input, handled: false };
    }
  } catch (error) {
    logWarn(`Failed to process custom command: ${error}`);
    // 出错时保持原输入
    return { processedInput: input, handled: false };
  }
}

/**
 * 处理清空命令
 */
async function handleClearCommand(): Promise<void> {
  logInfo('执行清空命令...');

  const eventBus = EventBus.getInstance();
  const stateManager = getStateManager();

  stateManager.setMessageHistory([])

  stateManager.updateState('idle');
  
  eventBus.emit('session:cleared', {
    sessionId: stateManager.getSessionId()
  });

  // 清空所有状态数据
  stateManager.clearAllState();
}

/**
 * 处理压缩命令
 */
async function handleCompactCommand(): Promise<void> {
  logInfo('执行压缩命令...');

  const eventBus = EventBus.getInstance();
  const stateManager = getStateManager();
  const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

  // 获取当前消息历史
  const messages = mainAgentState.getMessageHistory();

  // 如果消息历史为空，无需压缩
  if (messages.length === 0) {
    const errMsg = 'Empty history, skip compact'
    logInfo(errMsg);
    const compactExecData: CompactExecData = {
      errMsg: errMsg,
      tokenBefore: 0,
      tokenCompact: 0,
      compactRate: 0
    };
    eventBus.emit('compact:exec', compactExecData);

    stateManager.currentAbortController = null;
    mainAgentState.updateState('idle');
    return;
  }

  // 使用共享的 AbortController，这样中断会话时可以中断压缩
  stateManager.currentAbortController = new AbortController();

  try {
    logDebug(`开始手动压缩，当前消息数: ${messages.length}`);

    // 直接执行压缩，不检查阈值
    const compactedMessages = await compactMessages(
      messages,
      stateManager.currentAbortController
    );

    // 更新消息历史
    mainAgentState.setMessageHistory(compactedMessages);

    logDebug(`压缩完成，压缩后消息数: ${compactedMessages.length}`);

  } catch (error) {
    // 用户中断不作为错误处理
    if (isInterruptedException(error)) {
      logInfo('压缩操作被用户中断');
      return;
    }
    const errorMsg = `压缩失败: ${error instanceof Error ? error.message : String(error)}`;
    logError(errorMsg);
    eventBus.emit('session:error', {
      type: 'compact_error',
      error: {
        code: 'COMPACT_FAILED',
        message: errorMsg,
        details: { error }
      }
    });
  } finally {
    // 清理共享的 AbortController
    stateManager.currentAbortController = null;
    // 确保状态恢复为 idle（无论成功、跳过还是失败）
    mainAgentState.updateState('idle');
  }

  logDebug('压缩命令执行完成');
}
