import { splitCommand, hasCommandInjection } from './commands'

// 仅凭首词即可判定安全的「真只读」单命令。
// find 列入只读，但需额外排除危险动作 flag（见 DANGEROUS_FIND_FLAGS）。
const READONLY_COMMANDS = new Set([
  'pwd', 'tree', 'date', 'which', 'find',
  'ls', 'grep', 'head', 'tail', 'cat', 'du', 'wc', 'echo', 'env', 'printenv',
])

// find 的危险动作 flag：可执行任意命令（-exec/-execdir/-ok/-okdir）、删除（-delete）、
// 写文件（-fprintf/-fprint/-fls）。命中则该 find 不走只读快速通道。
const DANGEROUS_FIND_FLAGS = /(^|\s)-(exec(dir)?|ok(dir)?|delete|fprintf?|fls)\b/

// 仅允许整条精确匹配的完整命令（多词命令不能按首词放行，如 git 仅放行只读子命令）
const SAFE_FULL_COMMANDS = new Set([
  'git status', 'git diff', 'git log', 'git branch',
])

// 段内重定向：> >> < << <<< >| <> n> n>> &> 等。命中则不走只读快速通道，
// 防止 `echo x > /etc/passwd`、`cat secret > file` 这类「只读首词 + 重定向」变成写文件原语。
const REDIRECTION_RE = /(^|\s)\d*(?:>>|<<<|<<|>\||<>|<&|>&|>|<)/

/**
 * 命令是否含重定向。用于「前缀授权」纵深防御：前缀匹配只看首词，
 * 而 `echo x > file` 的危险来自重定向，故含重定向的命令不应被前缀授权覆盖，
 * 也不应向用户提供「按前缀授权」选项。
 *
 * 先用 splitCommand 规范化（它会把 `x>file` 这类无空格重定向还原成带空格的 ` > ` 形式，
 * 并正确处理引号），再用 REDIRECTION_RE 检测；解析失败时保守按「含重定向」处理。
 */
export function hasRedirection(command: string): boolean {
  if (REDIRECTION_RE.test(command)) return true
  try {
    return splitCommand(command).some(seg => REDIRECTION_RE.test(seg))
  } catch {
    return true
  }
}

// 危险首词：危险性在参数里、不该按首词前缀授权的命令。授权 rm:* / sudo:* 等会把
// `rm -rf /`、任意 `sudo ...` 一并放行，故这些命令不提供前缀授权、也不被已存前缀覆盖。
const DANGEROUS_PREFIX_COMMANDS = new Set([
  'rm', 'rmdir', 'dd', 'shred', 'truncate',
  'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill',
  'sudo', 'doas', 'su',
  'mv',
])

function isDangerousSubcommand(seg: string): boolean {
  const s = seg.trim()
  const first = s.split(/\s+/)[0] ?? ''
  if (DANGEROUS_PREFIX_COMMANDS.has(first)) return true
  if (first.startsWith('mkfs')) return true               // mkfs / mkfs.ext4 等格式化
  if (first === 'find' && DANGEROUS_FIND_FLAGS.test(s)) return true
  return false
}

/**
 * 命令是否含「语义危险」子命令：危险首词（rm/sudo/mv 等）或 find 危险 flag。
 * 不含重定向——重定向是否危险取决于路径（项目内可能安全），应交给上层模型判断。
 *
 * 用于 AutoRun：命中即「确定性危险」，直接转人工，不调模型（避免模型误判 safe 放行）。
 * 解析失败保守按「危险」处理（fail-closed）。
 */
export function hasDangerousCommand(command: string): boolean {
  let segs: string[]
  try {
    segs = splitCommand(command)
  } catch {
    return true
  }
  return segs.some(isDangerousSubcommand)
}

/**
 * 命令是否「不适合按前缀授权」。命中则：
 *  - checkRunShellPermission 不向用户提供「按前缀授权」选项（只许单次确认）
 *  - matchesSavedPrefix 即便命中已存前缀也不放行（纵深防御，治存量配置）
 *
 * 涵盖：含重定向 / 危险首词（rm、sudo、mv 等）/ find 危险 flag。
 */
export function isUnsafeForPrefixAuth(command: string): boolean {
  return hasRedirection(command) || hasDangerousCommand(command)
}

function isReadonlySafeSubcommand(seg: string): boolean {
  const s = seg.trim()
  if (!s || REDIRECTION_RE.test(s)) return false
  const first = s.split(/\s+/)[0]!
  if (!READONLY_COMMANDS.has(first)) return false
  if (first === 'find' && DANGEROUS_FIND_FLAGS.test(s)) return false
  return true
}

/**
 * 整条命令是否可判定为「只读安全」，可直接放行（无需人工/模型）。
 * 基于 splitCommand 的分词逐子命令判定，从根本上消除「整串 split(' ')[0]」带来的
 * 重定向 / 不带空格管道 / find 等绕过：
 *  - 含 && || ; ` $( 换行 → 交上层逐子命令或人工，这里不放行
 *  - 含管道时，要求每一段首词都在只读集合且段内无重定向
 */
export function isReadonlySafeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (SAFE_FULL_COMMANDS.has(trimmed)) return true
  if (hasCommandInjection(command)) return false
  let segs: string[]
  try {
    segs = splitCommand(command)
  } catch {
    return false
  }
  return segs.length > 0 && segs.every(isReadonlySafeSubcommand)
}
