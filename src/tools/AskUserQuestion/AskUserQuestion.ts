import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getEventBus } from '../../events/EventSystem'
import { AskQuestionRequestData, AskQuestionResponseData } from '../../events/types'
import { checkAbortSignal } from '../../types/errors'

// 选项 schema
const optionSchema = z.strictObject({
  label: z
    .string()
    .describe(
      'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
    ),
  description: z
    .string()
    .describe(
      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
    ),
})

// 问题 schema
const questionSchema = z.strictObject({
  question: z
    .string()
    .describe(
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    ),
  header: z
    .string()
    .describe(
      'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
    ),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(
      'The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no \'Other\' option, that will be provided automatically.',
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    ),
})

// 元数据 schema
const metadataSchema = z
  .strictObject({
    source: z
      .string()
      .optional()
      .describe(
        'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
      ),
  })
  .optional()

// 输入 schema
const inputSchema = z.strictObject({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe('Questions to ask the user (1-4 questions)'),
  answers: z
    .record(z.string(), z.string())
    .optional()
    .describe('User answers collected by the permission component'),
  metadata: metadataSchema.describe(
    'Optional metadata for tracking and analytics purposes. Not displayed to user.',
  ),
})

// 输出类型
interface AskUserQuestionOutput {
  questions: Array<{
    question: string
    header: string
    options: Array<{
      label: string
      description: string
    }>
    multiSelect: boolean
  }>
  answers?: Record<string, string>
  metadata?: {
    source?: string
  }
}

export const AskUserQuestionTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  genToolResultMessage(output: AskUserQuestionOutput) {
    const { questions, answers } = output
    const questionCount = questions.length
    const questionText = questionCount === 1 ? 'question' : 'questions'

    // 如果有答案，显示答案摘要
    if (answers && Object.keys(answers).length > 0) {
      const answeredCount = Object.keys(answers).length
      const answeredText = answeredCount === 1 ? 'answer' : 'answers'
      return {
        title: 'User Response',
        summary: ``,
        content: Object.entries(answers)
          .map(([q, a]) => `· ${q}: → ${a}`)
          .join('\n'),
      }
    }

    // 没有答案时，显示问题摘要
    return {
      title: 'Asking User',
      summary: `Asked ${questionCount} ${questionText}`,
      content: questions.map((q) => q.question).join('\n'),
    }
  },
  async validateInput(
    { questions }: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    // 验证 header 长度（schema 中未定义此约束）
    for (const question of questions) {
      if (question.header.length > 12) {
        return {
          result: false,
          message: `Header "${question.header}" exceeds maximum length of 12 characters.`,
        }
      }
    }

    return { result: true }
  },
  async *call(input: z.infer<typeof inputSchema>, agentContext: any) {
    const { questions, metadata } = input
    const eventBus = getEventBus()
    const abortController = agentContext.abortController as AbortController

    // 发送问答请求事件
    const requestData: AskQuestionRequestData = {
      agentId: agentContext.agentId,
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options.map((o) => ({
          label: o.label,
          description: o.description,
        })),
        multiSelect: q.multiSelect,
      })),
      metadata,
    }

    eventBus.emit('ask:question:request', requestData)

    // 等待用户响应
    const answers = await new Promise<Record<string, string>>(
      (resolve, reject) => {
        const handleResponse = (response: AskQuestionResponseData) => {
          if (response.agentId !== agentContext.agentId) return

          eventBus.off('ask:question:response', handleResponse)
          resolve(response.answers)
        }

        // 监听中断
        const handleAbort = () => {
          eventBus.off('ask:question:response', handleResponse)
          reject(new Error('User cancelled the question'))
        }

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', handleAbort, {
            once: true,
          })
        }

        eventBus.on('ask:question:response', handleResponse)
      },
    )

    // 检查是否被中断
    checkAbortSignal(abortController)

    const data: AskUserQuestionOutput = {
      questions,
      answers,
      metadata,
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(output: AskUserQuestionOutput) {
    const { questions, answers } = output

    // 如果有用户答案，返回答案信息
    if (answers && Object.keys(answers).length > 0) {
      const answerParts = Object.entries(answers).map(
        ([question, answer]) => `"${question}"="${answer}"`,
      )
      return `User has answered your questions: ${answerParts.join(', ')}. You can now continue with the user's answers in mind.`
    }

    // 没有答案时，返回等待用户响应的信息
    const questionList = questions.map((q) => `- ${q.question}`).join('\n')
    return `Waiting for user to answer the following questions:\n${questionList}`
  },
} satisfies Tool<typeof inputSchema, AskUserQuestionOutput>
