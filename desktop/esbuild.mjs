/**
 * 桌面版打包：主进程、preload，以及直接从 webui/server 源码打出的 server.js / worker-entry.js，
 * 再把 webui/client 构建产物拷到 dist/public。产物自包含，运行时依赖全部来自 desktop/node_modules。
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.join(here, '..', 'webui', 'server', 'src');
const CLIENT_DIST = path.join(here, '..', 'webui', 'client', 'dist');

if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  console.error(`未找到 ${CLIENT_DIST}，请先在 webui/ 执行 npm run build`);
  process.exit(1);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external', // electron / sema-core / node-pty / ws 等运行时从 node_modules 加载
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' });
await build({ ...common, entryPoints: [path.join(SERVER_SRC, 'server.ts')], outfile: 'dist/server.js' });
await build({ ...common, entryPoints: [path.join(SERVER_SRC, 'workers', 'entry.ts')], outfile: 'dist/worker-entry.js' });

// server 会在 __dirname/public 找页面
fs.rmSync(path.join(here, 'dist', 'public'), { recursive: true, force: true });
fs.cpSync(CLIENT_DIST, path.join(here, 'dist', 'public'), { recursive: true });
console.log('  dist/public  ← webui/client/dist');

// server 会在 __dirname/resources 找生态市场内置资源，在 __dirname/resources/chrome 找浏览器控制的 skill 与 .mcp.json
const RESOURCES_DIST = path.join(here, 'dist', 'resources');
fs.rmSync(RESOURCES_DIST, { recursive: true, force: true });
fs.cpSync(path.join(here, '..', 'webui', 'resources'), RESOURCES_DIST, { recursive: true });
fs.cpSync(path.join(here, '..', 'chrome', '.sema'), path.join(RESOURCES_DIST, 'chrome'), { recursive: true });
console.log('  dist/resources        ← webui/resources');
console.log('  dist/resources/chrome ← chrome/.sema');
