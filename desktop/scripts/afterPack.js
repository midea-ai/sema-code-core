/**
 * electron-builder afterPack：macOS 无证书时做 ad-hoc 签名。
 * Apple Silicon 拒绝运行完全没有签名的二进制；ad-hoc 签名不需要证书，本机与拷贝分发都能启动，
 * 只是从网上下载后首次打开仍会被 Gatekeeper 拦（系统设置 → 隐私与安全性 → 仍要打开，或 xattr -cr）。
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc codesign ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
