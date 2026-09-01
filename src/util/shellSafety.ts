import { isAbsolute } from 'path'
import { splitCommand, hasCommandInjection } from './commands'

// 仅凭首词即可判定安全的「真只读」单命令。
// find 列入只读，但需额外排除危险动作 flag（见 ALWAYS_DANGEROUS_FIND_FLAGS），
// -exec/-execdir 则按目标命令递归分类（见 classifyFindExecTargets）。
const READONLY_COMMANDS = new Set([
  'pwd', 'tree', 'date', 'which', 'find',
  'ls', 'grep', 'head', 'tail', 'cat', 'du', 'wc', 'echo', 'env', 'printenv',
])

// find 的确定性危险 flag：删除（-delete）、写文件（-fprintf/-fprint/-fprint0/-fls）、
// 交互确认（-ok/-okdir，会在非 tty 下挂住 shell，且同样是命令执行原语）。
// 命中即确定性危险，无目标命令可细分；整段正则匹配（含 -exec 目标内），fail-closed。
// -exec/-execdir 不在此列：它们的危险性取决于目标命令，由 classifyFindExecTargets 递归分类。
const ALWAYS_DANGEROUS_FIND_FLAGS = /(^|\s)-(ok(dir)?|delete|fprint(0|f)?|fls)\b/

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
// 内部分两档（见 classifyDangerousCommand）：
//  硬危险（sudo/dd/chmod/kill 等）→ 永远确定性转人工，不给模型裁决权；
//  删除类（rm/rmdir/mv，另有 find -delete）→ 目标路径确定性落在项目内/临时目录时降为
//  灰区，AutoRun 档位交快速模型结合上下文判断。
// 本集合保持两档并集不变：前缀授权禁令、find -exec 目标与 $() 替换的递归分类仍按
// 「一律危险」处理（-exec rm / $(rm ...) 不参与放宽）。
const HARD_DANGEROUS_COMMANDS = new Set([
  'dd', 'shred', 'truncate',
  'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill',
  'sudo', 'doas', 'su',
])

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'mv'])

const DANGEROUS_PREFIX_COMMANDS = new Set([...HARD_DANGEROUS_COMMANDS, ...DELETE_COMMANDS])

// ==================== find -exec 目标命令分类 ====================

// find -exec 目标命令的分类结果，与顶层权限规则同构：
//  no-exec   → 段内无 -exec/-execdir，find 按普通只读命令处理
//  readonly  → 所有目标命令均为只读安全（cat/wc/grep 等）→ 该 find 整体视为只读，确定性放行
//  gray      → 目标既非只读也非确定性危险（如 node xxx.js）→ 不放行也不判危险，交 AutoRun 模型/人工
//  dangerous → 目标是危险首词/shell 解释器/嵌套危险 find，或解析失败（fail-closed）→ 确定性转人工
type FindExecClass = 'no-exec' | 'readonly' | 'gray' | 'dangerous'

const FIND_EXEC_TOKENS = new Set(['-exec', '-execdir'])

// shell 解释器：-exec sh -c '...' 是任意命令执行原语，与危险首词同级，
// 不给模型判断机会（isDangerousSubcommand 只查首词集合，覆盖不到这里）
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

// 剥掉 token 两侧成对的引号（find -exec cat {} ';' 中的 ';' → ;），用于识别结束符与 {}
function unquoteToken(t: string): string {
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1)
  }
  return t
}

function classifyExecTarget(target: string): 'readonly' | 'gray' | 'dangerous' {
  const t = target.trim()
  // 空目标（-exec ; / -exec +）不是合法 find 语法，按解析异常 fail-closed
  if (!t) return 'dangerous'
  const first = t.split(/\s+/)[0]!
  if (SHELL_INTERPRETERS.has(first)) return 'dangerous'
  // 递归复用顶层分类：危险首词/嵌套 find 危险 flag → dangerous；只读安全 → readonly；其余 → gray
  if (isDangerousSubcommand(t)) return 'dangerous'
  if (isReadonlySafeSubcommand(t)) return 'readonly'
  return 'gray'
}

/**
 * 提取 find 段内所有 -exec/-execdir 的目标命令（-exec 到 ;/+ 结束符之间、剥掉 {}），
 * 逐个分类后取最严结果：任一 dangerous → dangerous；否则任一 gray → gray；全 readonly → readonly。
 *
 * 结束符识别 token 级精确匹配 ; 或 +（含引号包裹形式）。`\;` 形式经 splitCommand 的转义占位
 * 处理后 `;` 会被当作命令分隔符消耗掉，段内只残留孤立的 `\`，找不到结束符 → fail-closed 判
 * dangerous，与现状（一律危险）一致，不放宽。
 */
