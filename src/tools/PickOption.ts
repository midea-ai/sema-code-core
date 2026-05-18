import { z } from 'zod'
import { Tool } from './base/Tool'
import { getEventBus } from '../events/EventSystem'
import { PickOptionRequestData, PickOptionResponseData } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { TOOL_NAME_PICK_OPTION } from '../prompt/tool'

const idField = z
  .string()
  .min(1)
  .describe(
    'Unique stable identifier for this question (lowercase snake_case, e.g. "platform", "tone"). Used internally; not shown to the user.',
  )

const labelField = z
  .string()
  .describe(
    'The question shown to the user (max 60 chars). Be concise and unambiguous.',
  )

const requiredField = z
  .boolean()
  .optional()
  .describe(
    'If true, the user must answer this question to submit the form. Default false.',
  )

const radioQ = z.strictObject({
  type: z.literal('radio'),
  id: idField,
  label: labelField,
  required: requiredField,
  options: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe(
      'Mutually exclusive choices. 2–5 items. If you need 6 or more options, use "select" instead.',
    ),
})

const checkboxQ = z.strictObject({
  type: z.literal('checkbox'),
  id: idField,
  label: labelField,
  required: requiredField,
  options: z
    .array(z.string())
    .min(2)
    .max(7)
    .describe('Non-exclusive choices the user can combine. 2–7 items.'),
  maxSelections: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional cap on how many options can be selected at once.'),
})

const selectQ = z.strictObject({
  type: z.literal('select'),
  id: idField,
  label: labelField,
  required: requiredField,
  options: z
    .array(z.string())
    .min(6)
    .max(10)
    .describe(
      'Dropdown choices. 6–10 items. Last-resort fallback — only use "select" when you truly need 6+ options. For 5 or fewer options, always use "radio".',
    ),
})

const textQ = z.strictObject({
  type: z.literal('text'),
  id: idField,
  label: labelField,
  required: requiredField,
  placeholder: z
    .string()
    .optional()
    .describe('Hint text shown inside the empty input.'),
})

const textareaQ = z.strictObject({
  type: z.literal('textarea'),
  id: idField,
  label: labelField,
  required: requiredField,
  placeholder: z.string().optional(),
})

const questionSchema = z.discriminatedUnion('type', [
  radioQ,
  checkboxQ,
  selectQ,
  textQ,
  textareaQ,
])

const toolParams = z.strictObject({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(7)
    .describe(
      'An array of 1–7 questions to ask the user in a single round. Batch related questions into ONE call instead of issuing multiple pick_option calls back-to-back.',
    ),
  estimatedTime: z
    .string()
    .max(20)
    .optional()
    .describe(
      'Short, human-readable estimate of how long answering will take. Rendered in the UI as a quick-confirm hint. Examples: "~30 sec", "about 1 min". Keep it under ~10 characters.',
    ),
  intro: z
    .string()
    .max(80)
    .optional()
    .describe(
      'A single short sentence (≤80 chars) that frames the form for the user — what answering these unlocks or what happens next. Example: "Lock these in and I\'ll start building.". Skip if the questions are self-explanatory.',
    ),
})

type Question = z.infer<typeof questionSchema>

interface PickOptionOutput {
  questions: Question[]
  estimatedTime?: string
  intro?: string
  answers: string | null
}

