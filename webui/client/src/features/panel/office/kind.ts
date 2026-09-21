/** Office 预览类型判定：文件标签与对话卡片共用。pdf 不是 Office 格式，但预览管线（取字节 → 渲染 → 缩放 / 下载）完全一样，归在一起 */
export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'csv' | 'pdf';

export const OFFICE_RE = /\.(docx|xlsx|pptx|csv|tsv|pdf)$/i;

/** 按扩展名判定（tsv 归入 csv，共用表格网格）；不做 doc/xls/ppt 旧格式 */
export function officeKindOf(p: string): OfficeKind | null {
  const m = p.match(OFFICE_RE);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === 'tsv' ? 'csv' : ext as OfficeKind;
}

/** 二进制四类：没有源码可看，强制预览 */
export function isOfficeBinary(k: string | null): boolean { return k === 'docx' || k === 'xlsx' || k === 'pptx' || k === 'pdf'; }

/** 去掉目录与扩展名的文件名（预览头部、卡片标题用） */
export function baseNameNoExt(p: string): string {
  const name = p.split(/[\\/]/).pop() || p;
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