function classifyFindExecTargets(seg: string): FindExecClass {
  const tokens = seg.trim().split(/\s+/)
  let cls: FindExecClass = 'no-exec'
  let i = 0
  while (i < tokens.length) {
    if (!FIND_EXEC_TOKENS.has(tokens[i]!)) { i++; continue }
    const targetTokens: string[] = []
    let j = i + 1
    let foundEnd = false
    for (; j < tokens.length; j++) {
      const bare = unquoteToken(tokens[j]!)
      if (bare === ';' || bare === '+') { foundEnd = true; break }
      if (bare !== '{}') targetTokens.push(tokens[j]!)
    }
    // 找不到结束符（\; 被打散 / 命令截断）→ fail-closed
    if (!foundEnd) return 'dangerous'
    const c = classifyExecTarget(targetTokens.join(' '))
    if (c === 'dangerous') return 'dangerous'
    if (c === 'gray') cls = 'gray'
    else if (cls === 'no-exec') cls = 'readonly'
    i = j + 1
  }
  return cls
}

// ==================== $() 命令替换分类 ====================

// 命令替换嵌套深度上限：正常命令极少超过 2 层，超限按解析失败 fail-closed
const MAX_SUBSTITUTION_DEPTH = 3

// 骨架占位符：替换 $(...) 后参与分词/分类，纯字母数字下划线，不会引入新的注入特征
const SUBST_PLACEHOLDER = '__SUBST__'

// $() 命令替换的分类结果，语义与 find -exec 目标分类同构：
//  readonly  → 所有内层命令与骨架均只读安全
//  gray      → 内层或骨架存在非只读、非确定性危险的段（node/cd 等）→ 交 AutoRun 模型
//  dangerous → 内层含危险首词/shell 解释器、反引号、解析失败/嵌套超限 → 确定性转人工
export type SubstitutionClass = 'readonly' | 'gray' | 'dangerous'

/**
 * 从 $( 之后的位置找配对的右括号，返回其下标；找不到返回 -1。
 * 括号仅在引号外计数（含 $(a (b) c) 的子 shell 嵌套）；单引号内全字面；
 * 双引号内 ) 为字面不计数。双引号内再嵌 $( 会重新进入命令上下文，解析
 * 复杂度陡增 → fail-closed；替换内任何位置出现反引号同样 fail-closed。
 */
function findSubstitutionEnd(s: string, start: number): number {
  let depth = 1
  let inSingle = false
  let inDouble = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (inSingle) {
      if (c === "'") inSingle = false
      continue
    }
    if (c === '\\') { i++; continue }
    if (inDouble) {
      if (c === '$' && s[i + 1] === '(') return -1
      if (c === '`') return -1
      if (c === '"') inDouble = false
      continue
    }
    if (c === "'") { inSingle = true; continue }
    if (c === '"') { inDouble = true; continue }
    if (c === '`') return -1
    if (c === '(') { depth++; continue }
    if (c === ')') {
      depth--
      if (depth === 0) return i
      continue
    }
  }
  return -1
}

/**
 * 提取整条命令中所有顶层 $(...) 命令替换：返回骨架（替换为占位符）与各内层命令文本。
 * 出现反引号（agent 不使用该写法，且无嵌套边界、解析不可靠）、括号不配对、引号不闭合
 * → 返回 null（fail-closed，维持确定性拦截）。
 * 必须在 splitCommand 之前调用：底层 shell-quote 不理解 $() 边界，会把内层的 && / | / ;
 * 当作顶层分隔符拆散替换体。
 */
function extractCommandSubstitutions(command: string): { skeleton: string; inners: string[] } | null {
  let inSingle = false
  let inDouble = false
  let skeleton = ''
  const inners: string[] = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (inSingle) {
      if (c === "'") inSingle = false
      skeleton += c
      continue
    }
    if (c === '\\') {
      skeleton += c + (next ?? '')
      i++
      continue
    }
    if (c === '`') return null
    if (c === '$' && next === '(') {
      const end = findSubstitutionEnd(command, i + 2)
      if (end < 0) return null
      inners.push(command.slice(i + 2, end))
      skeleton += SUBST_PLACEHOLDER
      i = end
      continue
    }
    if (!inDouble && c === "'") { inSingle = true; skeleton += c; continue }
    if (c === '"') { inDouble = !inDouble; skeleton += c; continue }
    skeleton += c
  }
  if (inSingle || inDouble) return null
  return { skeleton, inners }
}

