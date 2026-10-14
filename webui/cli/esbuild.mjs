/**
 * sema-code-ui 打包：从 webui/server 源码直接打出 dist/cli.js（命令行入口，含服务端）与 dist/worker-entry.js，
 * 再把 webui/client 构建产物拷到 dist/public、内置资源拷到 dist/resources。
 * 与 desktop/esbuild.mjs 同一思路；运行时依赖（sema-core / node-pty / ws 等）来自本包 node_modules。
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.join(here, '..', 'server', 'src');
const CLIENT_DIST = path.join(here, '..', 'client', 'dist');

if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  console.error(`未找到 ${CLIENT_DIST}，请先在 webui/ 执行 npm run build`);
  process.exit(1);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
};

fs.rmSync(path.join(here, 'dist'), { recursive: true, force: true });
await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' });
await build({ ...common, entryPoints: [path.join(SERVER_SRC, 'workers', 'entry.ts')], outfile: 'dist/worker-entry.js' });

// server 会在 __dirname/public 找页面
fs.cpSync(CLIENT_DIST, path.join(here, 'dist', 'public'), { recursive: true });
console.log('  dist/public  ← webui/client/dist');

// server 会在 __dirname/resources 找生态市场内置资源，在 __dirname/resources/chrome 找浏览器控制的 skill 与 .mcp.json
const RESOURCES_SRC = path.join(here, '..', 'resources');
const RESOURCES_DIST = path.join(here, 'dist', 'resources');
// resources/cache 是本机生态市场的下载缓存（gitignore），不进包
fs.cpSync(RESOURCES_SRC, RESOURCES_DIST, { recursive: true, filter: (src) => src !== path.join(RESOURCES_SRC, 'cache') });
fs.cpSync(path.join(here, '..', '..', 'chrome', '.sema'), path.join(RESOURCES_DIST, 'chrome'), { recursive: true });
console.log('  dist/resources        ← webui/resources');
console.log('  dist/resources/chrome ← chrome/.sema');
