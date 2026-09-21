import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER = process.env.SEMA_WEBUI_SERVER || 'http://127.0.0.1:3210';

/**
 * pdf.js 运行时按需请求的静态资源（CJK 字符映射、标准字体、JPEG2000 / JBIG2 解码器）：dev 时直接从包里读，build 时拷进 dist。
 * 路径带版本号：server 对静态资源发的是 immutable 长缓存，这些文件名又不带 hash，升级 pdfjs-dist 后靠路径变化失效。
 */
function pdfjsAssets(): Plugin {
  const pkgJson = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
  const root = path.dirname(pkgJson);
  const base = `/pdfjs-${JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version}/`;
  const DIRS = ['cmaps', 'standard_fonts', 'wasm'];
  let outDir = '';
  return {
    name: 'pdfjs-assets',
    config: () => ({ define: { __PDFJS_ASSETS__: JSON.stringify(base) } }),
    configResolved(c) { if (c.command === 'build') outDir = path.resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith(base)) return next();
        const rel = decodeURIComponent(url.slice(base.length));
        const file = path.join(root, rel);
        if (!DIRS.includes(rel.split('/')[0]) || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!outDir || !fs.existsSync(outDir)) return;
      for (const d of DIRS) fs.cpSync(path.join(root, d), path.join(outDir, base, d), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  server: {
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
