import * as crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { logInfo, logDebug, setLogLevel, logWarn } from '../util/log';
import { generateSessionId } from '../util/session';
import { getTokens } from '../util/tokens';
import { loadHistory } from '../util/history';
import { detectTopicInBackground } from '../util/topic';
import { processFileReferences } from '../util/fileReference';
import { buildUserMsg, buildAdditionalReminders } from '../util/message';
import { getAvailableTools } from '../tools/base/tools';
import { takeNextBatch } from '../util/inputQueue';
import { formatSystemPrompt } from '../services/agents/genSystemPrompt';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { EventBus } from '../events/EventSystem';
import { isInterruptedException } from '../types/errors';
import type { Message } from '../types/message';
import { ReAct } from './Conversation';
import type { AgentContext } from '../types/agent'
import { getStateManager, MAIN_AGENT_ID, PendingUserInput } from '../manager/StateManager';
import { handleCommand } from '../services/commands/runCommand';
import { getTaskManager } from '../manager/TaskManager';
import { getCronManager } from '../manager/CronManager';
import { handlequickchat } from '../util/quickchat';
import { TOOL_NAME_SKILL } from '../prompt/tool';
import type { AgentMode } from '../types';


/**
 * Sema 引擎 - 处理核心业务逻辑
 */
export class SemaEngine {
  // 待处理的会话ID（只保留最新的一个）
  private pendingSession: string | null = null
  // 当前正在执行的 processQuery Promise（用于等待旧会话结束）
  private currentProcessingPromise: Promise<void> | null = null

  // 公共事件接口
  private eventBus = EventBus.getInstance();
  emit = <T>(event: string, data: T) => this.eventBus.emit(event, data as Record<string, any>);
  on = <T>(event: string, listener: (data: T) => void) => this.eventBus.on(event, listener);
  once = <T>(event: string, listener: (data: T) => void) => this.eventBus.once(event, listener);
  off = <T>(event: string, listener: (data: T) => void) => this.eventBus.off(event, listener);

  constructor() {
    // 注入后台任务通知回调：任务完成后将通知注入用户输入队列
    getTaskManager().setNotifyCallback((msg: string) => {
      this.processUserInput(msg, undefined, true)
    })

    // 注入 Cron 定时任务通知回调
    getCronManager().setNotifyCallback((msg: string) => {
      this.processUserInput(msg, undefined, true)
    })
  }

