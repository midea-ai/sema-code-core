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

// git 只读子命令：仅输出、不改动仓库/工作区。带这些子命令的 git 命令可直接放行
// （仍需通过下方 DANGEROUS_GIT_FLAGS 兜底）。
// 刻意排除 config / tag / branch / remote / stash 等——它们带参数即可写（如
// `git config k v`、`git tag x`、`git branch -D`、`git remote add`），无法只看子命令放行。
// 刻意排除 help——它会拉起 man/pager/浏览器（git help -w），属同类外部命令向量。
const READONLY_GIT_SUBCOMMANDS = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'reflog', 'shortlog', 'describe',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'whatchanged',
  'name-rev', 'grep', 'cherry', 'count-objects', 'var', 'version',
])

// 纯过滤器：读 stdin/文件、默认只写 stdout，可作为只读管道的一段直接放行。
// 注意 sort / uniq 仍有写文件的口子，由 isReadonlyFilterCommand 单独兜底。
const READONLY_FILTER_COMMANDS = new Set([
  'sort', 'uniq', 'nl', 'tac', 'rev', 'cut', 'tr', 'column', 'comm',
])

// sort 写文件 flag：-o / -ofile / 组合短选项含 o（如 -no） / --output。命中则该 sort 不只读。
const SORT_WRITE_FLAG_RE = /(^|\s)(-[a-z]*o|--output)/

// 统计 uniq 的操作数个数（INPUT/OUTPUT）。
//  - 单独的 `-` 是合法 stdin 操作数，须计入
//  - `--` 是 end-of-options，其后所有 token（含以 - 开头的）一律算操作数，
//    否则 `uniq -- in -out` 会把 -out 当 flag 漏算，绕过写文件拦截
function countUniqOperands(args: string[]): number {
  const dd = args.indexOf('--')
  if (dd >= 0) {
    const before = args.slice(0, dd).filter(t => t === '-' || !t.startsWith('-'))
    return before.length + (args.length - dd - 1)
  }
  return args.filter(t => t === '-' || !t.startsWith('-')).length
}

/**
 * 判断单个子命令是否为「只读过滤器」，可直接放行。
 * 多数过滤器只写 stdout，但 sort 可经 -o 写文件、uniq 第二个位置参数即输出文件，单独拦截。
 */
function isReadonlyFilterCommand(seg: string): boolean {
  const tokens = seg.trim().split(/\s+/)
  const first = tokens[0]
  if (!first || !READONLY_FILTER_COMMANDS.has(first)) return false
  // sort -o/--output 把结果写入文件
  if (first === 'sort' && SORT_WRITE_FLAG_RE.test(seg)) return false
  // uniq [INPUT [OUTPUT]]：出现第二个位置参数即写文件，保守拒绝 2+ 个操作数。
  if (first === 'uniq' && countUniqOperands(tokens.slice(1)) >= 2) return false
  return true
}

// git 危险 flag：即便子命令只读也可能执行命令或写文件，命中则不走只读快速通道。
//  -c <k=v>                覆盖任意配置 → core.pager/alias/diff 驱动可执行任意命令
//  --exec-path/--exec      指定/执行外部程序
//  --ext-diff              启用外部 diff 驱动（可执行配置的外部命令）
//  --output[=]             把输出写入文件（git diff --output=...）
//  --open-files-in-pager / -O[<pager>]  用指定 pager 打开匹配文件 → 执行任意命令
//    （git grep -O'sh -c …'）；-O 支持附着值，故用 -[A-Za-z]*O 兼顾 -Oless / -nO 等形式
const DANGEROUS_GIT_FLAGS = /(^|\s)(?:(?:-c|--exec-path|--exec|--ext-diff|--output|--open-files-in-pager)(?:\s|=|$)|-[A-Za-z]*O)/

/**
 * 判断单个子命令是否为「只读 git 命令」，可直接放行。
 * 要求：首词为 git、第二词为只读子命令、且整段不含危险 flag。
 * 形如 `git -C /path log`（git 与子命令间夹带需取值的全局选项）不识别为只读 →
 * 退回人工确认，安全优先。
 */
function isReadonlyGitCommand(seg: string): boolean {
  const tokens = seg.trim().split(/\s+/)
  if (tokens[0] !== 'git') return false
  const sub = tokens[1]
  if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) return false
  if (DANGEROUS_GIT_FLAGS.test(seg)) return false
  return true
}

// 段内重定向：> >> < << <<< >| <> n> n>> &> 等。命中则不走只读快速通道，
// 防止 `echo x > /etc/passwd`、`cat secret > file` 这类「只读首词 + 重定向」变成写文件原语。
const REDIRECTION_RE = /(^|\s)\d*(?:>>|<<<|<<|>\||<>|<&|>&|>|<)/

// 无副作用重定向：不写真实文件、不读任意文件，剥离后不影响只读判定。
//  n>/dev/null、n>>/dev/null、n</dev/null  —— 丢弃/空输入到 /dev/null（要求紧跟边界，
//    排除 /dev/null/../etc 与 /dev/nullx 等伪装）
//  n>&m、>&-、2>&1  —— fd 合并/关闭，不产生文件（splitCommand 会把 2>&1 规范化为 2>& 1）
// 仅 /dev/null 与 fd 复制视为安全，重定向到其它路径一律保留交 REDIRECTION_RE 拦截。
const SAFE_REDIR_RE = /(?<=^|\s)(?:\d*(?:>>?|<)\s*\/dev\/null(?=\s|$)|\d*>&\s*(?:\d+|-)(?=\s|$))/g

function stripSafeRedirections(seg: string): string {
  return seg.replace(SAFE_REDIR_RE, ' ')
}

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
  if (!seg.trim()) return false
  // 先剥离「无副作用」重定向（丢弃到 /dev/null、fd 合并/关闭），残留任何重定向仍按危险拦截
  const s = stripSafeRedirections(seg).trim()
  if (!s || REDIRECTION_RE.test(s)) return false
  if (isReadonlyGitCommand(s)) return true
  if (isReadonlyFilterCommand(s)) return true
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
