import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { logInfo, logDebug, setLogLevel, logWarn } from '../util/log';
import { getTokens } from '../util/tokens';
import { loadHistory, saveHistory, resolveHistoryFile } from '../util/history';
import { detectTopicInBackground } from '../util/topic';
import { predictNextInputInBackground } from '../util/inputPredict';
import { processFileReferences } from '../util/fileReference';
import { buildUserMsg, buildAdditionalReminders } from '../util/message';
import { getAvailableTools } from '../tools/base/tools';
import { takeNextBatch } from '../util/inputQueue';
import { formatSystemPrompt } from '../services/agents/genSystemPrompt';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { SessionEventBus } from '../events/EventSystem';
import { isInterruptedException } from '../types/errors';
import type { Message, UserMsg, InputImageAttachment, InputSource } from '../types/message';
import { compressImage } from '../util/imageCompress';
import type { UUID } from '../types/uuid';
import type { ForkOptions, ForkResult, BranchResult } from '../types/fork';
import { generateSessionId } from '../util/session';
import { ReAct } from './Conversation';
import type { AgentContext } from '../types/agent'
import { getStateManager, MAIN_AGENT_ID, PendingUserInput, SessionRuntime } from '../manager/StateManager';
import { getCheckpointManager } from '../manager/CheckpointManager';
import { handleCommand } from '../services/commands/runCommand';
import { getTaskManager } from '../manager/TaskManager';
import { getCronManager } from '../manager/CronManager';
import { handlequickchat } from '../util/quickchat';
import { TOOL_NAME_SKILL } from '../prompt/tool';
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define';
import { fireSessionStart, fireUserPromptSubmit, fireSessionEnd, fireStop } from '../services/hooks/hookTriggers';
import type { AgentMode, PermissionLevel } from '../types';
import type { FileReferenceInfo } from '../types/index';
import type { CreateSessionOptions } from '../types/session';

// 粘贴图片单张体积上限，超出则压缩（与 ViewFile 的 MAX_OUTPUT_BYTES 保持一致）
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
// 支持的图片 media_type 白名单
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

/**
 * Sema 引擎 - 单个会话的核心业务逻辑
 * 每个会话一个实例，绑定固定的 sessionId
 */
export class SemaEngine {
  /** 当前正在执行的 processQuery Promise（用于 dispose 时等待） */
  private currentProcessingPromise: Promise<void> | null = null

  /** SessionStart hook 的 additionalContext（首轮 processQuery 消费一次，不阻塞 session:ready） */
  private sessionStartHookPromise: Promise<string | null> | null = null

  private readonly runtime: SessionRuntime;

  // 公共事件接口（会话级，自动按 sessionId 路由）
  emit = <T>(event: string, data: T) => this.bus.emit(event, data);
  on = <T>(event: string, listener: (data: T) => void) => this.bus.on(event, listener);
  once = <T>(event: string, listener: (data: T) => void) => this.bus.once(event, listener);
  off = <T>(event: string, listener: (data: T) => void) => this.bus.off(event, listener);

  constructor(
    public readonly sessionId: string,
    private readonly bus: SessionEventBus,
  ) {
    this.runtime = getStateManager().session(sessionId);

    // 注入后台任务通知回调：完成后将通知注入本会话输入队列
    getTaskManager().setNotifyCallback(sessionId, (msg: string) => {
      this.processUserInput(msg, undefined, true)
    })

    // 注入 Cron 定时任务通知回调：以用户输入形态展示（source='cron'，UI 据此加标签）
    // originalInput 取干净的任务文本用于气泡展示，模型收到的仍是完整通知消息
    getCronManager().setNotifyCallback(sessionId, (msg: string, opts?: { display?: string }) => {
      this.processUserInput(msg, opts?.display, false, undefined, 'cron')
    })
  }