  /**
   * 创建会话
   */
  async createSession(sessionId?: string): Promise<void> {
    const finalSessionId = sessionId || generateSessionId();
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

    // 如果当前正在处理，中断并等待旧会话结束，然后 fall through 到下方统一创建新会话
    if (mainAgentState.getCurrentState() === 'processing') {
      this.pendingSession = finalSessionId; // 直接覆盖，只保留最新的会话
      this.abortCurrentRequest();
      logInfo(`会话正在处理中，中断并等待: ${finalSessionId}`);

      // 等待旧会话处理完成（最多等待10秒）
      if (this.currentProcessingPromise) {
        const waitTimeoutSecond = 10
        logInfo(`等待旧会话结束...`);
        try {
          await Promise.race([
            this.currentProcessingPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('等待超时')), 1000 * waitTimeoutSecond))
          ]);
          logInfo(`旧会话已结束`);
        } catch (error) {
          logWarn(`等待旧会话结束时出错: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 被更新的 createSession 调用覆盖（快速连续新建场景），放弃当前创建
      if (this.pendingSession !== finalSessionId) {
        logInfo(`会话创建被覆盖，放弃: ${finalSessionId}`);
        return;
      }
    }

    // 创建新会话，清空所有待处理状态
    this.abortCurrentRequest();
    stateManager.clearPendingUserInputs();  // 清空输入队列，因为这些输入属于旧会话
    this.pendingSession = null;

    // 关闭所有后台进程
    getTaskManager().dispose();

    // 清空所有状态
    stateManager.clearAllState();

    // 初始化新会话
    await this.initialize(finalSessionId);

    // 清空非持久化的定时任务，持久化任务保留
    getCronManager().clearNonDurableTasks();

    const coreConfig = getConfManager().getCoreConfig();
    const workingDir = coreConfig?.workingDir;
    logInfo(`[DEBUG] loadHistory - workingDir: ${workingDir}, coreConfig: ${JSON.stringify(coreConfig)}`);
    const historyData = await loadHistory(sessionId, workingDir);
    logInfo(`会话CoreConfig: ${JSON.stringify(coreConfig, null, 2)}`)

    // 将加载的消息历史、todos 和 readFileTimestamps 设置到主代理状态
    // 初始化时跳过自动保存，避免把刚读取的数据重复写回文件
    mainAgentState.setMessageHistory(historyData.messages, true);
    mainAgentState.setTodos(historyData.todos);
    if (historyData.todoTasks && historyData.todoTasks.length > 0) {
      // 新格式：直接恢复完整 TodoTask 数据
      stateManager.restoreTodoTasks(historyData.todoTasks);
    } else if (historyData.todos && historyData.todos.length > 0) {
      // 旧格式兼容：将 TodoItem 转换为 TodoTask
      stateManager.restoreTodoTasksFromLegacy(historyData.todos);
    }
    if (historyData.readFileTimestamps) {
      mainAgentState.setReadFileTimestamps(historyData.readFileTimestamps);
    }

    // 使用全局配置获取工作路径
    const projectConfig = getConfManager().getProjectConfig();
    const projectInputHistory = projectConfig?.history || [];

    // 获取tokens
    const usage = getTokens(mainAgentState.getMessageHistory())

    const sessionData = {
      pid: process.pid,
      workingDir: coreConfig?.workingDir,
      sessionId: stateManager.getSessionId(),
      historyLoaded: !!sessionId,
      projectInputHistory: projectInputHistory,
      usage: usage,
      todos: mainAgentState.getTodos(),
      readFileTimestamps: historyData.readFileTimestamps || {}
    };

    logInfo(`新会话创建完成，sessionId: ${stateManager.getSessionId()}`);
    this.emit('session:ready', sessionData);
    mainAgentState.updateState('idle');
  }

  /**
   * 处理用户输入
   * 如果当前正在处理中，将输入加入队列等待
   */
  processUserInput(input: string, originalInput?: string, silent?: boolean): void {
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);
    const inputId = crypto.randomUUID().replace(/-/g, '').substring(0, 8)
    const trimmedInput = input.trim()

    // quickchat 旁路：不影响状态和队列，异步处理后直接返回
    if (trimmedInput === '/quickchat' || trimmedInput.startsWith('/quickchat ')) {
      const question = trimmedInput.startsWith('/quickchat ') ? trimmedInput.slice(5).trim() : ''
      getConfManager().saveUserInputToHistory(originalInput || trimmedInput)
      if (question) {
        handlequickchat(question).catch(err => logWarn(`[quickchat] 未捕获异常: ${err instanceof Error ? err.message : String(err)}`))
      } else {
        this.emit('quickchat:response', { question: '', content: '' })
      }
      return
    }

    if (mainAgentState.getCurrentState() === 'processing') {
      const type: PendingUserInput['type'] = trimmedInput.startsWith('/') ? 'command' : 'inject'
      stateManager.addPendingUserInput({ inputId, input: trimmedInput, originalInput, silent, type })
      logInfo(`输入已入队(${type})，队列长度: ${stateManager.getPendingUserInputsLength()}`)
      if (!silent) {
        this.emit('input:received', {
          inputId,
          input: trimmedInput,
          originalInput,
          queued: true,
          inject: type === 'inject',
          queueLength: stateManager.getPendingUserInputsLength(),
        })
      }
      return
    }

    if (!silent) {
      this.emit('input:received', {
        inputId,
        input: trimmedInput,
        originalInput,
        queued: false,
        inject: false,
        queueLength: 0,
      })
    }
    this.startQuery([{ inputId, input: trimmedInput, originalInput, silent }]);
  }

  /**
   * 启动一次查询（构建上下文并调用 processQuery）
   */
  private startQuery(inputs: Array<{ inputId: string; input: string; originalInput?: string; silent?: boolean }>): void {
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);
    mainAgentState.updateState('processing');

    logInfo(`用户输入(${inputs.length}条): ${inputs.map(i => i.input).join(' | ')}`);

    // 创建新的 AbortController 用于此次处理
    stateManager.currentAbortController = new AbortController();

    // 获取核心配置
    const coreConfig = getConfManager().getCoreConfig();
    const agentMode = coreConfig?.agentMode || 'Agent';

    // 获取工具集
    const tools = getAvailableTools();

    // 构建主代理上下文
    const agentContext: AgentContext = {
      agentId: MAIN_AGENT_ID,
      abortController: stateManager.currentAbortController,
      tools,
      model: 'main',
    }

    // 保存当前的 processQuery Promise，用于等待其完成
    this.currentProcessingPromise = this.processQuery(inputs, agentContext, agentMode)
      .catch(error => {
        logWarn(`processQuery 未捕获异常: ${error instanceof Error ? error.message : String(error)}`);
        // 确保清理 AbortController（防止竞态条件）
        if (stateManager.currentAbortController === agentContext.abortController) {
          stateManager.currentAbortController = null;
        }
        mainAgentState.updateState('idle');
      })
      .finally(() => {
        // 清空 Promise 引用
        this.currentProcessingPromise = null;
      });
  }

  /**
   * 处理查询逻辑
   */
  private async processQuery(
    inputs: Array<{ inputId: string; input: string; originalInput?: string; silent?: boolean }>,
    agentContext: AgentContext,
    agentMode: AgentMode
  ): Promise<void> {
    // 获取状态管理器和主代理状态
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

    // 为每条输入发送独立的 input:processing 事件（静默输入跳过）
    for (const item of inputs) {
      if (!item.silent) {
        this.emit('input:processing', { inputId: item.inputId, input: item.input, originalInput: item.originalInput })
      }
    }

    try {
      // 将每条用户输入保存到项目配置的 history（静默输入跳过）
      for (const item of inputs) {
        if (!item.silent) {
          getConfManager().saveUserInputToHistory(item.originalInput || item.input);
        }
      }

      // 处理命令，收集所有 blocks
      const allBlocks: Anthropic.ContentBlockParam[] = [];
      let combinedProcessedText = '';

      for (const item of inputs) {
        // abort 早期检查：避免会话切换后继续执行无用操作
        if (agentContext.abortController.signal.aborted) {
          logInfo('processQuery: abort detected during handleCommand loop, skipping remaining');
          return;
        }
        const commandResult = await handleCommand(item.input);
        if (commandResult === null) {
          // 系统命令已处理（如 /compact, /clear），跳过
          continue;
        }
        combinedProcessedText += (combinedProcessedText ? '\n' : '') + commandResult.processedText;
        allBlocks.push(...commandResult.blocks);
      }

      // 如果所有输入都是系统命令（返回 null），直接结束
      if (allBlocks.length === 0) {
        return;
      }

      // abort 早期检查
      if (agentContext.abortController.signal.aborted) {
        logInfo('processQuery: abort detected after handleCommand, skipping remaining');
        return;
      }

      // 后台异步执行话题检测，不阻塞主流程（使用所有输入拼接）
      // 跳过条件：全部输入均为 silent（来自 cron / 后台任务通知等系统注入），不应改变会话话题
      const allSilent = inputs.every(i => i.silent)
      const allOriginalTexts = inputs.map(i => i.originalInput || i.input).join('\n');
      if (!allSilent && !getConfManager().getCoreConfig()?.disableTopicDetection) {
        detectTopicInBackground(
          allOriginalTexts,
          stateManager.currentAbortController,
          (result) => this.emit('topic:update', result),
        );
      }

      // 处理文件引用以获取补充信息（使用处理后的文本）
      const fileReferencesResult = await processFileReferences(combinedProcessedText, agentContext)
      logInfo(`返回文件引用信息: ${JSON.stringify(fileReferencesResult.supplementaryInfo, null, 2)}`)

      if (fileReferencesResult.supplementaryInfo.length > 0) {
        this.emit('file:reference', {
          references: fileReferencesResult.supplementaryInfo
        });
      }

      // abort 早期检查
      if (agentContext.abortController.signal.aborted) {
        logInfo('processQuery: abort detected after processFileReferences, skipping remaining');
        return;
      }

      // 1、构建系统提示（根据是否有代理配置决定）
      const hasSkillTool = agentContext.tools.some(tool => tool.name === TOOL_NAME_SKILL);
      const systemPromptContent = await formatSystemPrompt();

      // 2、构建用户消息内容
      // 2.1 获取消息历史
      const messageHistory = mainAgentState.getMessageHistory()

      // 2.2 当前用户输入
      // 构建reminder信息 文件引用 每次输入均添加，首次查询添加 todos\rules，Plan 模式添加 Plan 信息
      const additionalReminders = buildAdditionalReminders(
        fileReferencesResult.systemReminders,
        messageHistory,
        agentMode,
        hasSkillTool
      )
      const userMessage = buildUserMsg([
        ...additionalReminders,
        ...allBlocks
      ])

      // 2.3 完整消息
      const messages: Message[] = [...messageHistory, userMessage]

      // 调用 query 函数
      for await (const _message of ReAct(
        messages,
        systemPromptContent,
        agentContext,
      )) {
        // query 生成器会 yield 消息并在内部通过 finalizeMessages 更新历史
      }

    } catch (error) {
      if (isInterruptedException(error)) {
        logDebug('用户中断操作');
      }
      // API 错误已在 emitSessionError 中记录，这里不重复记录
    } finally {
      // 延迟清空 AbortController，确保所有中断逻辑执行完毕（避免竞态条件）
      const currentAbortController = stateManager.currentAbortController;
      if (currentAbortController === agentContext.abortController) {
        // 使用 setTimeout 0 确保当前执行栈完成后再清空
        setTimeout(() => {
          if (stateManager.currentAbortController === currentAbortController) {
            stateManager.currentAbortController = null;
          }
        }, 0);
      }

      // 会话切换：仅清空队列，不再递归调 createSession
      // createSession 正在等待 currentProcessingPromise，由它接手创建新会话
      if (this.pendingSession) {
        stateManager.clearPendingUserInputs();
        return;
      }

      // 处理同一会话中的待处理输入队列
      const remaining = stateManager.consumeAllPendingInputs();
      if (remaining.length > 0) {
        // 转换为 takeNextBatch 所需格式
        const pending = remaining.map(item => ({
          inputId: item.inputId,
          input: item.input,
          originalInput: item.originalInput,
          silent: item.silent,
        }))
        const batch = takeNextBatch(pending)

        // 剩余的放回队列
        if (pending.length > 0) {
          for (const item of pending) {
            const type: PendingUserInput['type'] = item.input.startsWith('/') ? 'command' : 'inject'
            stateManager.addPendingUserInput({ ...item, type })
          }
        }

        logInfo(`处理队列中 ${batch.length} 条待处理输入`)
        this.startQuery(batch)
      } else {
        mainAgentState.updateState('idle');
      }
    }
  }

  /**
   * 中止当前正在进行的请求（仅处理 AbortController）
   * 不更新状态，用于内部调用
   */
  private abortCurrentRequest(): void {
    const stateManager = getStateManager();
    const abortController = stateManager.currentAbortController;
    if (abortController && !abortController.signal.aborted) {
      logInfo('通过 AbortController 发送中断信号');
      abortController.abort();
    }
    stateManager.currentAbortController = null;
  }

  /**
   * 中断当前会话
   * 仅中断当前正在执行的请求，队列中的待处理输入不受影响
   * 由 processQuery 的 finally 决定是否继续消费队列或设为 idle
   */
  interruptSession(): void {
    this.abortCurrentRequest();
    // 不直接设 idle，由 processQuery 的 finally 决定
    // 若当前未在 processing（如已经 idle），则无需额外操作
  }

  /**
   * 更新 Agent 模式
   */
  updateAgentMode(mode: AgentMode): void {
    // 若模式值无变化，直接返回
    const currentMode = getConfManager().getCoreConfig()?.agentMode || 'Agent';
    if (currentMode === mode) {
      return;
    }

    // 更新配置
    getConfManager().updateAgentMode(mode);

    // 切换到 Plan 模式时，重置 Plan 模式信息发送状态
    if (mode === 'Plan') {
      getStateManager().resetPlanModeInfoSent();
    }

    // 切换到 Design 模式时，重置 Design 模式信息发送状态
    // 新会话由前端在切换 UI 时通过 createSession() 自行触发
    if (mode === 'Design') {
      getStateManager().resetDesignModeInfoSent();
    }
  }

  // 初始化系统
  private async initialize(sessionId?: string): Promise<void> {
    const coreConfig = getConfManager().getCoreConfig();

    // 1、设置日志级别
    setLogLevel(coreConfig?.logLevel || 'info');

    // 2、设置sessionId（如果为空则生成一个）
    const finalSessionId = sessionId || generateSessionId();
    const stateManager = getStateManager();
    stateManager.setSessionId(finalSessionId);

    // 3、从配置文件加载模型配置 ~/.sema.conf
    try {
      const modelManager = getModelManager();
      const modelProfile = modelManager.getModel('main')

      // 检查是否有可用模型
      if (!modelProfile) {
        // 发送无模型配置事件
        this.emit('config:no_models', {
          message: '未配置任何模型，请先添加模型配置',
          suggestion: ''
        });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 发送模型配置错误事件
      this.emit('session:error', {
        type: 'model_error',
        error: {
          code: 'MODEL_CONFIG_ERROR',
          message: '模型配置文件加载失败，可尝试删除模型配置文件后重新添加模型',
          details: { error: errorMessage }
        }
      });
      throw error;
    }
  }

  /**
   * 清理资源和停止所有活动
   */
  dispose(): void {
    logInfo('开始清理 SemaEngine 资源...');

    // 1. 中止当前正在进行的请求并清空队列
    this.abortCurrentRequest();
    getStateManager().clearPendingUserInputs();
    this.pendingSession = null;

    // 2. 清空所有状态数据
    const stateManager = getStateManager();
    stateManager.clearAllState();

    // 3. 移除所有事件监听器
    this.eventBus.removeAllListeners();

    logInfo('SemaEngine 资源清理完成');
  }
}