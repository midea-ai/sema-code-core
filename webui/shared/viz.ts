/**
 * 可视化产物识别：visualize 技能把 html 写到 <semaRoot>/attachments/<uuid>/<title>.html。
 * client 据此把这类 html 从「网站卡片」分流成聊天内联嵌入；server 本地代理据此注入 viz-runtime 脚本。
 * 只看路径形状（attachments/<uuid>/*.html，兼容 Windows 反斜杠），不依赖 semaRoot 具体位置。
 */
export const VIZ_PATH_RE = /[\\/]attachments[\\/][0-9a-f-]{36}[\\/][^\\/]+\.html?$/i;

export function isVizPath(p: string): boolean { return VIZ_PATH_RE.test(p); }

/** attachments/<uuid>/ 下的任何文件（粘贴转存、可视化产物）：宿主自己的落盘目录，不在「已编辑文件」卡片与审阅面板里展示 */
export const ATTACHMENT_PATH_RE = /[\\/]attachments[\\/][0-9a-f-]{36}[\\/]/i;

export function isAttachmentPath(p: string): boolean { return ATTACHMENT_PATH_RE.test(p); }

/** iframe 内 runtime 与宿主的 postMessage 协议：统一 type 字段，kind 区分消息 */
export const VIZ_MSG_TYPE = 'sema-viz';

export type VizMessage =
  /** iframe → 宿主：文档高度与标题（加载后、尺寸变化时上报） */
  | { type: typeof VIZ_MSG_TYPE; kind: 'size'; height: number; title: string }
  /** 宿主 → iframe：请求整页截图 */
  | { type: typeof VIZ_MSG_TYPE; kind: 'snapshot'; id: number }
  /** iframe → 宿主：截图结果（png Blob；失败时 blob 为空并带 error） */
  | { type: typeof VIZ_MSG_TYPE; kind: 'snapshot'; id: number; blob?: Blob; error?: string };
