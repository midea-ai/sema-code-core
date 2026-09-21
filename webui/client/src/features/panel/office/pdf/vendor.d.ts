/** pdf.js 静态资源（cmaps / standard_fonts / wasm）的 URL 前缀，由 vite.config.ts 的 pdfjsAssets 插件注入 */
declare const __PDFJS_ASSETS__: string;

/** worker 走 Vite 的 ?url 导入（项目没引 vite/client 类型） */
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
