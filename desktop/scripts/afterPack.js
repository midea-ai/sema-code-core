/**
 * electron-builder afterPack：
 * 1. 放入目标平台的 ripgrep 二进制。@vscode/ripgrep 1.18+ 把二进制拆进 @vscode/ripgrep-<平台>-<架构> 子包，
 *    npm 只装打包机自己平台那份，交叉打包（macOS 上打 win / mac-x64）出来的包里是错平台的 rg；
 *    而 sema-core 与 webui/server 找内置 rg 的位置是 @vscode/ripgrep/bin/rg(.exe)。
 *    这里按目标平台取对应子包，把二进制放到该位置，并删掉产物里的平台子包。
 * 2. macOS 无证书时做 ad-hoc 签名。
 *    Apple Silicon 拒绝运行完全没有签名的二进制；ad-hoc 签名不需要证书，本机与拷贝分发都能启动，
 *    只是从网上下载后首次打开仍会被 Gatekeeper 拦（系统设置 → 隐私与安全性 → 仍要打开，或 xattr -cr）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Arch } = require('electron-builder');

const DESKTOP_ROOT = path.join(__dirname, '..');
const RG_CACHE = path.join(DESKTOP_ROOT, 'node_modules', '.cache', 'semawork-ripgrep');

/** 取目标平台的 rg 二进制路径：本机已装的子包直接用，否则 npm pack 拉取并缓存 */
function resolveRgBinary(platform, arch) {
  const pkg = `@vscode/ripgrep-${platform}-${arch}`;
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';

  const installed = path.join(DESKTOP_ROOT, 'node_modules', pkg, 'bin', exe);
  if (fs.existsSync(installed)) return installed;

  const mainPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'node_modules', '@vscode', 'ripgrep', 'package.json'), 'utf8'));
  const version = (mainPkg.optionalDependencies || {})[pkg] || '1.18.0';
  const dir = path.join(RG_CACHE, `${platform}-${arch}-${version}`);
  const cached = path.join(dir, 'package', 'bin', exe);
  if (fs.existsSync(cached)) return cached;

  console.log(`  • 拉取 ${pkg}@${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Windows 上 npm 是 npm.cmd，需要经 shell 才能执行
  execFileSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', dir], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack ${pkg}@${version} 未产出 tgz`);
  execFileSync('tar', ['-xzf', tgz], { cwd: dir, stdio: 'inherit' });
  if (!fs.existsSync(cached)) throw new Error(`${pkg}@${version} 中未找到 bin/${exe}`);
  return cached;
}

function installRipgrep(context, appDir) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const scopeDir = path.join(appDir, 'node_modules', '@vscode');

  const src = resolveRgBinary(platform, arch);
  const dest = path.join(scopeDir, 'ripgrep', 'bin', exe);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);

  for (const name of fs.readdirSync(scopeDir)) {
    if (name.startsWith('ripgrep-')) fs.rmSync(path.join(scopeDir, name), { recursive: true, force: true });
  }
  console.log(`  • ripgrep ${platform}-${arch} → ${dest}`);
}

exports.default = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin';
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const appDir = isMac ? path.join(app, 'Contents', 'Resources', 'app') : path.join(context.appOutDir, 'resources', 'app');

  installRipgrep(context, appDir);

  if (!isMac) return;
  console.log(`  • ad-hoc codesign ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
