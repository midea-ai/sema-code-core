import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * ripgrep 兜底供应（跨语言共享的唯一实现——桥运行时 node 已就绪，rg 供应放这里
 * 即可让 Java / Python / C# SDK 零代码共享；node 本身的供应因引导悖论仍归各语言 runtime）。
 *
 * 统一分发范式：本地优先（PATH 里探到能跑的 rg 就用）→ ~/.sema 私有缓存命中 → 按需下载。
 * 全程只写 ~/.sema 缓存、只前置进本进程 PATH（sema-core spawn rg 时按 PATH 查找），
 * 不修改系统环境。rg 缺失只影响搜索性能，失败时告警后继续。
 */

const RG_VERSION = '14.1.0';
const DEFAULT_BASE = 'https://github.com/BurntSushi/ripgrep/releases/download';
const IS_WINDOWS = process.platform === 'win32';
const RG_NAME = IS_WINDOWS ? 'rg.exe' : 'rg';

/** ripgrep Release 资产：triple 对应文件名，zip=true 为 .zip（win），否则 .tar.gz。 */
function assetFor(): { triple: string; zip: boolean } | null {
  const arch = process.arch;
  switch (process.platform) {
    case 'darwin':
      if (arch === 'arm64') return { triple: 'aarch64-apple-darwin', zip: false };
      if (arch === 'x64') return { triple: 'x86_64-apple-darwin', zip: false };
      return null;
    case 'win32':
      // win arm64 走 x64 仿真
      if (arch === 'x64' || arch === 'arm64') return { triple: 'x86_64-pc-windows-msvc', zip: true };
      return null;
    case 'linux':
      if (arch === 'arm64') return { triple: 'aarch64-unknown-linux-gnu', zip: false };
      if (arch === 'x64') return { triple: 'x86_64-unknown-linux-musl', zip: false };
      return null;
    default:
      return null;
  }
}

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 在本进程 PATH 里查找 rg。 */
function whichRg(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, RG_NAME);
    if (canExecute(f)) return f;
  }
  return null;
}

/** rg 所在目录前置进本进程 PATH（sema-core spawn rg 时继承）。 */
function prependPath(dir: string): void {
  process.env.PATH = [dir, process.env.PATH ?? ''].join(path.delimiter);
}

/** 手动跟随重定向下载（github → CDN 302，http(s).get 不自动跟随）。 */
function httpDownload(urlStr: string, dest: string, redirects = 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('http://') ? http : https;
    const req = mod.get(urlStr, { headers: { 'User-Agent': 'sema-bridge' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('重定向过多'));
        return resolve(httpDownload(res.headers.location, dest, redirects - 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code}: ${urlStr}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('下载超时')));
  });
}

/** 解压 .tar.gz / .zip：优先系统 tar（mac/linux 自带，Win10+ 的 bsdtar 也认 zip），win 兜底 PowerShell。 */
function extract(archive: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = spawnSync('tar', ['xf', archive, '-C', destDir], { timeout: 180000 });
  if (tar.status === 0) return;
  if (IS_WINDOWS && archive.endsWith('.zip')) {
    const ps = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`],
      { timeout: 180000 },
    );
    if (ps.status === 0) return;
  }
  throw new Error(`解压失败: ${archive}`);
}

/** macOS 去隔离，避免 Gatekeeper 拦下载来的二进制（只对我们下载的那份做）。 */
function dequarantine(file: string): void {
  if (process.platform !== 'darwin') return;
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', file], { timeout: 10000 });
}

/** 递归查找目录下名为 name 的文件。 */
function findFile(root: string, name: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

async function download(cacheDir: string): Promise<string> {
  const asset = assetFor();
  if (!asset) throw new Error(`不支持的平台: ${process.platform}/${process.arch}`);
  const base = (process.env.SEMA_RG_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
  const fileName = `ripgrep-${RG_VERSION}-${asset.triple}.${asset.zip ? 'zip' : 'tar.gz'}`;
  const url = `${base}/${RG_VERSION}/${fileName}`;
  console.log(`[sema-grpc] 首启下载 ripgrep: ${url}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-rg-'));
  try {
    const archive = path.join(tmp, fileName);
    await httpDownload(url, archive);
    const extractDir = path.join(tmp, 'x');
    extract(archive, extractDir);
    const rg = findFile(extractDir, RG_NAME);
    if (!rg) throw new Error(`解压后未找到 ${RG_NAME}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, RG_NAME);
    fs.copyFileSync(rg, dest);
    if (!IS_WINDOWS) {
      fs.chmodSync(dest, 0o755);
      dequarantine(dest);
    }
    console.log(`[sema-grpc] ripgrep 就绪: ${dest}`);
    return cacheDir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 确保 rg 可用并（必要时）前置进本进程 PATH。
 * 优先级：SEMA_RG_PATH 显式 → PATH 里的本地 rg → ~/.sema/rg/<ver>/<triple> 缓存 → 下载。
 * 失败时告警后继续（rg 缺失只影响搜索性能，不阻塞启动）。
 */
export async function ensureRg(): Promise<void> {
  // 1) 显式指定（内网/离线）
  const override = process.env.SEMA_RG_PATH;
  if (override) {
    const dir = fs.existsSync(override) && fs.statSync(override).isDirectory()
      ? override
      : path.dirname(override);
    if (fs.existsSync(path.join(dir, RG_NAME))) {
      prependPath(dir);
      return;
    }
    console.warn(`[sema-grpc] SEMA_RG_PATH 指定但未找到 ${RG_NAME}: ${override}`);
  }

  // 2) 本地优先：PATH（SDK 已把登录 shell 真实 PATH 注入本进程）里探到就直接用
  const local = whichRg();
  if (local) {
    console.log(`[sema-grpc] 复用系统 ripgrep: ${local}`);
    return;
  }

  // 3) 缓存命中
  const asset = assetFor();
  if (!asset) {
    console.warn(`[sema-grpc] 不支持的平台，无法准备 ripgrep: ${process.platform}/${process.arch}`);
    return;
  }
  const cacheDir = path.join(os.homedir(), '.sema', 'rg', RG_VERSION, asset.triple);
  if (canExecute(path.join(cacheDir, RG_NAME))) {
    prependPath(cacheDir);
    return;
  }

  // 4) 按需下载
  try {
    prependPath(await download(cacheDir));
  } catch (e: any) {
    fs.rmSync(cacheDir, { recursive: true, force: true }); // 半成品清掉，避免下次误命中
    console.warn(`[sema-grpc] ripgrep 准备失败（仅影响搜索性能，继续启动）: ${e?.message ?? e}`);
  }
}
