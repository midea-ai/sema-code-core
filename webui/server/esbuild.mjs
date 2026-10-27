import { build, context } from 'esbuild';
import { createRequire } from 'module';

const watch = process.argv.includes('--watch');
// 版本号构建时注入：服务端用它判断"升级后首次启动"，同步内置技能与浏览器控制资源到用户级（desktop/esbuild.mjs 同样注入）
const { version } = createRequire(import.meta.url)('./package.json');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  define: { __WEBUI_VERSION__: JSON.stringify(version) },
};
const entries = [
  { entryPoints: ['src/index.ts'], outfile: 'dist/index.js' },          // 命令行入口（npm start）
  { entryPoints: ['src/server.ts'], outfile: 'dist/server.js' },        // 库入口（desktop/ Electron 主进程 require）
  { entryPoints: ['src/workers/entry.ts'], outfile: 'dist/worker-entry.js' },
];

if (watch) {
  for (const e of entries) (await context({ ...common, ...e })).watch();
} else {
  for (const e of entries) await build({ ...common, ...e });
}
