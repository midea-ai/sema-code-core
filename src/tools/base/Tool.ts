import { z } from 'zod'

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

  inputSchema: TInput

  // 工具只读（不会修改系统状态） 可并行执行
  isReadOnly: () => boolean

  validateInput?: (
    input: z.infer<TInput>,
    agentContext: any, // AgentContext from Conversation.ts
  ) => Promise<ValidationResult>

  genResultForAssistant: (output: TOutput) => string

  genToolPermission?: (
    input: z.infer<TInput>,
  ) => { title: string; summary?: string; content: string | Record<string, any> }

  genToolResultMessage?: (output: TOutput, input?: z.infer<TInput>) => { title: string; summary: string; content: string | Record<string, any> }

  getDisplayTitle?: (input?: z.infer<TInput>) => string

  // 工具的核心执行方法
  call: (
    input: z.infer<TInput>,
    agentContext: any, 
  ) => AsyncGenerator<
    { type: 'result'; data: TOutput; resultForAssistant?: string },
    void,
    unknown
  >
}