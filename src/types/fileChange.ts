/**
 * 文件变更（会话基线 diff）的对外数据结构。
 *
 * 基线 = 本会话首次受控写入该文件之前的原始内容，由写工具在写盘前经 recordPreEdit 捕获，
 * 查询实现见 CheckpointManager。聊天里的工具编辑块用的是工具结果自带的 patch，
 * 与本结构无关，也不随后续编辑变化。
 */

/** 行级 diff 的一个 hunk，与 npm diff 的 structuredPatch 输出同构 */
export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** 相对会话基线的文件状态；'unchanged' 与基线一致，'unknown' 无法判断（基线缺失或当前文件状态读不出来） */
export type FileChangeState = 'modified' | 'added' | 'deleted' | 'unchanged' | 'unknown'

/**
 * 能否做文本比较：
 * - ok                  可比较
 * - binary              二进制文件，只表达状态、不给增删行
 * - tooLarge            超出文本比较上限，只表达状态、不给增删行
 * - baselineUnavailable 基线缺失或读不出来（无记录 / 换密钥 / blob 损坏），不构造空文件 diff
 * - currentUnreadable   当前文件存在但读不出来（权限等），不等于文件被删除
 */
export type FileChangeStatus = 'ok' | 'binary' | 'tooLarge' | 'baselineUnavailable' | 'currentUnreadable'

/** 文件变更面板条目：本会话受控写入过的文件，按绝对路径去重 */
export interface FileChangeItem {
  /** 绝对路径 */
  filePath: string
  /** 展示路径：项目内相对、项目外绝对（与工具事件 title 同口径） */
  displayPath: string
  state: FileChangeState
  status: FileChangeStatus
  /** 基线侧文件是否存在（新建文件为 false，与原本就存在的空文件区分） */
  baselineExists: boolean
  /** status === 'ok' 时的净增行数 */
  additions?: number
  /** status === 'ok' 时的净删行数 */
  removals?: number
  /** status === 'ok' 时的首个变更行（新文件侧 1-based），仅用于滚动定位 */
  line?: number
  /** 文本增删为零但原始字节变了（编码 / BOM / 换行形式变化） */
  rawChanged?: boolean
}

/** diff 页面数据：会话基线 → 查询时磁盘内容 */
export interface FileDiffResult extends FileChangeItem {
  currentExists: boolean
  /** status === 'ok' 时的左右文本，IDE 宿主用它们打开原生 diff */
  baselineText?: string
  currentText?: string
  /** status === 'ok' 时的 hunk，WebUI 用它渲染彩色代码 */
  hunks?: Hunk[]
}

/** 「放弃修改」单文件结果 */
export interface RevertFileResult {
  filePath: string
  displayPath: string
  /** restored 写回基线内容；deleted 删除基线不存在的文件；failed 失败，其余文件继续处理 */
  action: 'restored' | 'deleted' | 'failed'
  error?: string
}
