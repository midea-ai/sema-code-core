import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
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