/**
 * 对「注入特征仅可能来自 $() 命令替换」的整条命令做递归分类。
 * 内层命令先递归分类（内层自身可含 && / | / 嵌套 $() 等）；随后骨架经 splitCommand
 * 分段，逐段按顶层三层规则判定：危险首词/解释器/嵌套危险 find → dangerous；
 * 只读安全 → readonly；其余 → gray。骨架残留任何注入特征（换行等）→ dangerous。
 *
 * 供权限闸门使用：dangerous → 确定性转人工（不给模型机会）；readonly/gray → 交
 * AutoRun 模型判断。刻意不提供确定性放行——放行与否只由模型或人工裁决，解析器
 * 误差最多把命令送去模型，绝不静默放过。
 */
export function classifyCommandSubstitutions(command: string, depth = 0): SubstitutionClass {
  if (depth > MAX_SUBSTITUTION_DEPTH) return 'dangerous'
  const parsed = extractCommandSubstitutions(command)
  if (!parsed) return 'dangerous'
  let worst: SubstitutionClass = 'readonly'
  for (const inner of parsed.inners) {
    const c = classifyCommandSubstitutions(inner, depth + 1)
    if (c === 'dangerous') return 'dangerous'
    if (c === 'gray') worst = 'gray'
  }
  let segs: string[]
  try { segs = splitCommand(parsed.skeleton) } catch { return 'dangerous' }
  if (segs.length === 0) return 'dangerous'
  for (const seg of segs) {
    if (hasCommandInjection(seg)) return 'dangerous'
    const first = seg.trim().split(/\s+/)[0] ?? ''
    if (SHELL_INTERPRETERS.has(first)) return 'dangerous'
    if (isDangerousSubcommand(seg)) return 'dangerous'
    if (!isReadonlySafeSubcommand(seg)) worst = 'gray'
  }
  return worst
}

function isDangerousSubcommand(seg: string): boolean {
  const s = seg.trim()
  const first = s.split(/\s+/)[0] ?? ''
  if (DANGEROUS_PREFIX_COMMANDS.has(first)) return true
  if (first.startsWith('mkfs')) return true               // mkfs / mkfs.ext4 等格式化
  if (first === 'find') {
    if (ALWAYS_DANGEROUS_FIND_FLAGS.test(s)) return true
    if (classifyFindExecTargets(s) === 'dangerous') return true
  }
  return false
}

/**
 * 命令是否含「语义危险」子命令：危险首词（rm/sudo/mv 等）或 find 危险 flag。
 * 不含重定向——重定向是否危险取决于路径（项目内可能安全），应交给上层模型判断。
 *
 * 用于前缀授权禁令（isUnsafeForPrefixAuth）：命中即不提供/不匹配前缀授权。
 * AutoRun 权限闸门改用 classifyDangerousCommand 做进一步分级（硬危险 / 删除类灰区），
 * 两者的「危险」集合严格一致。解析失败保守按「危险」处理（fail-closed）。
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

// ==================== 危险命令分级（硬危险 / 删除类灰区） ====================

// find 的「非删除」硬危险 flag：写文件（-fprintf/-fprint/-fprint0/-fls）与交互确认（-ok/-okdir）。
// 与 ALWAYS_DANGEROUS_FIND_FLAGS 的差集是 -delete —— 后者单独识别为删除类灰区。
const FIND_HARD_ACTION_FLAGS = /(^|\s)-(ok(dir)?|fprint(0|f)?|fls)\b/
const FIND_DELETE_FLAG = /(^|\s)-delete\b/

/**
 * 危险命令分级结果：
 *  none      → 不含危险子命令（与 hasDangerousCommand === false 等价）
 *  deletable → 仅含删除类子命令（rm/rmdir/mv/find -delete）且所有删除目标确定性落在
 *              允许范围内（由调用方回调裁决，通常为项目内或系统临时目录）→ AutoRun 可交模型判断
 *  hard      → 硬危险（sudo/dd/chmod 等）、删除目标无法静态确认落在允许范围、或解析失败
 *              （fail-closed）→ 确定性转人工，不给模型机会
 */
export type DangerClass = 'none' | 'deletable' | 'hard'

// 删除目标的两种形态，供路径策略回调区分：
//  literal → 目标就是该路径本身（rm foo.txt）：项目根自身/.git 应被策略拒绝
//  globdir → 目标是「该目录下的匹配项」（rm dist/*.js 的 dist/、find . -delete 的 .）：
//            目录允许是项目根（删的是根下内容而非根本身），.git 仍应拒绝
export type DeleteTargetKind = 'literal' | 'globdir'
export type DeleteTargetChecker = (path: string, kind: DeleteTargetKind) => boolean