  /**
   * 初始化会话：加载历史、发送 session:ready
   */
  async createSession(opts: CreateSessionOptions = {}): Promise<void> {
    // 会话级模型覆盖（仅本会话、不落盘）：先设置再做模型检查，使 initialize 校验的是本会话实际使用的 main
    if (opts.mainModel || opts.quickModel) {
      getModelManager().setSessionModelOverride(this.sessionId, { main: opts.mainModel, quick: opts.quickModel });
    }

    // 初始化系统配置与模型检查
    await this.initialize();

    // 会话级配置：Agent 模式
    const coreConfig = getConfManager().getCoreConfig();
    this.runtime.agentMode = opts.agentMode || coreConfig?.agentMode || 'Agent';

    // 会话级配置：权限自由度档位
    this.runtime.setPermissionLevel(opts.permissionLevel || 'Ask');

    // 构建会话级系统提示快照：整个会话不再变化（env/gitStatus 取会话创建时的快照）
    this.runtime.setSystemPromptContent(await formatSystemPrompt());

    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);
    const workingDir = coreConfig?.workingDir;
    const historyId = opts.sessionId;

    // 决定本会话历史文件命名格式：传入 ID 且无任何历史文件（不存在的会话ID）→ 无日期，
    // 沿用已存在文件的格式；不传 ID（随机 ID）→ 带日期。
    let historyNoDate = false;
    if (historyId) {
      const resolved = resolveHistoryFile(historyId, workingDir);
      historyNoDate = resolved.exists ? resolved.noDate : true;
    }
    this.runtime.setHistoryNoDate(historyNoDate);

    const historyData = await loadHistory(historyId, workingDir);

    // 将加载的消息历史、todos 和 readFileTimestamps 设置到主代理状态
    // 初始化时跳过自动保存，避免把刚读取的数据重复写回文件
    mainAgentState.setMessageHistory(historyData.messages, true);
    mainAgentState.setTodos(historyData.todos);
    if (historyData.todoTasks && historyData.todoTasks.length > 0) {
      this.runtime.restoreTodoTasks(historyData.todoTasks);
    } else if (historyData.todos && historyData.todos.length > 0) {
      this.runtime.restoreTodoTasksFromLegacy(historyData.todos);
    }
    if (historyData.readFileTimestamps) {
      mainAgentState.setReadFileTimestamps(historyData.readFileTimestamps);
    }

    const projectConfig = getConfManager().getProjectConfig();
    const projectInputHistory = projectConfig?.history || [];
    const usage = getTokens(mainAgentState.getMessageHistory(), this.sessionId)

    const sessionData = {
      pid: process.pid,
      workingDir: coreConfig?.workingDir,
      sessionId: this.sessionId,
      historyLoaded: !!historyId,
      projectInputHistory: projectInputHistory,
      usage: usage,
      todos: mainAgentState.getTodos(),
      readFileTimestamps: historyData.readFileTimestamps || {}
    };

    logInfo(`新会话创建完成，sessionId: ${this.sessionId}`);

    // SessionStart hook：后台触发，additionalContext 在首轮 processQuery 时消费
    this.sessionStartHookPromise = fireSessionStart(this.sessionId);

