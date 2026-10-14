/**
 * 命令行入口共用的小工具：参数解析与持久化 token。
 * 使用方：index.ts（npm start）与 webui/cli（sema-code-ui 包）。
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { WEBUI_HOME } from './registry/registry';

/** 读 --name 形式的参数：有值取值，裸开关返回 'true'，缺省返回 def */
export function arg(name: string, def?: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
  return def;
}

/** 持久化 token：随机 token 每次启动都变会让已打开页面的重连永远被拒，这里落盘复用 */
export function loadOrCreateToken(): string {
  const file = path.join(WEBUI_HOME, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* 不存在或不可读则重新生成 */ }
  const t = randomBytes(16).toString('hex');
  try { fs.mkdirSync(WEBUI_HOME, { recursive: true }); fs.writeFileSync(file, t, { mode: 0o600 }); } catch (e: any) { console.warn('[token] 持久化失败，本次使用临时 token:', e?.message); }
  return t;
}