// 段内 token 及其安全相关特征：text 为去引号后的字面值；globIndex 为首个引号外
// 通配符（* ? [）在 text 中的下标（无则 -1）；hasExpansion 表示含未被单引号保护的
// $ 或反引号（变量/命令替换，无法静态解析路径）
type SegToken = { text: string; globIndex: number; hasExpansion: boolean }

/**
 * 引号感知的段内分词：按空白拆 token，剥掉引号字符，标记通配符与展开特征。
 * splitCommand 的输出段保留了原始引号（如 rm "my file.txt"），朴素 split(/\s+/)
 * 会把带空格的引号路径拆碎，这里必须自己扫描。引号不闭合 → null（fail-closed）。
 */
function tokenizeSeg(seg: string): SegToken[] | null {
  const tokens: SegToken[] = []
  let cur = ''
  let globIndex = -1
  let hasExpansion = false
  let started = false
  let inSingle = false
  let inDouble = false

  const push = () => {
    if (started) tokens.push({ text: cur, globIndex, hasExpansion })
    cur = ''
    globIndex = -1
    hasExpansion = false
    started = false
  }

  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (inSingle) {
      if (c === "'") { inSingle = false; continue }
      cur += c
      continue
    }
    if (c === '\\') {
      const next = seg[i + 1]
      if (next === undefined) return null
      cur += next
      i++
      started = true
      continue
    }
    if (inDouble) {
      if (c === '"') { inDouble = false; continue }
      if (c === '$' || c === '`') hasExpansion = true
      cur += c
      continue
    }
    if (c === "'") { inSingle = true; started = true; continue }
    if (c === '"') { inDouble = true; started = true; continue }
    if (/\s/.test(c)) { push(); continue }
    if (c === '$' || c === '`') hasExpansion = true
    if ((c === '*' || c === '?' || c === '[') && globIndex < 0) globIndex = cur.length
    cur += c
    started = true
  }
  if (inSingle || inDouble) return null
  push()
  return tokens
}

/**
 * 单个删除目标 token 是否可静态确认落在允许范围。
 * 含变量/命令替换、~ 展开 → 不可静态解析 → 拒绝；
 * cwd 不可靠（命令里出现 cd/pushd）时相对路径拒绝；
 * 通配符目标退化为「其字面前缀的目录部分」按 globdir 交策略回调。
 */
function checkDeleteTarget(t: SegToken, isDeletableTarget: DeleteTargetChecker, cwdUnreliable: boolean): boolean {
  if (t.hasExpansion) return false
  const text = t.text
  if (!text || text.startsWith('~')) return false
  if (cwdUnreliable && !isAbsolute(text)) return false
  if (t.globIndex >= 0) {
    const prefix = text.slice(0, t.globIndex)
    const slash = prefix.lastIndexOf('/')
    const dir = slash >= 0 ? prefix.slice(0, slash + 1) : ''
    return isDeletableTarget(dir || '.', 'globdir')
  }
  return isDeletableTarget(text, 'literal')
}

/**
 * rm/rmdir/mv 段的目标提取与校验：跳过 flag，`--` 之后全按操作数；
 * mv --target-directory=DIR 的 DIR 也计入目标（-t DIR 的 DIR 不带 - 前缀，天然计入）。
 * 无任何操作数（如裸 `rm -rf`）→ hard。
 */
function checkDeleteOperands(seg: string, isDeletableTarget: DeleteTargetChecker, cwdUnreliable: boolean): DangerClass {
  const tokens = tokenizeSeg(seg)
  if (!tokens || tokens.length === 0) return 'hard'
  const operands: SegToken[] = []
  let afterDoubleDash = false
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (!afterDoubleDash) {
      if (t.text === '--') { afterDoubleDash = true; continue }
      if (t.text.startsWith('--target-directory=')) {
        const v = t.text.slice('--target-directory='.length)
        operands.push({ text: v, globIndex: t.globIndex >= 0 ? Math.max(0, t.globIndex - '--target-directory='.length) : -1, hasExpansion: t.hasExpansion })
        continue
      }
      if (t.text.startsWith('-') && t.text !== '-') continue
    }
    operands.push(t)
  }
  if (operands.length === 0) return 'hard'
  for (const t of operands) {
    if (!checkDeleteTarget(t, isDeletableTarget, cwdUnreliable)) return 'hard'
  }
  return 'deletable'
}

/**
 * find … -delete 段的起始路径提取与校验：跳过 find 前置全局选项（-H/-L/-P/-O/-D val），
 * 收集表达式（- 开头 / ( / !）之前的位置参数为起始路径；无起始路径按 find 默认的 `.`。
 * 删除发生在起始路径目录树内，按 globdir 语义交策略回调。
 */
