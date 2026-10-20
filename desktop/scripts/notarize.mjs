/**
 * 独立公证：对 release/ 下已签名的 SemaWork.app 做 Apple 公证 → 钉票据（staple）→ 重新压 dmg。
 * 打包（npm run dist:mac*）只签名不公证，网络通畅时再跑本脚本：
 *   npm run notarize              # release 下有哪个架构就处理哪个
 *   npm run notarize -- arm64     # 只处理指定架构（arm64 / x64）
 * 需要环境变量 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID。
 * 上传走 AWS S3，国内直连常传不上去；连手机热点或系统代理（notarytool 不读 https_proxy 环境变量）再跑。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(DESKTOP_ROOT, 'release');
const APP_NAME = 'SemaWork.app';
// electron-builder 的产物目录：x64 是 mac，arm64 是 mac-arm64
const ARCH_DIRS = { arm64: 'mac-arm64', x64: 'mac' };

const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
  console.error('缺少环境变量：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID');
  process.exit(1);
}
const CRED = ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID];

const wanted = process.argv.slice(2);
const arches = (wanted.length ? wanted : Object.keys(ARCH_DIRS)).filter((arch) => {
  if (!ARCH_DIRS[arch]) throw new Error(`未知架构 ${arch}，可选 ${Object.keys(ARCH_DIRS).join(' / ')}`);
  const exists = fs.existsSync(path.join(RELEASE, ARCH_DIRS[arch], APP_NAME));
  if (!exists && wanted.length) throw new Error(`release/${ARCH_DIRS[arch]}/${APP_NAME} 不存在，先 npm run dist:mac`);
  return exists;
});
if (!arches.length) {
  console.error('release/ 下没有 SemaWork.app，先 npm run dist:mac');
  process.exit(1);
}

for (const arch of arches) {
  const app = path.join(RELEASE, ARCH_DIRS[arch], APP_NAME);
  const zip = path.join(RELEASE, `SemaWork-${arch}-notarize.zip`);
  console.log(`\n==== ${arch}: ${path.relative(DESKTOP_ROOT, app)}`);

  assertSigned(app);

  console.log('• 压缩');
  fs.rmSync(zip, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' });

  console.log('• 提交 Apple 公证（上传 + 等待结果，通常几分钟到十几分钟）');
  const result = submit(zip);
  fs.rmSync(zip, { force: true });
  if (result.status !== 'Accepted') {
    console.error(`公证未通过：status=${result.status} id=${result.id}`);
    if (result.id) {
      console.error('Apple 给出的原因：');
      spawnSync('xcrun', ['notarytool', 'log', result.id, ...CRED], { stdio: 'inherit' });
    }
    process.exit(1);
  }
  console.log(`• 公证通过 id=${result.id}`);

  console.log('• 钉票据（stapler）');
  execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' });
  execFileSync('spctl', ['-a', '-vv', '-t', 'exec', app], { stdio: 'inherit' });

  console.log('• 用钉好票据的 app 重新压 dmg');
  execFileSync(
    path.join(DESKTOP_ROOT, 'node_modules', '.bin', 'electron-builder'),
    ['--mac', 'dmg', `--${arch}`, '--prepackaged', path.dirname(app), '--publish', 'never'],
    { cwd: DESKTOP_ROOT, stdio: 'inherit' },
  );
}
console.log('\n全部完成，release/ 下的 dmg 已是公证版');

/** 必须是 Developer ID 正式签名且开了 hardened runtime，ad-hoc 签名的包 Apple 不收 */
function assertSigned(app) {
  const info = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr || '';
  if (!/Authority=Developer ID Application/.test(info) || !/flags=.*runtime/.test(info)) {
    throw new Error(`${app} 不是 Developer ID 正式签名（钥匙串里没证书时打包只做了 ad-hoc 签名），装好证书后重新 npm run dist:mac`);
  }
}

/** notarytool submit --wait：进度打到终端，最终 JSON 结果从 stdout 解析 */
function submit(zip) {
  const r = spawnSync('xcrun', ['notarytool', 'submit', zip, ...CRED, '--wait', '--timeout', '2h', '--output-format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const json = (r.stdout || '').trim().split('\n').reverse().find((line) => line.startsWith('{'));
  if (!json) throw new Error(`notarytool 没有返回结果（退出码 ${r.status}），多半是上传阶段网络不通，换网络后重试`);
  return JSON.parse(json);
}
