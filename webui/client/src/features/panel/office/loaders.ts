/** Office 解析库按需加载单例：首次预览才拉包，避免拖慢首屏（同 Markdown.tsx 的 loadMermaid） */
let docxLib: Promise<typeof import('docx-preview')> | null = null;
export function loadDocx() {
  if (!docxLib) docxLib = import('docx-preview');
  return docxLib;
}

export interface ExcelLibs { ExcelJS: typeof import('exceljs'); numfmt: typeof import('numfmt') }
let excelLibs: Promise<ExcelLibs> | null = null;
/** exceljs 走 package.json 的 browser 字段（UMD 包），default 互操作两种形态都兼容；numfmt 一起拉 */
export function loadExcel() {
  if (!excelLibs) {
    excelLibs = Promise.all([import('exceljs'), import('numfmt')])
      .then(([e, n]) => ({ ExcelJS: ((e as any).default ?? e) as typeof import('exceljs'), numfmt: n }));
  }
  return excelLibs;
}

let pptxLib: Promise<typeof import('pptx-preview')> | null = null;
export function loadPptx() {
  if (!pptxLib) pptxLib = import('pptx-preview');
  return pptxLib;
}

/**
 * legacy 构建：自带 polyfill，标准构建用了 Map.getOrInsert / Math.sumPrecise 等很新的特性，旧一点的浏览器直接报错。
 * worker 单独成文件，地址要在首次 getDocument 之前设好。
 */
let pdfLib: Promise<typeof import('pdfjs-dist')> | null = null;
export function loadPdf() {
  if (!pdfLib) {
    pdfLib = Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
      .then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib; });
  }
  return pdfLib;
}

/** 公式重算用：只有遇到缺缓存值的公式才拉。fast-formula-parser 是 CJS 包，default 互操作两种形态都兼容 */
let formulaLibs: Promise<{ Parser: typeof import('fast-formula-parser').default; formulajs: Record<string, unknown> }> | null = null;
export function loadFormula() {
  if (!formulaLibs) {
    formulaLibs = Promise.all([import('fast-formula-parser'), import('@formulajs/formulajs')])
      .then(([p, f]) => ({ Parser: ((p as any).default ?? p) as typeof import('fast-formula-parser').default, formulajs: f as unknown as Record<string, unknown> }));
  }
  return formulaLibs;
}

/** xlsx 内嵌图表用；pptx-preview 也是整包引 echarts，两边共用同一个 chunk */
let echartsLib: Promise<typeof import('echarts')> | null = null;
export function loadECharts() {
  if (!echartsLib) echartsLib = import('echarts');
  return echartsLib;
}

let zipLib: Promise<typeof import('jszip')> | null = null;
export function loadZip() {
  if (!zipLib) zipLib = import('jszip').then(m => ((m as any).default ?? m) as typeof import('jszip'));
  return zipLib;
}
