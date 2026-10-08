import { z } from 'zod'
import { basename, relative } from 'path'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/generateImage'
import { TOOL_NAME_GENERATE_IMAGE } from '../prompt/tool'
import { generateImage } from '../services/image/generateImage'
import type { ImageGenResult } from '../types/imageModel'
import { getModelManager } from '../manager/ModelManager'
import { getCheckpointManager } from '../manager/CheckpointManager'
import { MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import type { ToolExecutionChunkData } from '../events/types'
import { canonicalizeFilePath } from '../util/file'
import { readInitialCwd } from '../util/cwd'
import { getTimeTag } from '../util/time'

const TOOL_NAME = TOOL_NAME_GENERATE_IMAGE
const TITLE_MAX_LEN = 40

const toolParams = z.strictObject({
  prompt: z.string().min(1).describe('Detailed description of the image to generate'),
  output_path: z
    .string()
    .optional()
    .describe('Absolute destination path. Only when the user explicitly said where to save the image'),
  transparent: z
    .boolean()
    .optional()
    .describe('Request a transparent background (PNG with alpha). Only for isolated subjects such as icons, sprites or cut-out assets, never for scenes. Not every model supports it'),
})

type ToolRes = ImageGenResult & {
  requestedPath?: string  // 模型传入的 output_path（规范化后），用于提示实际路径与之不同
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

function displayTitle(prompt?: string): string {
  const text = prompt?.trim()
  if (!text) return 'GenerateImage'
  return text.length > TITLE_MAX_LEN ? `${text.slice(0, TITLE_MAX_LEN)}...` : text
}

export const GenerateImage = {
  name: TOOL_NAME,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  // 未配置文生图模型（image 指针为空或失效）时不进入工具列表
  isEnabled() {
    return getModelManager().getImageModel() !== null
  },
  // 各次调用互相独立，可并发出多张
  canRunConcurrently() {
    return true
  },
  async validateInput() {
    if (!getModelManager().getImageModel()) {
      return { result: false, message: 'No image generation model is configured.' }
    }
    return { result: true }
  },
  genToolResultMessage(data: ToolRes, input?: { prompt?: string }) {
    const first = data.images[0]
    const displayPath = first ? relative(readInitialCwd(), first.filePath) : ''
    return {
      title: first ? basename(first.filePath) : TOOL_NAME,
      summary: data.images.length > 1 ? `Generated ${data.images.length} images` : `Generated image ${displayPath}`,
      // prompt 随结果带出：完成事件的 title 是文件名，宿主展示提示词只能从这里取
      content: { model: data.model, prompt: input?.prompt ?? '', images: data.images },
    }
  },
  getDisplayTitle(input?: { prompt?: string }) {
    return displayTitle(input?.prompt)
  },
  async *call({ prompt, output_path, transparent }: { prompt: string; output_path?: string; transparent?: boolean }, agentContext: any) {
    const profile = getModelManager().getImageModel()
    if (!profile) {
      throw new Error('No image generation model is configured.')
    }
    const requestedPath = output_path ? canonicalizeFilePath(output_path) : undefined

    if (agentContext.agentId === MAIN_AGENT_ID) {
      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: TOOL_NAME,
        title: displayTitle(prompt),
        summary: '',
        content: `${getTimeTag()}Generating image with ${profile.modelName}...\n`,
      }
      getEventBus().emit('tool:execution:chunk', chunkData, agentContext.sessionId)
    }

    const result = await generateImage({
      profile,
      prompt,
      outputPath: requestedPath,
      transparent,
      signal: agentContext.abortController?.signal,
      // 指定了落盘位置的图片纳入 Fork 快照（fail-closed：捕获失败则不写盘）；附件目录由宿主管理，不纳入
      beforeWrite: requestedPath
        ? filePath => getCheckpointManager().recordPreEdit(agentContext.sessionId, agentContext.agentId, filePath)
        : undefined,
    })

    const output: ToolRes = { ...result, requestedPath }
    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.genResultForAssistant(output),
    }
  },
  genResultForAssistant(output: ToolRes) {
    const lines = [`Image generated with ${output.model} in ${(output.durationMs / 1000).toFixed(1)}s. The user already sees it.`]
    // 未指定位置：路径只供后续操作（自检、复制到项目），提示模型不要在回复里复述；指定了位置则确认存到了哪
    for (const image of output.images) {
      const info = `${image.filePath} (${image.mediaType}, ${formatSize(image.bytes)})`
      lines.push(output.requestedPath ? `Saved to: ${info}` : `File: ${info} — for follow-up operations only, do not repeat it in your reply.`)
    }
    const first = output.images[0]
    if (output.requestedPath && first && first.filePath !== output.requestedPath) {
      lines.push(`Note: the saved path differs from output_path (${output.requestedPath}) because of the actual image format or an existing file.`)
    }
    return lines.join('\n')
  },
} satisfies Tool<typeof toolParams, ToolRes>
