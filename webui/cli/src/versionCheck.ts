/**
 * sema-ui 启动时的版本检查：向 npm registry 查 sema-code-ui 的最新版本，
 * 比当前新则在启动输出开头提示升级与启动命令。
 * 与启动流程并行发起，网络失败 / 超时（1.5 秒）静默忽略，不阻塞也不影响启动；
 * 环境变量 SEMA_UI_NO_UPDATE_CHECK=1 可关闭（CI、离线环境）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const PKG = 'sema-code-ui';
const TIMEOUT_MS = 1500;

/** registry 优先级：npm 环境变量 > ~/.npmrc 的 registry（镜像源）> 官方源 */
function registryBase(): string {
  const fromEnv = process.env.npm_config_registry;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    const rc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = rc.match(/^\s*registry\s*=\s*(\S+)/m);
    if (m) return m[1].replace(/\/+$/, '');
  } catch { /* 没有 ~/.npmrc */ }
  return 'https://registry.npmjs.org';
}

/** 只比 x.y.z 数字段；latest 是 dist-tag，正常就是可直接安装的版本 */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** 返回比当前新的最新版本号；已是最新、查不到或超时返回 null */
export async function checkLatestVersion(current: string): Promise<string | null> {
  if (process.env.SEMA_UI_NO_UPDATE_CHECK === '1') return null;
  try {
    const res = await fetch(`${registryBase()}/${PKG}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json() as { version?: unknown };
    const latest = typeof body?.version === 'string' ? body.version : null;
    return latest && isNewer(latest, current) ? latest : null;
  } catch {
    return null;
  }
}
