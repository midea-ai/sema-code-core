import Anthropic from '@anthropic-ai/sdk'
import { logInfo, logDebug, setLogLevel, logWarn } from '../util/log';
import { initializeSessionId } from '../util/session';
import { getTokens } from '../util/tokens';
import { loadHistory } from '../util/history';
import { getTopicFromUserInput } from '../util/topic';
import { processFileReferences } from '../util/fileReference';
import { createUserMessage } from '../util/message';
import { generateRulesReminders } from '../util/rules';
import { formatSystemPrompt, generateTodosReminders, generatePlanReminders } from '../services/agents/genSystemPrompt';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { getTools } from '../tools/base/tools';
import { Tool } from '../tools/base/Tool';
import { EventBus } from '../events/EventSystem';
import { isInterruptedException } from '../types/errors';
import { Message } from '../types/message';
import { query } from './Conversation';
import type { AgentContext } from '../types/agent'
import { initializeSkillRegistry, clearSkillRegistry } from '../services/skill/skillRegistry';
import { getMCPManager } from '../services/mcp/MCPManager';
import { initAgentsManager } from '../services/agents/agentsManager';
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager';
import { handleSystemCommand, tryHandleCustomCommand } from '../services/command/runCommand';
import { loadCustomCommands } from '../services/plugins/customCommands';


/**
 * Sema 引擎 - 处理核心业务逻辑
 */
export class SemaEngine {
  // 公共事件接口
  private eventBus = EventBus.getInstance();
  emit = <T>(event: string, data: T) => this.eventBus.emit(event, data as Record<string, any>);
  on = <T>(event: string, listener: (data: T) => void) => this.eventBus.on(event, listener);
  once = <T>(event: string, listener: (data: T) => void) => this.eventBus.once(event, listener);
  off = <T>(event: string, listener: (data: T) => void) => this.eventBus.off(event, listener);

  /**
   * 创建会话
   */
  async createSession(sessionId?: string): Promise<void> {
    // 中止当前正在进行的请求（如果存在）
    this.abortCurrentRequest();

    // 启动 Agents 初始化（不阻塞后续逻辑，但在 updateState('idle') 前需要完成）
    const agentsInitPromise = initAgentsManager();

    // 清空所有状态
    const stateManager = getStateManager();
    stateManager.clearAllState();

    // 初始化新会话
    await this.initialize(sessionId);
    const coreConfig = getConfManager().getCoreConfig();
    const workingDir = coreConfig?.workingDir;
    logInfo(`[DEBUG] loadHistory - workingDir: ${workingDir}, coreConfig: ${JSON.stringify(coreConfig)}`);
    const historyData = await loadHistory(sessionId, workingDir);
    logInfo(`会话CoreConfig: ${JSON.stringify(coreConfig, null, 2)}`)

    // 初始化 Skill 注册表 & 加载自定义命令（不阻塞会话创建）
    this.initializePlugins(coreConfig?.workingDir);

    // 将加载的消息历史和 todos 设置到主代理状态
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);
    mainAgentState.setMessageHistory(historyData.messages);
    mainAgentState.setTodos(historyData.todos);

    // 使用全局配置获取工作路径
    const projectConfig = getConfManager().getProjectConfig();
    const projectInputHistory = projectConfig?.history || [];

    // 获取tokens
    const usage = getTokens(mainAgentState.getMessageHistory())

    const sessionData = {
      workingDir: coreConfig?.workingDir,
      sessionId: stateManager.getSessionId(),
      historyLoaded: !!sessionId,
      projectInputHistory: projectInputHistory,
      usage: usage
    };

    // 等待 Agents 初始化完成后再设置 idle 状态
    await agentsInitPromise;

