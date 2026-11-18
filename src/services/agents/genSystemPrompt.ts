import { getGitStatus } from '../../util/git'
import { getEnv } from '../../util/env'
import { getConfManager } from '../../manager/ConfManager'
import { getMemoryManager, isMemoryDisabled } from '../memory/memManager'
import { DEFINE_SYSTEM_PROMPT } from '../../prompt/define'
import { AUTO_MEMORY_PROMPT } from '../../prompt/memory'
import { SYSTEM_PROMPT } from '../../prompt/system'

type TextBlock = { type: 'text', text: string }

interface PromptBuildOptions {
  prefixPrompt?: string    // 前置提示（独立 text block，如产品级身份定义）
  corePrompt: string       // 核心提示词
  sections?: string[]      // 额外段落（如 memory）
  includeContext?: boolean  // 是否附加 env/gitStatus，默认 true
}

/**
 * 统一的提示词组装流程：prefixPrompt（可选） + corePrompt + sections + context
 */
async function buildPromptBlocks(options: PromptBuildOptions): Promise<TextBlock[]> {
  const blocks: TextBlock[] = []

  if (options.prefixPrompt?.trim()) {
    blocks.push({ type: 'text', text: options.prefixPrompt })
  }

  const parts: string[] = [options.corePrompt]

  if (options.sections) {
    parts.push(...options.sections)
  }

  if (options.includeContext !== false) {
    const context = await getContext()
    const env = genEnv(context)
    const git = genGitStatus(context)
    if (env) parts.push(env)
    if (git) parts.push(git)
  }

  blocks.push({ type: 'text', text: parts.filter(p => p.trim().length > 0).join('\n\n') })

  return blocks
}

/**
 * 主代理系统提示
 */
export async function formatSystemPrompt(): Promise<TextBlock[]> {
  // disableMemory：不拼内置记忆使用说明（记忆改由外部服务经 hook/MCP 提供）
  const sections = isMemoryDisabled() ? [] : [AUTO_MEMORY_PROMPT(getMemoryManager().getActiveMemoryDir())]

  const { prefixPrompt, corePrompt } = resolveMainPrompt()
  return buildPromptBlocks({
    prefixPrompt,
    corePrompt,
    sections,
    includeContext: !isEnvContextDisabled(),
  })
}

/**
 * 子代理系统提示
 */
export async function buildAgentSystemPrompt(agentPrompt: string): Promise<TextBlock[]> {
  return buildPromptBlocks({
    corePrompt: agentPrompt,
    includeContext: !isEnvContextDisabled(),
  })
}

// disableEnvContext：主代理与子代理的系统提示词都不拼 env/gitStatus，也不起 git 进程
function isEnvContextDisabled(): boolean {
  try {
    return !!getConfManager().getCoreConfig()?.disableEnvContext
  } catch {
    return false
  }
}

async function getContext(): Promise<Record<string, string>> {
  const [env, gitStatus] = await Promise.all([getEnv(), getGitStatus()])

  const context: Record<string, string> = {}
  if (env) context.env = env
  if (gitStatus) context.gitStatus = gitStatus
  return context
}

// 按 systemPromptMode 解析主提示词：replace 时配置的 systemPrompt 取代内置 SYSTEM_PROMPT，未配 systemPrompt 回落 append；
// replaceAll 已废弃，等同 replace。提示词模式只决定主提示词用谁，memory / env / gitStatus 由 disableMemory、disableEnvContext 控制
function resolveMainPrompt(): { prefixPrompt?: string, corePrompt: string } {
  try {
    const configManager = getConfManager();
    const coreConfig = configManager.getCoreConfig();
    const customPrompt = coreConfig?.systemPrompt?.trim();
    const mode = coreConfig?.systemPromptMode;
    if ((mode === 'replace' || mode === 'replaceAll') && customPrompt) {
      return { corePrompt: customPrompt };
    }
    if (customPrompt) {
      return { prefixPrompt: coreConfig!.systemPrompt, corePrompt: SYSTEM_PROMPT };
    }
  } catch (error) {
  }
  return { prefixPrompt: DEFINE_SYSTEM_PROMPT, corePrompt: SYSTEM_PROMPT };
}

export function genEnv(context: Record<string, any>): string {
  if (context && 'env' in context) {
    return `This is relevant environment information for your current runtime:
<env>${context.env}</env>`;
  }
  return '';
}

export function genGitStatus(context: Record<string, any>): string {
  if (context && 'gitStatus' in context) {
    return `gitStatus: ${context.gitStatus}`;
  }
  return '';
}

