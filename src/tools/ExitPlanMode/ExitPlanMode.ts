import { relative } from 'path'
import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { normalizeFilePath, readTextContent } from '../../util/file'
import { getCwd } from '../../util/cwd'
import { secureFileService } from '../../util/secureFile'
import { getConfManager } from '../../manager/ConfManager'
import { ToolControlSignal } from '../../types/message'
import { getEventBus } from '../../events/EventSystem'
import { PlanExitRequestData, PlanExitResponseData } from '../../events/types'
import { checkAbortSignal } from '../../types/errors'
import { getStateManager, MAIN_AGENT_ID } from '../../manager/StateManager'
import { createUserMessage } from '../../util/message'

// 输入 schema
const inputSchema = z.strictObject({
  planFilePath: z
    .string()
    .describe('The absolute path to the plan file (.md)'),
})

// 输出类型
interface ExitPlanModeOutput {
  planFilePath: string
  planContent: string
  selected: 'startEditing' | 'clearContextAndStart'
  controlSignal: ToolControlSignal  // 控制信号，用于触发上下文重建
}

export const ExitPlanModeTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  async validateInput(
    { planFilePath }: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    const fullFilePath = normalizeFilePath(planFilePath)

    // 验证文件是否存在
    const fileCheck = secureFileService.safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      return {
        result: false,
        message: fileCheck.error || `Plan file not found: ${planFilePath}`,
      }
    }

    // 验证文件扩展名
    if (!planFilePath.endsWith('.md')) {
      return {
        result: false,
        message: 'Plan file must be a markdown file (.md)',
      }
    }

    return { result: true }
  },
  async *call(
    { planFilePath }: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    const fullFilePath = normalizeFilePath(planFilePath)
    const eventBus = getEventBus()
    const abortController = agentContext.abortController as AbortController

    // 读取计划文件内容
    const { content } = readTextContent(fullFilePath, 0)

    // 获取相对路径用于事件
    const relativePath = relative(getCwd(), fullFilePath)

    // 发送权限请求事件
    const requestData: PlanExitRequestData = {
      agentId: agentContext.agentId,
      planFilePath: relativePath,
      planContent: content,
      options: {
        startEditing: '开始代码编辑',
        clearContextAndStart: '清理上下文，并开始代码编辑',
      },
    }

    eventBus.emit('plan:exit:request', requestData)

    // 等待用户响应
    const selected = await new Promise<'startEditing' | 'clearContextAndStart'>(
      (resolve, reject) => {
        const handleResponse = (response: PlanExitResponseData) => {
          if (response.agentId !== agentContext.agentId) return

          eventBus.off('plan:exit:response', handleResponse)
          resolve(response.selected)
        }

        // 监听中断
        const handleAbort = () => {
          eventBus.off('plan:exit:response', handleResponse)
          reject(new Error('User cancelled the plan exit'))
        }

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', handleAbort, {
            once: true,
          })
        }

        eventBus.on('plan:exit:response', handleResponse)
      },
    )

    // 检查是否被中断
    checkAbortSignal(abortController)

    // 退出Plan模式，切换回Agent模式
    getConfManager().updateAgentMode('Agent')

    // 如果选择清理上下文
    if (selected === 'clearContextAndStart') {
      const stateManager = getStateManager()

      // 清空状态
      stateManager.clearAllState()

      // 设置新的用户消息
      const newUserMessage = createUserMessage([
        {
          type: 'text',
          text: `Implement the following plan:\n\n${content}`,
        },
      ])
      stateManager.setMessageHistory([newUserMessage], MAIN_AGENT_ID)

      // 触发 plan:implement 事件
      eventBus.emit('plan:implement', {
        planFilePath: relativePath,
        planContent: content,
      })
    }

    const data: ExitPlanModeOutput = {
      planFilePath,
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
            text: `Implement the following plan:\n\n${content}`,
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
  genResultForAssistant(output: ExitPlanModeOutput) {
    const { planFilePath, planContent, selected } = output

    if (selected === 'clearContextAndStart') {
      return `User has approved your plan and requested to clear context. The conversation history has been cleared.

You can now start implementing the plan. The plan file is located at ${planFilePath} if you need to reference it.

## Plan to Implement:
${planContent}`
    }

    return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${planFilePath}
You can refer back to it if needed during implementation.

## Approved Plan:
${planContent}

## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions. The plan file is located at ${planFilePath} if you need to reference it.`
  },
} satisfies Tool<typeof inputSchema, ExitPlanModeOutput>