function checkFindDeleteTargets(seg: string, isDeletableTarget: DeleteTargetChecker, cwdUnreliable: boolean): DangerClass {
  const tokens = tokenizeSeg(seg)
  if (!tokens || tokens.length === 0) return 'hard'
  const paths: SegToken[] = []
  let i = 1
  while (i < tokens.length && /^-(H|L|P|O\S*|D)$/.test(tokens[i]!.text)) {
    if (tokens[i]!.text === '-D') i++
    i++
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.text.startsWith('-') || t.text === '(' || t.text === '!') break
    paths.push(t)
  }
  if (paths.length === 0) paths.push({ text: '.', globIndex: -1, hasExpansion: false })
  for (const t of paths) {
    // 起始路径含通配符（find dist/* -delete）：shell 已展开，逐个匹配项都是目录起点，
    // checkDeleteTarget 会按 globdir 退化到字面前缀目录，语义一致
    const ok = t.globIndex >= 0
      ? checkDeleteTarget(t, isDeletableTarget, cwdUnreliable)
      : (!t.hasExpansion && !!t.text && !t.text.startsWith('~') &&
         !(cwdUnreliable && !isAbsolute(t.text)) && isDeletableTarget(t.text, 'globdir'))
    if (!ok) return 'hard'
  }
  return 'deletable'
}

function classifyDangerousSeg(seg: string, isDeletableTarget: DeleteTargetChecker, cwdUnreliable: boolean): DangerClass {
  const s = seg.trim()
  const first = s.split(/\s+/)[0] ?? ''
  if (HARD_DANGEROUS_COMMANDS.has(first) || first.startsWith('mkfs')) return 'hard'
  if (first === 'find') {
    if (FIND_HARD_ACTION_FLAGS.test(s) || classifyFindExecTargets(s) === 'dangerous') return 'hard'
    if (!FIND_DELETE_FLAG.test(s)) return 'none'
    if (REDIRECTION_RE.test(s)) return 'hard'
    return checkFindDeleteTargets(s, isDeletableTarget, cwdUnreliable)
  }
  if (DELETE_COMMANDS.has(first)) {
    // 删除命令夹带重定向属反常组合，不细分，fail-closed
    if (REDIRECTION_RE.test(s)) return 'hard'
    return checkDeleteOperands(s, isDeletableTarget, cwdUnreliable)
  }
  return 'none'
}

/**
 * 整条命令的危险分级：逐子命令取最严（任一 hard → hard；否则任一 deletable → deletable）。
 * 与 hasDangerousCommand 严格对齐：本函数返回 none 当且仅当 hasDangerousCommand 为 false，
 * 即分级只在「现状确定性转人工」的集合内部细分，绝不扩大放行面。
 *
 * 命令里出现 cd/pushd/popd 时后续子命令的 cwd 无法静态跟踪，相对路径目标一律拒绝
 * （绝对路径不受影响）。解析失败 fail-closed 判 hard。
 *
 * @param isDeletableTarget 路径策略回调：判定单个删除目标（已解析为字面路径）是否落在
 *        允许删除的范围（由调用方定义，通常为项目内或系统临时目录，排除项目根自身与 .git）
 */
export function classifyDangerousCommand(command: string, isDeletableTarget: DeleteTargetChecker): DangerClass {
  let segs: string[]
  try {
    segs = splitCommand(command)
  } catch {
    return 'hard'
  }
  const cwdUnreliable = segs.some(seg => {
    const first = seg.trim().split(/\s+/)[0]
    return first === 'cd' || first === 'pushd' || first === 'popd'
  })
  let cls: DangerClass = 'none'
  for (const seg of segs) {
    const c = classifyDangerousSeg(seg, isDeletableTarget, cwdUnreliable)
    if (c === 'hard') return 'hard'
    if (c === 'deletable') cls = 'deletable'
  }
  return cls
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
  // env 带任何参数即是「执行任意命令」的包装器（env rm -rf /），只有裸 env（打印环境变量）才只读
  if (first === 'env' && s.split(/\s+/).length > 1) return false
  if (first === 'find') {
    if (ALWAYS_DANGEROUS_FIND_FLAGS.test(s)) return false
    // 只有「无 -exec」或「所有 -exec 目标均只读安全」的 find 才算只读；gray/dangerous 不走快速通道
    const cls = classifyFindExecTargets(s)
    if (cls !== 'no-exec' && cls !== 'readonly') return false
  }
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