    // 延迟一拍发送 session:ready：调用方需先拿到 createSession 返回的 SemaSession
    // 并在其上注册监听器，再收到首个事件
    setImmediate(() => {
      this.emit('session:ready', sessionData);
      mainAgentState.updateState('idle');
    });
  }

  /**
   * 处理用户输入
   * 如果当前正在处理中，将输入加入队列等待
   */
  processUserInput(input: string, originalInput?: string, silent?: boolean, attachments?: InputImageAttachment[], source?: InputSource): void {
    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);
    // inputId 同时作为该用户输入持久化消息的 uuid，UI 据此调用 fork
    const inputId = randomUUID()
    const trimmedInput = input.trim()

    // quickchat 旁路：不影响状态和队列，异步处理后直接返回
    if (trimmedInput === '/quickchat' || trimmedInput.startsWith('/quickchat ')) {
      const question = trimmedInput.startsWith('/quickchat ') ? trimmedInput.slice('/quickchat '.length).trim() : ''
      getConfManager().saveUserInputToHistory(originalInput || trimmedInput)
      if (question) {
        handlequickchat(question, this.sessionId).catch(err => logWarn(`[quickchat] 未捕获异常: ${err instanceof Error ? err.message : String(err)}`))
      } else {
        this.emit('quickchat:response', { question: '', content: '' })
      }
      return
    }

    if (mainAgentState.getCurrentState() === 'processing') {
      const type: PendingUserInput['type'] = trimmedInput.startsWith('/') ? 'command' : 'inject'
      this.runtime.addPendingUserInput({ inputId, input: trimmedInput, originalInput, silent, type, attachments, source })
      logInfo(`输入已入队(${type})，队列长度: ${this.runtime.getPendingUserInputsLength()}`)
      if (!silent) {
        this.emit('input:received', {
          inputId,
          input: trimmedInput,
          originalInput,
          source: source ?? 'user',
          queued: true,
          inject: type === 'inject',
          queueLength: this.runtime.getPendingUserInputsLength(),
        })
      }
      return
    }

    if (!silent) {
      this.emit('input:received', {
        inputId,
        input: trimmedInput,
        originalInput,
        source: source ?? 'user',
        queued: false,
        inject: false,
        queueLength: 0,
      })
    }
    this.startQuery([{ inputId, input: trimmedInput, originalInput, silent, attachments, source }]);
  }

  /**
   * 启动一次查询（构建上下文并调用 processQuery）
   */
  private startQuery(inputs: Array<{ inputId: string; input: string; originalInput?: string; silent?: boolean; attachments?: InputImageAttachment[]; source?: InputSource }>): void {
    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);
    mainAgentState.updateState('processing');

    logInfo(`用户输入(${inputs.length}条): ${inputs.map(i => i.input).join(' | ')}`);

    // 创建新的 AbortController 用于此次处理
    this.runtime.currentAbortController = new AbortController();

    const agentMode = this.runtime.agentMode;

    // 获取工具集（按核心级 useTools 黑名单过滤；工具搜索模式下按会话组装）
    const tools = getAvailableTools(undefined, { sessionId: this.sessionId });

    // 构建主代理上下文
    const agentContext: AgentContext = {
      sessionId: this.sessionId,
      agentId: MAIN_AGENT_ID,
      abortController: this.runtime.currentAbortController,
      tools,
      model: 'main',
    }

    // 保存当前的 processQuery Promise，用于等待其完成
    this.currentProcessingPromise = this.processQuery(inputs, agentContext, agentMode)
      .catch(error => {
        logWarn(`processQuery 未捕获异常: ${error instanceof Error ? error.message : String(error)}`);
        if (this.runtime.currentAbortController === agentContext.abortController) {
          this.runtime.currentAbortController = null;
        }
        mainAgentState.updateState('idle');
      })
      .finally(() => {
        this.currentProcessingPromise = null;
      });
  }

  /**
   * 处理查询逻辑
   */
  private async processQuery(
    inputs: Array<{ inputId: string; input: string; originalInput?: string; silent?: boolean; attachments?: InputImageAttachment[]; source?: InputSource }>,
    agentContext: AgentContext,
    agentMode: AgentMode
  ): Promise<void> {
    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);

    // 先按 inputId 规范化各输入的图片附件（过滤非法类型、超限压缩），
    // 以便 input:processing 事件直接回吐与该消息绑定的最终附件，气泡回显无需 UI 暂存或队列对齐
    const normalizedAttachments = new Map<string, InputImageAttachment[]>();
    for (const item of inputs) {
      normalizedAttachments.set(item.inputId, await this.normalizeAttachments(item.attachments));
    }

    // 为每条输入发送独立的 input:processing 事件（静默输入跳过）
    for (const item of inputs) {
      if (!item.silent) {
        const attachments = normalizedAttachments.get(item.inputId);
        this.emit('input:processing', {
          inputId: item.inputId,
          input: item.input,
          originalInput: item.originalInput,
          source: item.source ?? 'user',
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
        })
      }
    }

    try {
      // 将每条用户输入保存到项目配置的 history（静默输入/自动来源输入跳过，避免污染上翻输入历史）
      for (const item of inputs) {
        if (!item.silent && (item.source ?? 'user') === 'user') {
          getConfManager().saveUserInputToHistory(item.originalInput || item.input);
        }
      }

      // 处理命令，按输入分别收集 blocks（每条输入对应一条持久化消息）
      const perInput: Array<{ inputId: string; blocks: Anthropic.ContentBlockParam[]; attachments?: InputImageAttachment[]; fileRefReminders: Anthropic.ContentBlockParam[]; source?: InputSource }> = [];
      // 文件引用补充信息：跨输入累加，循环后统一发一次 file:reference 事件
      const allSupplementaryInfo: FileReferenceInfo[] = [];
      // UserPromptSubmit hook 注入的上下文（按 inputId 挂到各自输入消息上）
      const hookCtxByInput = new Map<string, string>();
      // 通过 UserPromptSubmit hook 的输入（仅排除被拦截项；已处理的系统命令、空内容仍保留，
      // 供话题检测等下游使用，与改动前行为对齐）
      const acceptedInputs: typeof inputs = [];

      for (const item of inputs) {
        if (agentContext.abortController.signal.aborted) {
          logInfo('processQuery: abort detected during handleCommand loop, skipping remaining');
          return;
        }

        // UserPromptSubmit hook：静默输入与自动来源输入（后台任务/定时任务通知）不触发
        if (!item.silent && (item.source ?? 'user') === 'user') {
          const promptHook = await fireUserPromptSubmit(this.sessionId, item.input, agentContext.abortController.signal);
          // hook 介入期间用户可能已中断（hook 被 kill 后 fail-open 返回 blocked:false）：
          // 与循环头的中断处理一致终止本批，避免在已中断的 turn 里继续执行系统命令
          if (promptHook.ran && agentContext.abortController.signal.aborted) {
            logInfo('processQuery: abort detected during UserPromptSubmit hook, skipping remaining');
            return;
          }
          if (promptHook.blocked) {
            // 丢弃本条输入，原因经 hook:notice 展示给用户（全部被拦时命中下方 perInput 空早退）
            this.emit('hook:notice', {
              kind: 'blocked',
              hookEvent: 'UserPromptSubmit',
              message: promptHook.reason || '输入被 UserPromptSubmit hook 拦截',
            });
            continue;
          }
          if (promptHook.additionalContext) {
            hookCtxByInput.set(item.inputId, promptHook.additionalContext);
          }
        }
        acceptedInputs.push(item);

        const commandResult = await handleCommand(item.input, this.sessionId);
        if (commandResult === null) {
          // 系统命令已处理（如 /compact, /clear），跳过
          continue;
        }
        // 逐输入处理文件引用：@图片/文件 提醒挂到该输入自己的消息上（对齐 inputId）
        const fileRef = await processFileReferences(commandResult.processedText, agentContext);
        allSupplementaryInfo.push(...fileRef.supplementaryInfo);
        // 复用已规范化的图片附件（与 input:processing 事件回吐的是同一份）
        const attachments = normalizedAttachments.get(item.inputId) ?? [];
        // 文本块 / 图片附件 / 文件引用提醒 任一存在即生成一条持久化消息
        if (commandResult.blocks.length > 0 || attachments.length > 0 || fileRef.systemReminders.length > 0) {
          perInput.push({ inputId: item.inputId, blocks: commandResult.blocks, attachments, fileRefReminders: fileRef.systemReminders, source: item.source });
        }
      }

      if (perInput.length === 0) {
        return;
      }

      logInfo(`返回文件引用信息: ${JSON.stringify(allSupplementaryInfo, null, 2)}`)
      if (allSupplementaryInfo.length > 0) {
        this.emit('file:reference', { references: allSupplementaryInfo });
      }

      if (agentContext.abortController.signal.aborted) {
        logInfo('processQuery: abort detected after handleCommand, skipping remaining');
        return;
      }

      // 后台异步执行话题检测，不阻塞主流程
      // 只用通过 UserPromptSubmit hook 的输入：被拦截内容（可能涉隐私/合规）不得外发给话题检测模型
      // 且只用真实用户输入：静默/自动来源（cron 等）不参与，避免自动触发的 prompt 改写会话标题
      const topicInputs = acceptedInputs.filter(i => !i.silent && (i.source ?? 'user') === 'user')
      const allOriginalTexts = topicInputs.map(i => i.originalInput || i.input).join('\n');
      if (topicInputs.length > 0 && !getConfManager().getCoreConfig()?.disableTopicDetection) {
        detectTopicInBackground(
          allOriginalTexts,
          this.runtime.currentAbortController,
          (result) => this.emit('topic:update', result),
          this.sessionId,
        );
      }

      // 1、系统提示：复用会话级快照（整会话不变）；缺失时兜底构建一次
      const hasSkillTool = agentContext.tools.some(tool => tool.name === TOOL_NAME_SKILL);
      let systemPromptContent = this.runtime.getSystemPromptContent();
      if (!systemPromptContent) {
        systemPromptContent = await formatSystemPrompt();
        this.runtime.setSystemPromptContent(systemPromptContent);
      }

      // 2、构建用户消息内容
      const messageHistory = mainAgentState.getMessageHistory()

      // 回合级提醒（skills/rules/plan/design）：传空 systemReminders，仅取回合级部分，挂到首条消息；
      // 文件引用提醒已按 inputId 拆到各自输入（见 perInput.fileRefReminders）
      const turnLevelReminders = await buildAdditionalReminders(
        [],
        messageHistory,
        agentMode,
        this.sessionId,
        hasSkillTool
      )

      // SessionStart hook 的 additionalContext：仅首轮消费一次（compact/fork 后不重复注入）。
      // 与中断信号 race：hook 卡住时用户中断可立即打断等待；中断获胜则不消费 promise，留待下一轮注入
      if (this.sessionStartHookPromise) {
        const abortSignal = agentContext.abortController.signal
        const pendingHookCtx = this.sessionStartHookPromise
        const sessionStartCtx = await new Promise<string | null>(resolve => {
          if (abortSignal.aborted) {
            resolve(null)
            return
          }
          const onAbort = () => resolve(null)
          abortSignal.addEventListener('abort', onAbort, { once: true })
          pendingHookCtx.then(
            value => { abortSignal.removeEventListener('abort', onAbort); resolve(value) },
            () => { abortSignal.removeEventListener('abort', onAbort); resolve(null) },
          )
        })
        // race 后复查信号，处理"完成与中断同时发生"的竞态：只要已中断就按中断处理
        if (!abortSignal.aborted) {
          this.sessionStartHookPromise = null
          if (sessionStartCtx) {
            turnLevelReminders.push({
              type: 'text' as const,
              text: `${REMINDER_SYS_OPEN}\nSessionStart hook context:\n${sessionStartCtx}\n${REMINDER_SYS_CLOSE}`,
            })
          }
        }
      }
      // 打 Fork 锚点：记录本批输入发送时已累积的文件快照数，并开启新的快照 segment
      const checkpointSeq = getCheckpointManager().beginTurn(this.sessionId)

      // 每条输入各生成一条 UserMsg（uuid=inputId，便于 UI 按输入块 fork）；
      // 文件引用提醒挂在各自输入消息上，回合级提醒只挂首条；
      // API 调用时由 prepareMessagesForApi 自动合并连续 user 消息
      const userMessages: UserMsg[] = perInput.map((p, idx) => {
        // 图片附件转 image content block
        const imageBlocks: Anthropic.ContentBlockParam[] = (p.attachments ?? []).map(a => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: a.media_type, data: a.data },
        }))
        // 存在图片时过滤空文本块（纯截图场景 input 为空，空 text block 会导致 API 报错）
        const textBlocks = imageBlocks.length > 0
          ? p.blocks.filter(b => !(b.type === 'text' && !b.text.trim()))
          : p.blocks
        // UserPromptSubmit hook 上下文挂到该输入自己的消息上
        const hookCtx = hookCtxByInput.get(p.inputId)
        const hookBlocks: Anthropic.ContentBlockParam[] = hookCtx
          ? [{
              type: 'text' as const,
              text: `${REMINDER_SYS_OPEN}\nUserPromptSubmit hook context:\n${hookCtx}\n${REMINDER_SYS_CLOSE}`,
            }]
          : []
        // 块序从全局到局部：回合级提醒（仅首条）→ 文件引用提醒（含 @图片）→
        // UserPromptSubmit hook 上下文（紧贴其修饰的输入正文，与非首条输入的顺序一致）
        const head = idx === 0
          ? [...turnLevelReminders, ...p.fileRefReminders, ...hookBlocks]
          : [...p.fileRefReminders, ...hookBlocks]
        const blocks = [...head, ...textBlocks, ...imageBlocks]
        const msg = buildUserMsg(blocks)
        msg.uuid = p.inputId as UUID
        msg.checkpointSeq = checkpointSeq
        // 非 user 来源写入持久化元数据，历史重放时可还原来源标签
        if (p.source && p.source !== 'user') msg.source = p.source
        return msg
      })

      const messages: Message[] = [...messageHistory, ...userMessages]

      // 进入 ReAct 前先把用户消息同步到内存并落盘：首轮 LLM 请求期间进程意外退出时，
      // 用户输入不至于丢失（恢复时末尾若是孤儿 tool_use 由 prepareMessagesForApi 兜底剔除）
      mainAgentState.setMessageHistory(messages)

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
    } finally {
      // 延迟清空 AbortController，确保所有中断逻辑执行完毕
      const currentAbortController = this.runtime.currentAbortController;
      if (currentAbortController === agentContext.abortController) {
        setTimeout(() => {
          if (this.runtime.currentAbortController === currentAbortController) {
            this.runtime.currentAbortController = null;
          }
        }, 0);
      }

      // 处理待处理输入队列
      const remaining = this.runtime.consumeAllPendingInputs();
      if (remaining.length > 0) {
        const pending = remaining.map(item => ({
          inputId: item.inputId,
          input: item.input,
          originalInput: item.originalInput,
          silent: item.silent,
          attachments: item.attachments,
          source: item.source,
        }))
        const batch = takeNextBatch(pending)

        // 剩余的放回队列
        if (pending.length > 0) {
          for (const item of pending) {
            const type: PendingUserInput['type'] = item.input.startsWith('/') ? 'command' : 'inject'
            this.runtime.addPendingUserInput({ ...item, type })
          }
        }

        logInfo(`处理队列中 ${batch.length} 条待处理输入`)
        this.startQuery(batch)
      } else {
        // Stop hook：一轮处理自然完成转 idle 时触发；中断不触发，
        // 有排队输入接续时视为同一轮继续也不触发
        if (!agentContext.abortController.signal.aborted) {
          fireStop(this.sessionId)
          // 后台异步预测用户下一句输入（quick 模型），不阻塞收尾；结果经 input:predict 事件发出
          // 只在含真实用户输入的轮次触发：静默/自动来源（cron、后台任务通知等）结束时用户未必在看，不预测
          const hasUserInput = inputs.some(i => !i.silent && (i.source ?? 'user') === 'user')
          if (hasUserInput && getConfManager().getCoreConfig()?.enableInputPrediction) {
            predictNextInputInBackground(this.sessionId).catch(() => undefined)
          }
        }
        mainAgentState.updateState('idle');
      }
    }
  }

  /**
   * 规范化图片附件：过滤非法 media_type，单张超限则压缩
   * 返回干净可直接转 image content block 的附件数组
   */
  private async normalizeAttachments(attachments?: InputImageAttachment[]): Promise<InputImageAttachment[]> {
    if (!attachments || attachments.length === 0) return [];

    const result: InputImageAttachment[] = [];
    for (const att of attachments) {
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(att.media_type as typeof SUPPORTED_IMAGE_MEDIA_TYPES[number])) {
        logWarn(`忽略不支持的图片类型: ${att.media_type}`);
        continue;
      }
      try {
        const buffer = Buffer.from(att.data, 'base64');
        if (buffer.length > MAX_IMAGE_BYTES) {
          if (att.media_type === 'image/gif') {
            logWarn(`忽略超出上限且不支持压缩的 GIF 附件: ${Math.round(buffer.length / 1024)}KB`);
            continue;
          }
          logInfo(`图片附件 ${Math.round(buffer.length / 1024)}KB 超过上限 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB，压缩中...`);
          const compressed = await compressImage(buffer, att.media_type, MAX_IMAGE_BYTES);
          const compressedBytes = Math.ceil(compressed.data.length * 3 / 4);
          if (compressedBytes > MAX_IMAGE_BYTES) {
            logWarn(`忽略压缩后仍超出上限的图片附件: ${Math.round(compressedBytes / 1024)}KB`);
            continue;
          }
          result.push({ type: 'image', data: compressed.data, media_type: compressed.media_type });
        } else {
          result.push(att);
        }
      } catch (e) {
        logWarn(`处理图片附件失败，已忽略: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  /**
   * 中止当前正在进行的请求（仅处理 AbortController）
   */
  private abortCurrentRequest(): void {
    const abortController = this.runtime.currentAbortController;
    if (abortController && !abortController.signal.aborted) {
      logInfo('通过 AbortController 发送中断信号');
      abortController.abort();
    }
    this.runtime.currentAbortController = null;
  }

  /**
   * 中断当前会话
   */
  interruptSession(): void {
    this.abortCurrentRequest();
  }

  /**
   * 原地回退（Fork / 撤销）：把当前会话历史截断到指定用户消息之前（移除该消息及其之后），
   * 可选把文件回滚到该点。会话 id 不变，原会话继续使用。
   */
  async rewind(messageUuid: string, options: ForkOptions = {}): Promise<ForkResult> {
    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);

    // idle 守卫：处理中回退会导致 editlog / history / 磁盘不一致
    if (mainAgentState.getCurrentState() !== 'idle') {
      return { ok: false, error: '会话忙，请等待空闲后再撤销' };
    }

    const history = mainAgentState.getMessageHistory();
    const idx = history.findIndex(m => m.uuid === messageUuid);
    if (idx < 0) {
      return { ok: false, error: `未找到消息: ${messageUuid}` };
    }

    // 回退只接受真实用户输入消息：checkpointSeq 仅打在真实用户输入上（见 startQuery），
    // 工具结果消息与合成 user 消息（中断提示 / 上下文重建 / 压缩通知等）都不带此标记。
    // 它们不是干净的回合边界，在其之上截断会把上一条 assistant 的 tool_use 留成孤儿，
    // 后续准备 API 请求时丢失该轮 assistant 内容，静默破坏会话历史。
    const forkMsg = history[idx];
    if (forkMsg.type !== 'user' || forkMsg.checkpointSeq === undefined) {
      return { ok: false, error: `该消息不是可回退的用户输入: ${messageUuid}` };
    }

    const forkSeq = forkMsg.checkpointSeq; // 真实用户输入必有锚点
    const truncated = history.slice(0, idx); // 移除该消息及其之后

    const checkpoint = getCheckpointManager();

    // 1) 回滚文件（仅 restoreFiles）
    let restoredFiles: string[] = [];
    if (options.restoreFiles) {
      const plan = checkpoint.computeRestorePlan(this.sessionId, forkSeq);
      restoredFiles = checkpoint.applyRestore(plan);
      // 刷新被回滚文件的读时间戳，沿用会话时间戳、不触发"先重读"
      for (const filePath of restoredFiles) {
        try {
          mainAgentState.setReadFileTimestamp(filePath, statSync(filePath).mtimeMs);
        } catch {
          // 回滚为删除等情况文件已不存在，忽略
        }
      }
    }

    // 2) 截断 editlog 到 forkSeq（被撤销的快照记录丢弃）
    checkpoint.truncateEditLog(this.sessionId, forkSeq);

    // 3) 就地截断历史并持久化（同一会话同 id）
    mainAgentState.setMessageHistory(truncated); // 非空时自动保存
    if (truncated.length === 0) {
      // 空历史不触发自动保存，强制落盘覆盖旧历史
      const workingDir = getConfManager().getCoreConfig()?.workingDir;
      await saveHistory(
        this.sessionId,
        [],
        this.runtime.getTodos(),
        workingDir,
        this.runtime.getReadFileTimestamps(),
        this.runtime.listTodoTasks(MAIN_AGENT_ID),
        this.runtime.getHistoryNoDate(),
      );
    }

    // 主动重发当前 todos：todos 不随回档回退，但 UI 的 todos 面板只吃 todos:update，
    // 这里重发一次让面板与回档后的会话重新同步
    this.emit('todos:update', this.runtime.getTodos());

    logInfo(`原地回退: ${this.sessionId} @ ${messageUuid} (restoreFiles=${!!options.restoreFiles}, restored=${restoredFiles.length}, 历史保留 ${truncated.length} 条)`);
    return { ok: true, sessionId: this.sessionId, restoredFiles };
  }

  /**
   * 分支到新聊天：创建新会话 id，新会话历史 = 当前历史截到指定用户输入之前
   * （beforeMessageUuid 不传则全量复制，对应"从最新回复分支"）。
   * 原会话历史、editlog 与工作区文件均不动；新会话带截断后的 editlog 副本
   * （blobs 内容寻址共享），后续仍可自行 fork / 回滚文件。
   */
  async branchToNewChat(beforeMessageUuid?: string): Promise<BranchResult> {
    const mainAgentState = this.runtime.forAgent(MAIN_AGENT_ID);

    // idle 守卫：处理中分支会把写到一半的回合复制进新会话
    if (mainAgentState.getCurrentState() !== 'idle') {
      return { ok: false, error: '会话忙，请等待空闲后再分支' };
    }

    const history = mainAgentState.getMessageHistory();
    const checkpoint = getCheckpointManager();

    // 解析截断点：有锚点 → 该用户输入之前；无锚点 → 全量
    let branchedMessages: Message[];
    let forkSeq: number;
    if (beforeMessageUuid !== undefined) {
      const idx = history.findIndex(m => m.uuid === beforeMessageUuid);
      if (idx < 0) {
        return { ok: false, error: `未找到消息: ${beforeMessageUuid}` };
      }
      // 同 rewind：只接受带 checkpointSeq 的真实用户输入作为截断点，
      // 其他消息不是干净回合边界，在其之上截断会留下孤儿 tool_use
      const anchorMsg = history[idx];
      if (anchorMsg.type !== 'user' || anchorMsg.checkpointSeq === undefined) {
        return { ok: false, error: `该消息不是可分支的用户输入: ${beforeMessageUuid}` };
      }
      branchedMessages = history.slice(0, idx);
      forkSeq = anchorMsg.checkpointSeq;
    } else {
      branchedMessages = history.slice();
      forkSeq = checkpoint.getEditCount(this.sessionId);
    }

    if (branchedMessages.length === 0) {
      return { ok: false, error: '没有可分支的历史' };
    }

    const newSessionId = generateSessionId();
    const workingDir = getConfManager().getCoreConfig()?.workingDir;

    // 新会话历史落盘（带日期命名，与随机新会话一致）；
    // todos / readFileTimestamps 与 fork 行为一致不回退，直接复制当前值
    await saveHistory(
      newSessionId,
      branchedMessages,
      this.runtime.getTodos(),
      workingDir,
      this.runtime.getReadFileTimestamps(),
      this.runtime.listTodoTasks(MAIN_AGENT_ID),
      false,
    );

    // 复制截断后的 editlog 给新会话（blobs 共享无需复制）
    checkpoint.copyEditLog(this.sessionId, newSessionId, forkSeq);

    logInfo(`分支到新聊天: ${this.sessionId} -> ${newSessionId} (anchor=${beforeMessageUuid ?? '末尾'}, 历史 ${branchedMessages.length} 条, editlog seq<${forkSeq})`);
    return { ok: true, sessionId: newSessionId };
  }

  /**
   * 更新 Agent 模式（会话级）
   */
  updateAgentMode(mode: AgentMode): void {
    if (this.runtime.agentMode === mode) {
      return;
    }
    this.runtime.agentMode = mode;
    logInfo(`[${this.sessionId}] Agent 模式已更新: ${mode}`);

    if (mode === 'Plan') {
      this.runtime.resetPlanModeInfoSent();
    }
    if (mode === 'Design') {
      this.runtime.resetDesignModeInfoSent();
    }
  }

  /**
   * 更新权限自由度档位（会话级）
   */
  updatePermissionLevel(level: PermissionLevel): void {
    this.runtime.setPermissionLevel(level);
  }

  // 初始化系统配置与模型检查
  private async initialize(): Promise<void> {
    const coreConfig = getConfManager().getCoreConfig();
    setLogLevel(coreConfig?.logLevel || 'info');

    try {
      const modelManager = getModelManager();
      const modelProfile = modelManager.getModel('main', this.sessionId)
      if (!modelProfile) {
        // 延迟一拍：等调用方在返回的 SemaSession 上注册监听器
        setImmediate(() => {
          this.emit('config:no_models', {
            message: '未配置任何模型，请先添加模型配置',
            suggestion: ''
          });
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
   * 等待当前处理结束（最多 timeoutMs 毫秒）
   */
  async waitForIdle(timeoutMs = 10000): Promise<void> {
    if (!this.currentProcessingPromise) return;
    try {
      await Promise.race([
        this.currentProcessingPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('等待超时')), timeoutMs)),
      ]);
    } catch (error) {
      logWarn(`等待会话处理结束时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 清理本会话资源（会话级，不触碰全局单例）
   */
  dispose(): void {
    logInfo(`清理 SemaEngine 资源: ${this.sessionId}`);
    // SessionEnd hook：fire-and-forget，不阻塞清理流程
    fireSessionEnd(this.sessionId);
    this.abortCurrentRequest();
    // 同步 flush 内存历史：dispose 不等待中断路径的异步落盘（进程级退出时 process.exit
    // 会抢先），saveHistory 内部首个 await 前即完成 writeFileSync，此调用返回时已写盘
    void this.runtime.saveSessionHistory();
    this.runtime.clearPendingUserInputs();
    // 移除本会话在 Task/Cron 管理器上的通知回调
    getTaskManager().removeNotifyCallback(this.sessionId);
    getCronManager().removeNotifyCallback(this.sessionId);
  }
}
