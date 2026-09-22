/**
 * 超长粘贴转附件：发给模型的 input 模板拼装与解析。
 * client 发送时拼装、transcript reducer（服务端落盘 / 前端实时）解析出粘贴芯片，两端共用同一份规则保证格式一致。
 * 路径以 `@` 引用，由 core 现有的文件引用机制直接注入内容。
 */
import type { PasteAttachment } from './types';

export const PASTE_HEADER = '# Files pasted by the user:';
export const PASTE_REQUEST = '## My request:';

/** 一行一段粘贴：`## "<预览>": @<绝对路径>`；路径不含空格与标点，裸写不加引号 */
export function buildPasteInput(pastes: PasteAttachment[], text: string): string {
  const lines = [PASTE_HEADER, ''];
  for (const p of pastes) lines.push(`## "${p.preview}": @${p.path}`, '');
  lines.push(PASTE_REQUEST, text);
  return lines.join('\n');
}

/** 只认 attachments/<uuid>/pasted-text.txt 形状的路径（兼容 Windows 反斜杠），其余行忽略 */
const PASTE_LINE_RE = /^## "(.*)": @(\S+[\\/]attachments[\\/][^\\/\s]+[\\/]pasted-text\.txt)$/;

/** 从 input 解析粘贴列表：不是模板格式（无头行或无 `## My request:`）返回 undefined */
export function parsePasteInput(input: string): PasteAttachment[] | undefined {
  if (!input.startsWith(PASTE_HEADER)) return undefined;
  const lines = input.split('\n');
  const end = lines.indexOf(PASTE_REQUEST);
  if (end < 0) return undefined;
  const out: PasteAttachment[] = [];
  for (const line of lines.slice(1, end)) {
    const m = line.match(PASTE_LINE_RE);
    if (m) out.push({ preview: m[1], path: m[2] });
  }
  return out.length ? out : undefined;
}
