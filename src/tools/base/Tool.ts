import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Sema 可扩展工具系统的核心工具接口
 * 为所有工具实现提供标准化契约
 */

export interface ValidationResult {
  result: boolean
  message?: string
  errorCode?: number
  meta?: any
}

// 核心工具接口
export interface Tool<
  TInput extends z.ZodObject<any> = z.ZodObject<any>,
  TOutput = any,
> {
  name: string

  description?: string | (() => string)

  toolParams: TInput

  // 工具无副作用：跳过权限确认，且可并行执行
  isSafe: () => boolean

  // 工具当前是否可用：返回 false 时不进入工具列表（如未配置文生图模型）；不实现视为始终可用
  isEnabled?: () => boolean

  // 工具自报会产生破坏性/不可逆副作用（如 MCP destructiveHint）：AutoRun 档位下仍转人工确认
  isDestructive?: () => boolean

  validateInput?: (
    input: z.infer<TInput>,
    agentContext: any, // AgentContext from Conversation.ts
  ) => Promise<ValidationResult>

  genResultForAssistant: (output: TOutput) => Anthropic.ToolResultBlockParam['content']

  genToolPermission?: (
    input: z.infer<TInput>,
  ) => { title: string; summary?: string; content: string | Record<string, any> }

  // 生成 tool:execution:complete 事件的展示内容。不实现则工具结束时不发 complete 事件。
  // 约定：凡在 call 内发过 tool:execution:chunk 的工具必须实现本方法，宿主已把工具行标成运行中，
  // 没有 complete / error 收尾就会一直显示运行中
  genToolResultMessage?: (output: TOutput, input?: z.infer<TInput>) => { title: string; summary: string; content: string | Record<string, any> }

  getDisplayTitle?: (input?: z.infer<TInput>) => string

  // 工具虽非只读，但多个实例之间互相独立，可并发执行
  canRunConcurrently?: () => boolean

  // 工具是否支持中断并返回部分结果（如 Bash）
  // 实现此方法且返回 true 的工具，在执行被中断时会保留 genResultForAssistant 的结果
  // 不实现此方法的工具，中断时返回标准取消消息
  // 约定：凡在 call 内发过 tool:execution:chunk 的工具必须返回 true，并自行处理中断——
  // 监听 agentContext.abortController.signal，中断时把结果 data.interrupted 置 true 并正常 yield result
  // （genResultForAssistant 对中断结果返回 TOOL_INTERRUPT_MSG），RunTools 会把 interrupted 透传到
  // tool:execution:complete，宿主据此把运行中的工具行收口为中断态；否则工具行会一直显示运行中
  supportsInterrupt?: () => boolean

  // 工具的核心执行方法
  call: (
    input: z.infer<TInput>,
    agentContext: any, 
  ) => AsyncGenerator<
    { type: 'result'; data: TOutput; resultForAssistant?: Anthropic.ToolResultBlockParam['content']; additionalBlocks?: Anthropic.ContentBlockParam[] },
    void,
    unknown
  >
}