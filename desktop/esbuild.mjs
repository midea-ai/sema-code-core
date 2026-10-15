/**
 * 桌面版打包：主进程、preload、server 宿主子进程入口 server-host.js，以及直接从 webui/server 源码打出的 server.js / worker-entry.js，
 * 再把 webui/client 构建产物拷到 dist/public。产物自包含，运行时依赖全部来自 desktop/node_modules。
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromDesktop = createRequire(import.meta.url);
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
  packages: 'external', // electron / sema-core / node-pty / ws 等运行时从 node_modules 加载（worker-entry 例外，见下）
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' });
await build({ ...common, entryPoints: ['src/server-host.ts'], outfile: 'dist/server-host.js' });
await build({ ...common, entryPoints: [path.join(SERVER_SRC, 'server.ts')], outfile: 'dist/server.js' });
// worker-entry 把 sema-core 及其全部依赖打成单文件：冷启动从逐个读取上千个模块文件变成读一个文件
//（Windows 上 NTFS + 杀毒逐文件扫描是冷启动最大的一段；macOS 实测 spawn→ready 从 300～580ms 降到 140ms）。
// ripgrep 平台子包是二进制，仍留在 node_modules 由运行时 require.resolve 定位；electron 在 worker 里用不到，排除以防误打。
// sema-core 必须钉到 desktop/node_modules 里装的那份：入口源码在 webui/server 下，按源码位置解析会命中
// webui/node_modules/sema-core → 仓库根目录的软链，打进去的就成了根目录 dist/（可能过期或根本没构建）
const DESKTOP_NODE_MODULES = path.join(here, 'node_modules');
const pinSemaCore = {
  name: 'pin-sema-core-to-desktop',
  setup(b) {
    b.onResolve({ filter: /^sema-core(\/.*)?$/ }, (args) => {
      const resolved = requireFromDesktop.resolve(args.path);
      if (!resolved.startsWith(DESKTOP_NODE_MODULES + path.sep)) {
        throw new Error(`sema-core 解析到了 desktop/node_modules 之外：${resolved}，请在 desktop/ 执行 npm install`);
      }
      return { path: resolved };
    });
  },
};
const { packages: _external, ...bundled } = common;
await build({
  ...bundled,
  external: ['electron', '@vscode/ripgrep', '@vscode/ripgrep-*'],
  plugins: [pinSemaCore],
  entryPoints: [path.join(SERVER_SRC, 'workers', 'entry.ts')],
  outfile: 'dist/worker-entry.js',
});

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
