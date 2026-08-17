import { getGitStatus } from '../../util/git'
import { getEnv } from '../../util/env'
import { getConfManager } from '../../manager/ConfManager'
import { getMemoryManager } from '../memory/memManager'
import { DEFINE_SYSTEM_PROMPT } from '../../prompt/define'
import { AUTO_MEMORY_PROMPT } from '../../prompt/memory'
import {
  SYSTEM_PROMPT,
  SUBAGENT_NOTES
} from '../../prompt/system'

type TextBlock = { type: 'text', text: string }

interface PromptBuildOptions {
  prefixPrompt?: string    // 前置提示（独立 text block，如产品级身份定义）
  corePrompt: string       // 核心提示词
  sections?: string[]      // 额外段落（memory、subagent notes 等）
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
  const memoryDir = getMemoryManager().getActiveMemoryDir()
  const memoryPrompt = AUTO_MEMORY_PROMPT(memoryDir)

  const { prefixPrompt, corePrompt, full } = resolveMainPrompt()
  // replaceAll：系统提示词仅为用户配置的 systemPrompt，不附加 memory/env/gitStatus
  if (full) {
    return [{ type: 'text', text: corePrompt }]
  }
  return buildPromptBlocks({
    prefixPrompt,
    corePrompt,
    sections: [memoryPrompt],
  })
}

/**
 * 子代理系统提示
 */
export async function buildAgentSystemPrompt(agentPrompt: string): Promise<TextBlock[]> {
  return buildPromptBlocks({
    corePrompt: agentPrompt,
    sections: [SUBAGENT_NOTES],
  })
}

async function getContext(): Promise<Record<string, string>> {
  const [env, gitStatus] = await Promise.all([getEnv(), getGitStatus()])

  const context: Record<string, string> = {}
  if (env) context.env = env
  if (gitStatus) context.gitStatus = gitStatus
  return context
}

// 是否处于完全替换模式（systemPromptMode=replaceAll 且配置了 systemPrompt）；
// 该模式下系统提示词不附加 memory/env/gitStatus，且 turn-level reminder 也不注入 memory
export function isFullReplaceMode(): boolean {
  try {
    const coreConfig = getConfManager().getCoreConfig();
    return coreConfig?.systemPromptMode === 'replaceAll' && !!coreConfig?.systemPrompt?.trim();
  } catch {
    return false;
  }
}

// 按 systemPromptMode 解析主提示词：replace 时配置的 systemPrompt 取代内置 SYSTEM_PROMPT；
// replaceAll 时额外跳过 memory/env/gitStatus（full=true）；两者未配 systemPrompt 均回落 append
function resolveMainPrompt(): { prefixPrompt?: string, corePrompt: string, full?: boolean } {
  try {
    const configManager = getConfManager();
    const coreConfig = configManager.getCoreConfig();
    const customPrompt = coreConfig?.systemPrompt?.trim();
    const mode = coreConfig?.systemPromptMode;
    if (mode === 'replaceAll' && customPrompt) {
      return { corePrompt: customPrompt, full: true };
    }
    if (mode === 'replace' && customPrompt) {
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

