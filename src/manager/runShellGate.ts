import { isAbsolute, resolve, relative } from 'path'
import { TOOL_NAME_RUN_SHELL } from '../prompt/tool'
import { splitCommand, hasCommandInjection, stripHeredocBody } from '../util/commands'
import { readInitialCwd } from '../util/cwd'
import { normalizeCmpPath } from '../util/platform'
import { TEMP_BASE_PATHS } from '../util/readPathClass'
import {
  isReadonlySafeCommand, isUnsafeForPrefixAuth, classifyDangerousCommand,
  classifyCommandSubstitutions, classifyMultilineCommand, DeleteTargetKind,
} from '../util/shellSafety'

// run_shell 权限闸门的确定性部分：不调模型、不发事件、不读会话状态，纯函数。
// PermissionManager 据此决定放行 / 交 AutoRun 模型 / 转人工；tests/manager/runShellGate.* 直接调用
// 它回答「这条命令会不会被前置拦截」，与线上逻辑同源。

// ==================== 路径辅助 ====================

export function isPathInsideRoot(filePath: string, root: string): boolean {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  const rel = relative(normalizeCmpPath(root), normalizeCmpPath(abs))
  if (!rel || rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

// 系统临时目录（清单见 util/readPathClass 的 TEMP_BASE_PATHS）下的文件视为临时文件，
// AutoEdit/AutoRun 下即便在项目外也自动放行编辑
export function isTempFile(filePath: string): boolean {
  // 相对路径按项目根解析（解析后必落在项目内，由 isPathInsideRoot 处理）；临时文件均为绝对路径
  const abs = isAbsolute(filePath) ? filePath : resolve(readInitialCwd(), filePath)
  const absNorm = normalizeCmpPath(abs)
  return TEMP_BASE_PATHS.some(base => {
    const rel = relative(normalizeCmpPath(base), absNorm)
    if (!rel || rel === '') return true
    return !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/**
 * 删除类命令（rm/rmdir/mv/find -delete）与 chmod 单个目标路径的允许范围裁决，
 * 供 classifyDangerousCommand 回调。目标满足其一才允许交模型判断：
 *  - 落在系统临时目录树内（含临时目录自身）
 *  - 落在项目根内，且：literal 目标不得是项目根自身（rm -rf . 级联全删仍转人工），
 *    globdir 目标（rm dist/*、find . -delete 的所在目录）允许是项目根；
 *    两种形态都排除 .git（删掉版本库即失去「项目内可恢复」的兜底）
 * 其余（项目外、~、无法解析）一律不允许 → 确定性转人工。
 */
export function isDeletableShellTarget(target: string, kind: DeleteTargetKind): boolean {
  const root = readInitialCwd()
  const abs = isAbsolute(target) ? target : resolve(root, target)
  if (isTempFile(abs)) return true
  const rel = relative(normalizeCmpPath(root), normalizeCmpPath(abs))
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  if (!rel || rel === '') return kind === 'globdir'
  const first = rel.split(/[\\/]/)[0]
  if (first === '.git') return false
  return true
}

// ==================== 白名单 / 已存授权 ====================

function runShellToolHasExactMatch(command: string, allowedTools: string[]): boolean {
  // 只读安全命令快速通道：基于 splitCommand 分词逐子命令判定，
  // 杜绝「整串 split(' ')[0]」导致的重定向 / 不带空格管道 / find 危险 flag 绕过
  if (isReadonlySafeCommand(command)) return true
  if (allowedTools.includes(`${TOOL_NAME_RUN_SHELL}(${command})`)) return true
  return allowedTools.includes(`${TOOL_NAME_RUN_SHELL}(${command}:*)`)
}

// 已保存的前缀授权 run_shell(P:*) 用字符串前缀匹配判定覆盖，无需模型提取前缀
function matchesSavedPrefix(command: string, allowedTools: string[]): boolean {
  // 前缀匹配只看首词，无法识别参数/重定向带来的危险。危险命令（含重定向、rm/sudo/mv
  // 等危险首词、find 危险 flag）即便首词被前缀授权也不放行，避免 `rm:*`/`echo:*` 退化为
  // 任意删除/写文件原语。
  if (isUnsafeForPrefixAuth(command)) return false
  const open = `${TOOL_NAME_RUN_SHELL}(`
  for (const entry of allowedTools) {
    if (!entry.startsWith(open) || !entry.endsWith(':*)')) continue
    const prefix = entry.slice(open.length, -':*)'.length)
    if (prefix && (command === prefix || command.startsWith(`${prefix} `))) return true
  }
  return false
}

export function isRunShellCommandPermitted(command: string, allowedTools: string[]): boolean {
  return runShellToolHasExactMatch(command, allowedTools) || matchesSavedPrefix(command, allowedTools)
}

// ==================== 闸门分类 ====================

// 命中的阶段（按检查顺序）：
//  injection → 注入形态（$() / ; / for 循环 / heredoc 后接命令）
//  readonly  → 只读白名单或已存精确/前缀授权
//  danger    → 危险命令分级（硬危险 / 灰区）
//  covered   → 每个子命令都被白名单/授权覆盖
//  uncovered → 无确定性结论
export type RunShellGateStage = 'injection' | 'readonly' | 'danger' | 'covered' | 'uncovered'

// 确定性结论：allow 直接放行；model 交 AutoRun 模型（非 AutoRun 档转人工）；human 确定性转人工，不调模型
export type RunShellGateVerdict = 'allow' | 'model' | 'human'

export interface RunShellGate {
  // 归一化后的命令（去首尾空白、去 `cd <项目根> && ` 前缀），后续流程一律用它
  command: string
  stage: RunShellGateStage
  verdict: RunShellGateVerdict
  detail: string
}

export function normalizeShellCommand(command: string): string {
  // 归一化首尾空白：命令常带尾随换行（如 heredoc 结束符后的 \n）。不 trim 会让 stripHeredocBody
  // 剥离正文后骨架残留一个空行 → 误判「结束符后藏了第二条命令」→ 合法 heredoc 脚本被当成注入。
  // trim 只去首尾空白，不影响 ; / $() / 第二条命令等真注入向量的检出。
  return command.trim().replace(`cd ${readInitialCwd()} && `, '')
}

export function classifyRunShellGate(rawCommand: string, allowedTools: string[] = []): RunShellGate {
  const command = normalizeShellCommand(rawCommand)

  // 先拆分子命令并做注入检测——必须先于白名单/AutoRun 放行，否则白名单主命令词（echo/cat/grep 等）
  // 夹带 $()、`` 命令替换或换行即可绕过检测（如 echo $(id)）。
  const subCommands = splitCommand(command)
  // heredoc 正文是喂给程序的数据而非 shell 命令，但底层 shell-quote 不理解 heredoc，会把正文打散、
  // 换行有时残留，导致合法的多行内联脚本（python3 << 'EOF' ...）被误判注入。注入检测改在「剥离
  // heredoc 正文后的骨架」上进行：骨架残留换行说明结束符之后还接了命令（多行形态，逐行分类）；
  // 否则按子命令逐段检测。无法安全剥离（多 heredoc 同行/缺结束符/不带引号且正文含命令替换）时
  // stripHeredocBody 原样返回，退回逐段检测，绝不因剥离而放过真注入。
  const injectionSkeleton = stripHeredocBody(command)
  const injectionDetected = injectionSkeleton !== command
    ? injectionSkeleton.includes('\n') || splitCommand(injectionSkeleton).some(hasCommandInjection)
    : subCommands.some(hasCommandInjection)
  if (injectionDetected) {
    // 注入形态细分（$() 替换、`;`/for 循环、heredoc 之后再接命令、带变量的 mv/rm）：
    //  dangerous（硬危险首词/解释器/eval、字面目标出项目的删除、反引号、解析失败）→ 确定性转人工，
    //    不给模型机会；
    //  readonly/gray（静态解析不了但模型读得懂：变量操作数、循环、多行脚本）→ 交模型判断。
    // 刻意不走白名单/前缀/覆盖等确定性放行——那些检查不理解替换语义（echo:* 前缀
    // 会把 echo $(任意命令) 一并放行），放行只能由模型或人工裁决。
    const substClass = injectionSkeleton !== command
      ? classifyMultilineCommand(injectionSkeleton, isDeletableShellTarget)
      : classifyCommandSubstitutions(command, isDeletableShellTarget)
    if (substClass === 'dangerous') {
      return { command, stage: 'injection', verdict: 'human', detail: '注入/危险命令替换' }
    }
    return { command, stage: 'injection', verdict: 'model', detail: `含 ${substClass} 注入形态` }
  }

  // 命中白名单或项目配置已允许
  if (runShellToolHasExactMatch(command, allowedTools)) {
    return { command, stage: 'readonly', verdict: 'allow', detail: '只读白名单/已存授权' }
  }

  // 危险命令分级：
  //  hard（sudo/dd/chown 等硬危险、删除/chmod 目标出项目/无法静态解析）→ 确定性转人工，
  //    不调模型——语义本身危险或不可逆，不该给模型机会判 safe 放行；
  //  gray（rm/rmdir/mv/find -delete/chmod 且所有目标确定性落在项目内或临时目录；kill/pkill）
  //    → 交模型结合上下文判断（用户明确要求删除/清理、agent 自建文件、可再生中间产物、
  //    agent 自启的 dev server → safe 一次性放行）。
  const dangerClass = classifyDangerousCommand(command, isDeletableShellTarget)
  if (dangerClass === 'hard') {
    return { command, stage: 'danger', verdict: 'human', detail: '硬危险命令' }
  }
  if (dangerClass === 'gray') {
    return { command, stage: 'danger', verdict: 'model', detail: '灰区危险命令' }
  }

  // 每个子命令都被 SAFE_COMMANDS / 精确授权 / 已保存前缀覆盖 → 放行（注入已在上面排除）。
  // 已被「确定性覆盖」的命令无需再调用快速模型——既省一次模型调用，也更准确
  // （确定性放行不应触发「模型自动放行」事件 tool:permission:auto）。
  if (subCommands.length > 0 && subCommands.every(subCmd => isRunShellCommandPermitted(subCmd, allowedTools))) {
    return { command, stage: 'covered', verdict: 'allow', detail: '子命令全部被覆盖' }
  }

  return { command, stage: 'uncovered', verdict: 'model', detail: '未覆盖命令' }
}