export const PickOption = {
  name: TOOL_NAME_PICK_OPTION,
  description() {
    return `Ask the user one or more questions in a single form. Use this for: getting missing details/preferences, clarifying vague requests, deciding between approaches, or letting the user choose a path forward.

Question types:
- radio    : pick exactly one — 2–5 options. Default for any single-choice question.
- select   : pick exactly one from a dropdown — 6–10 options. LAST-RESORT fallback only when you genuinely need 6+ options. Before reaching for it, try to merge similar options or trim niche ones until you fit into radio (≤5).
- checkbox : pick zero or more; set maxSelections to cap (2–7 options)
- text     : ONE-LINE free-form input. Good for: project names, URLs, numeric counts/estimates, short identifiers. Bad for: anything that fits 2–5 enumerable options.
- textarea : MULTI-LINE free-form input. Good for: constraints/requirements, references, "anything else I should know" catch-all. Bad for: short answers (use text) or enumerable answers (use radio/checkbox).

Choice types FIRST. Free-form is the last resort:
- Always prefer radio/checkbox/select. Before using text or textarea, ask yourself: "Can I enumerate the 3–5 most likely answers?" If yes, use radio.
- For single-choice: always prefer radio. Use select ONLY when the question genuinely cannot be answered with 5 or fewer options.
- AT MOST ONE textarea per form. Multiple textareas drain user attention and the form will be skipped.

Response format:
The user's answers come back as a pre-formatted plain-text list — one line per question, in the form "- <label>: <answer>". A skipped question shows "(skipped)". For checkbox questions, multiple selections are joined with "; " (semicolon + space), e.g. "- Features: Auth; Billing; Notifications".

Rules:
- The 'questions' field is an ARRAY — batch up to 7 related questions into ONE call. Never make multiple TOOL_NAME_PICK_OPTION calls back-to-back.
- Keep forms tight: do NOT exceed 5 questions unless every one of them is essential.
- Prefer choice types (radio/checkbox/select) over text/textarea. Only use free-form input when the answer truly cannot be enumerated.
- To recommend a default, put that option first and append " (Recommended)" to its label.
- Each question must have a unique 'id' (lowercase snake_case).
- Do NOT restate UI affordances in the label. The frontend automatically appends type/constraint hints — for example, a checkbox question with maxSelections: 3 is rendered as "<label> (multi-select, max 3)". Writing labels like "Core modules (select multiple, max 3)" produces duplicated hints. Just write the bare question, e.g. "Core modules".
- Do NOT add an "Other" / "Skip" / "None" option yourself — the UI automatically provides an "Other" free-text fallback for radio/select/checkbox and per-question skipping. Because every choice question already has an "Other" escape hatch, prefer radio even when you cannot enumerate every possible answer.
- CRITICAL: Never re-ask a question the user has already answered OR skipped in this session, and never issue a rephrased version of it. Treat answered or skipped questions as final and proceed with reasonable defaults based on existing context.`
  },
  toolParams,
  isSafe() {
    return true
  },
  genToolResultMessage(output: PickOptionOutput) {
    const { questions, answers } = output

    if (answers && answers.trim().length > 0) {
      return {
        title: 'User Response',
        summary: '',
        content: answers,
      }
    }

    return {
      title: 'User Cancelled',
      summary: '',
      content: questions.map((q) => `- ${q.label}`).join('\n'),
    }
  },
  async validateInput(
    { questions }: z.infer<typeof toolParams>,
    _agentContext: any,
  ) {
    const ids = new Set<string>()
    let textareaCount = 0
    for (const q of questions) {
      if (q.label.length > 60) {
        return {
          result: false,
          message: `Label "${q.label}" exceeds maximum length of 60 characters.`,
        }
      }
      if (ids.has(q.id)) {
        return {
          result: false,
          message: `Duplicate question id "${q.id}". Each question must have a unique id.`,
        }
      }
      ids.add(q.id)
      if (q.type === 'textarea') {
        textareaCount++
        if (textareaCount > 1) {
          return {
            result: false,
            message: `A form may contain at most one "textarea" question. Use "text" for short free-form answers, or merge multi-line questions into a single catch-all.`,
          }
        }
      }
    }
    return { result: true }
  },
  async *call(input: z.infer<typeof toolParams>, agentContext: any) {
    const eventBus = getEventBus()
    const abortController = agentContext.abortController as AbortController

    const requestData: PickOptionRequestData = {
      agentId: agentContext.agentId,
      questions: input.questions,
      estimatedTime: input.estimatedTime,
      intro: input.intro,
    }

    eventBus.emit('pick:option:request', requestData)

    const answers = await new Promise<string | null>((resolve, reject) => {
      const handleResponse = (response: PickOptionResponseData) => {
        if (response.agentId !== agentContext.agentId) return
        eventBus.off('pick:option:response', handleResponse)
        resolve(response.answers)
      }

      const onAbortRequested = () => {
        eventBus.off('pick:option:response', handleResponse)
        reject(new Error('User cancelled the question'))
      }

      if (abortController?.signal) {
        abortController.signal.addEventListener('abort', onAbortRequested, {
          once: true,
        })
      }

      eventBus.on('pick:option:response', handleResponse)
    })

    checkAbortSignal(abortController)

    const data: PickOptionOutput = {
      questions: input.questions,
      estimatedTime: input.estimatedTime,
      intro: input.intro,
      answers,
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(output: PickOptionOutput) {
    const { answers } = output

    if (answers && answers.trim().length > 0) {
      return `The user responded:\n${answers}`
    }

    return `The user cancelled the form without submitting any answers. Proceed with reasonable defaults based on existing context.`
  },
} satisfies Tool<typeof toolParams, PickOptionOutput>