    logInfo(`新会话创建完成，sessionId: ${stateManager.getSessionId()}`);
    this.emit('session:ready', sessionData);
    mainAgentState.updateState('idle');
  }

  /**
   * 处理用户输入
   */
  processUserInput(input: string, originalInput?: string): void {
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);
    mainAgentState.updateState('processing');

    const trimmedInput = input.trim();
    logInfo(`用户输入: ${trimmedInput}`);

    // 创建新的 AbortController 用于此次处理
    stateManager.currentAbortController = new AbortController();

    // 获取核心配置
    const coreConfig = getConfManager().getCoreConfig();

    // 获取工具集
    let tools: Tool[];
    const builtinTools = getTools(coreConfig?.useTools);
    const mcpTools = getMCPManager().getMCPTools();
    tools = [...builtinTools, ...mcpTools];
    // 若 Plan 模式，去掉 TodoWrite 工具
    const agentMode = coreConfig?.agentMode || 'Agent';
    if (agentMode === 'Plan') {
      tools = tools.filter(tool => tool.name !== 'TodoWrite');
    }
    logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`);

    // 构建主代理上下文
    const agentContext: AgentContext = {
      agentId: MAIN_AGENT_ID,
      abortController: stateManager.currentAbortController,
      tools,
      model: 'main',
    }

    this.processQuery(trimmedInput, originalInput, agentContext, agentMode);
  }

  /**
   * 处理查询逻辑
   */
  private async processQuery(
    input: string,
    originalInput: string | undefined,
    agentContext: AgentContext,
    agentMode: 'Agent' | 'Plan'
  ): Promise<void> {
    // 获取状态管理器和主代理状态
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

    // 后台异步执行话题检测，不阻塞主流程
    // this.detectTopicInBackground(originalInput || input);

    try {
      // 将用户输入保存到项目配置的 history
      getConfManager().saveUserInputToHistory(originalInput || input);

      // 处理系统命令（false 表示不继续处理输入到query）
      const isSystemCommand = await handleSystemCommand(input);
      if (isSystemCommand) {
        return ;
      }

      // 检测并处理自定义命令
      const { processedInput } = await tryHandleCustomCommand(input);

      // 处理文件引用以获取补充信息（使用处理后的输入）
      const fileReferencesResult = await processFileReferences(processedInput, agentContext)
      logInfo(`返回文件引用信息: ${JSON.stringify(fileReferencesResult.supplementaryInfo, null, 2)}`)

      if (fileReferencesResult.supplementaryInfo.length > 0) {
        this.emit('file:reference', {
          references: fileReferencesResult.supplementaryInfo
        });
      }

      // 1、构建系统提示（根据是否有代理配置决定）
      const hasTodoWriteTool = agentContext.tools.some(tool => tool.name === 'TodoWrite');
      const hasAskUserQuestionTool = agentContext.tools.some(tool => tool.name === 'AskUserQuestion');
      const systemPromptContent = await formatSystemPrompt({ hasTodoWriteTool, hasAskUserQuestionTool });

      // 2、构建用户消息内容
      // 2.1 获取消息历史
      const messageHistory = mainAgentState.getMessageHistory()

      // 2.2 当前用户输入
      // 构建reminder信息 文件引用 每次输入均添加，首次查询添加 todos\rules，Plan 模式添加 Plan 信息
      const additionalReminders = this.buildAdditionalReminders(
        fileReferencesResult.systemReminders,
        messageHistory,
        hasTodoWriteTool,
        agentMode
      )
      const userMessage = createUserMessage([
        ...additionalReminders,
        { type: 'text' as const, text: processedInput }
      ])

      // 2.3 完整消息 
      const messages: Message[] = [...messageHistory, userMessage]

      // 调用 query 函数
      for await (const _message of query(
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
      stateManager.currentAbortController = null;
      mainAgentState.updateState('idle');
    }
  }

  /**
   * 构建 additionalReminders：文件引用、首次查询、Plan 模式信息
   */
  private buildAdditionalReminders(
    systemReminders: Anthropic.ContentBlockParam[],
    messageHistory: Message[],
    hasTodoWriteTool: boolean,
    agentMode: 'Agent' | 'Plan',
  ): Anthropic.ContentBlockParam[] {
    // 文件引用 每次输入均添加
    const reminders = [...systemReminders]

    // 判断是否为首次查询（消息历史为空），添加首次查询的额外信息 todos\rules
    if (messageHistory.length === 0) {
      // 添加 todos 信息
      if (hasTodoWriteTool) {
        reminders.push(...generateTodosReminders())
      }

      // 添加 rules 信息
      reminders.push(...generateRulesReminders())
    }

    // 判断是否为首次 Plan 模式查询，添加 Plan 模式信息
    const stateManager = getStateManager()
    if (agentMode === 'Plan' && !stateManager.isPlanModeInfoSent()) {
      reminders.push(...generatePlanReminders())
      stateManager.markPlanModeInfoSent()
    }

    return reminders
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
   * 中断当前会话并更新状态为 idle
   */
  interruptSession(): void {
    this.abortCurrentRequest();
    const mainAgentState = getStateManager().forAgent(MAIN_AGENT_ID);
    mainAgentState.updateState('idle');
  }

  /**
   * 更新 Agent 模式
   */
  updateAgentMode(mode: 'Agent' | 'Plan'): void {
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
  }

  /**
   * 后台异步检测话题，不阻塞主流程
   */
  private async detectTopicInBackground(userInput: string): Promise<void> {
    try {
      // 创建独立的 AbortController 用于话题检测
      const topicAbortController = new AbortController();

      // 如果主会话被中断，也中断话题检测
      const stateManager = getStateManager();
      const mainAbortController = stateManager.currentAbortController;
      if (mainAbortController) {
        mainAbortController.signal.addEventListener('abort', () => {
          topicAbortController.abort();
        }, { once: true });
      }

      const topicResult = await getTopicFromUserInput(userInput, topicAbortController.signal);

      if (topicResult) {
        logDebug(`话题检测结果: ${JSON.stringify(topicResult)}`);
        // 发送话题更新事件
        this.emit('topic:update', topicResult);
      }
    } catch (error) {
      // 话题检测失败不影响主流程，只记录调试日志
      if (!isInterruptedException(error)) {
        logDebug(`话题检测失败: ${error}`);
      }
    }
  }

  /**
   * 初始化 Skill 注册表 & 加载自定义命令，不阻塞会话创建
   */
  private async initializePlugins(workingDir?: string): Promise<void> {
    try {
      clearSkillRegistry();
      initializeSkillRegistry(workingDir || process.cwd());
      logDebug('Skill registry initialized successfully');
    } catch (error) {
      logWarn(`Failed to initialize skill registry: ${error}`);
    }

    try {
      const result = await loadCustomCommands();
      logDebug(`Loaded ${result.commands.length} custom commands`);
      if (result.errors.length > 0) {
        logWarn(`Custom command load errors: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logWarn(`Failed to load custom commands: ${error}`);
    }
  }

  // 初始化系统
  private async initialize(sessionId?: string): Promise<void> {
    const coreConfig = getConfManager().getCoreConfig();

    // 1、设置日志级别
    setLogLevel(coreConfig?.logLevel || 'info');

    // 2、设置sessionId（如果为空则生成一个）
    const finalSessionId = sessionId || initializeSessionId();
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

    // 1. 中止当前正在进行的请求（复用 abortCurrentRequest）
    this.abortCurrentRequest();

    // 2. 清空所有状态数据
    const stateManager = getStateManager();
    stateManager.clearAllState();

    // 3. 移除所有事件监听器
    this.eventBus.removeAllListeners();

    logInfo('SemaEngine 资源清理完成');
  }
}