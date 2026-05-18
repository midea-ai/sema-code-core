import { relative } from 'path'
import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/planToAgent'
import { TOOL_NAME_PLAN_TO_AGENT } from '../prompt/tool'
import { canonicalizeFilePath, readTextContent } from '../util/file'
import { readInitialCwd } from '../util/cwd'
import { safeGetFileInfo } from '../util/secureFile'
import { ToolControlSignal } from '../types/message'
import { getEventBus } from '../events/EventSystem'
import { PlanExitRequestData, PlanExitResponseData } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { buildUserMsg } from '../util/message'

// 输入 schema
const toolParams = z.strictObject({
  plan_file_path: z
    .string()
    .describe('Absolute path to the markdown plan file (.md) to finalize'),
})

// 输出类型
interface PlanToAgentOutput {
  planFilePath: string
  planContent: string
  selected: 'startEditing' | 'clearContextAndStart'
  controlSignal: ToolControlSignal  // 控制信号，用于触发上下文重建
}

export const PlanToAgent = {
  name: TOOL_NAME_PLAN_TO_AGENT,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  async validateInput(
    { plan_file_path }: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    const fullFilePath = canonicalizeFilePath(plan_file_path)

    // 验证文件是否存在
    const fileCheck = safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      return {
        result: false,
        message: fileCheck.error || `Plan file not found: ${plan_file_path}`,
      }
    }

    // 验证文件扩展名
    if (!plan_file_path.endsWith('.md')) {
      return {
        result: false,
        message: 'Plan file must be a markdown file (.md)',
      }
    }

    return { result: true }
  },
  async *call(
    { plan_file_path }: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    const fullFilePath = canonicalizeFilePath(plan_file_path)
    const eventBus = getEventBus()
    const abortController = agentContext.abortController as AbortController

    // 读取计划文件内容
    const { content } = readTextContent(fullFilePath, 0)

    // 获取相对路径用于事件
    const relativePath = relative(readInitialCwd(), fullFilePath)

    // 发送权限请求事件
    const requestData: PlanExitRequestData = {
      agentId: agentContext.agentId,
      planFilePath: relativePath,
      planContent: content,
      options: {
        startEditing: '直接开始编码',
        clearContextAndStart: '重置上下文后开始编码',
      },
    }

    eventBus.emit('plan:exit:request', requestData, agentContext.sessionId)

    // 等待用户响应
    const selected = await new Promise<'startEditing' | 'clearContextAndStart'>(
      (resolve, reject) => {
        const handleResponse = (response: PlanExitResponseData) => {
          if (response.agentId !== agentContext.agentId) return

          eventBus.off('plan:exit:response', handleResponse)
          resolve(response.selected)
        }

        // 监听中断
        const onAbortRequested = () => {
          eventBus.off('plan:exit:response', handleResponse)
          reject(new Error('User cancelled the plan exit'))
        }

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', onAbortRequested, {
            once: true,
          })
        }

        eventBus.on('plan:exit:response', handleResponse, agentContext.sessionId)
      },
    )

    // 检查是否被中断
    checkAbortSignal(abortController)

    const runtime = getStateManager().session(agentContext.sessionId)

    // 退出Plan模式，切换回Agent模式（会话级）
    runtime.agentMode = 'Agent'

    // 如果选择清理上下文
    if (selected === 'clearContextAndStart') {
      // 清空 plan 阶段所有上下文
      runtime.clearAllState()
      // clearAllState 会把生命周期状态和当前请求的 abort 句柄一并清掉，
      // 但工具仍在执行中，需立刻还原回 processing 态
      runtime.updateState('processing')
      runtime.currentAbortController = abortController

      // 设置新的用户消息
      const newUserMessage = buildUserMsg([
        {
          type: 'text',
          text: `按照以下计划进行实现：\n\n${content}`,
        },
      ])
      runtime.setMessageHistory([newUserMessage], MAIN_AGENT_ID)

      // 触发 plan:implement 事件
      eventBus.emit('plan:implement', {
        planFilePath: relativePath,
        planContent: content,
      }, agentContext.sessionId)
    }

    const data: PlanToAgentOutput = {
      planFilePath: plan_file_path,
      planContent: content,
      selected,
      // 添加控制信号，通知 query 函数需要重建上下文
      controlSignal: {
        rebuildContext: {
          reason: 'mode_changed',
          newMode: 'Agent',
          // 如果选择清理上下文，传递重建消息
          rebuildMessage: selected === 'clearContextAndStart' ? [{
            type: 'text',
            text: `按照以下计划进行实现：\n\n${content}`,
          }] : undefined,
        },
      },
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(output: PlanToAgentOutput) {
    const { planFilePath, planContent, selected } = output

    if (selected === 'clearContextAndStart') {
      return `The plan has been confirmed. Context has been reset to keep things focused.

Proceed with implementing the plan below. Reference ${planFilePath} as needed.

## Plan to Implement:
${planContent}`
    }

    return `The plan has been confirmed. Begin implementation whenever ready — update your task list first if applicable.

Plan saved at: ${planFilePath}

## Approved Plan:
${planContent}

## Plan Mode Exited

Editing, tool use, and all other actions are now available. The plan file remains at ${planFilePath} for reference.`
  },
} satisfies Tool<typeof toolParams, PlanToAgentOutput>
