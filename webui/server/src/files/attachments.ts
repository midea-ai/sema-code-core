/**
 * 超长粘贴转存的附件文件：<semaRoot>/attachments/<uuid>/pasted-text.txt。
 * 写入 / 删除；与会话无关（新会话草稿没有 sessionId 也能落盘），不走 worker。
 * 退场由 core 负责：发送后登记到会话名下随会话删除，没发送的由 core 的期限兜底回收，这里不做清理
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getSemaRootDir } from '../semaRoot';

const FILE_NAME = 'pasted-text.txt';
const UUID_RE = /^[0-9a-f-]{36}$/i;

function attachmentsRoot(): string {
  return path.join(getSemaRootDir(), 'attachments');
}

/** 落盘一段粘贴文本，返回绝对路径 */
export function savePastedText(text: string): { path: string } {
  if (!text) throw new Error('缺少 text');
  const dir = path.join(attachmentsRoot(), randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE_NAME);
  fs.writeFileSync(file, text, 'utf8');
  return { path: file };
}

/** 删除整个 uuid 目录：只接受本模块写出的形状 <root>/<uuid>/pasted-text.txt，其余拒绝 */
export function removePastedText(p: string): void {
  const root = attachmentsRoot();
  const rel = path.relative(root, path.resolve(p));
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || parts[1] !== FILE_NAME) throw new Error('路径不合法');
  fs.rmSync(path.join(root, parts[0]), { recursive: true, force: true });
}
