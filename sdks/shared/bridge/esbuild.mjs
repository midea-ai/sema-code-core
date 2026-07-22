// 把 src/server.ts + sema-core 打成单个 dist/server.js（与 JetBrains 插件 sidecar 同款打包）。
// 目标：sidecar 产物自包含（server.js + sema.proto），不依赖 node_modules，只需一个 node 可执行文件。
import { build } from 'esbuild';
import { existsSync, copyFileSync } from 'fs';

const isWatch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  // rg 走系统 PATH 提供（SDK runtime 首启下载后前置进 PATH），sema-core 对 @vscode/ripgrep
  // 的回退 require 永不命中；external 掉它，避免把空的平台占位包打进来。
  // turndown 是 sema-core fetch_url 的懒加载可选依赖（未声明进 dependencies，仓库里无包可打），
  // 缺失时 require 抛错由 fetchUrlAsMarkdown 的 try/catch 降级，external 掉即可。
  external: ['@vscode/ripgrep', 'turndown'],
  logLevel: 'info',
  // sema-core 内部可能有对用户文件的动态 require（插件/MCP 运行时加载），保持为原生 require。
  // esbuild 对无法静态解析的 require 会保留并告警，cjs 下运行时即 node require，符合预期。
  logOverride: { 'unsupported-dynamic-import': 'silent' },
};

if (isWatch) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await build(options);
  if (!existsSync('dist/server.js')) {
    console.error('[esbuild] 构建失败：未产出 dist/server.js');
    process.exit(1);
  }
  // proto 唯一源随产物分发：server.ts 的 PROTO_PATH 会命中 server.js 同级的 sema.proto
  copyFileSync('../proto/sema.proto', 'dist/sema.proto');
  console.log('[esbuild] built dist/server.js (+ sema.proto)');
}
