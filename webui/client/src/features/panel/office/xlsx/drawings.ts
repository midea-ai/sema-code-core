/**
 * drawing 预处理，解决 ExcelJS 的两个缺口：
 * 1. 它完全不解析图表 —— 这里读出图表的锚点范围和图表定义（charts.ts），网格上用 echarts 画出来；解析不了的只画占位框。
 * 2. 它按字面量 `xdr:wsDr` 匹配 drawing 的根标签，而 openpyxl 等写的是不带前缀的默认命名空间（<wsDr xmlns=…>），
 *    解析结果为空，随后在 worksheet 里直接读 drawing.anchors 抛错，整个文件都打不开。
 *    这里把这类 drawing 在 zip 里替换成空壳再交给 ExcelJS，其中的图片改由本文件读出（按命名空间解析，有无前缀都能读）。
 */
import { loadZip } from '../loaders';
import { ChartSpec, parseChart } from './charts';
import { normalizeForExcelJS } from './normalize';
import type { Anchor, RawAnchor } from './model';

export type FloatAnchor = RawAnchor & { kind: Anchor['kind']; src?: string; chart?: ChartSpec };
export interface Drawings {
  /** 工作表名 → 浮动对象（图表占位，以及 ExcelJS 读不了的 drawing 里的图片） */
  floats: Record<string, FloatAnchor[]>;
  /** 归一化 / 替换过 drawing 后的字节；什么都不用改时为空，直接用原字节 */
  patched?: ArrayBuffer;
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMPTY_DRAWING = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>';
const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

/** 相对 rels 所属文件解析 Target（可能是 ../drawings/x.xml，也可能是 /xl/... 绝对形式） */
function resolveTarget(fromFile: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const relsOf = (file: string) => file.replace(/([^/]+)$/, '_rels/$1.rels');

export async function readDrawings(buf: ArrayBuffer): Promise<Drawings> {
  const out: Drawings = { floats: {} };
  const zip = await (await loadZip()).loadAsync(buf);
  const text = (p: string) => zip.file(p)?.async('string') ?? Promise.resolve(undefined);
  const xml = async (p: string) => {
    const s = await text(p);
    // 有的生成器在部件开头带 BOM（0xFEFF），DOMParser 不一定吃
    return s ? new DOMParser().parseFromString(s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s, 'application/xml') : null;
  };
  const rels = async (file: string) => {
    const doc = await xml(relsOf(file));
    return Array.from(doc?.getElementsByTagNameNS('*', 'Relationship') || []).map(r => ({ id: r.getAttribute('Id') || '', type: r.getAttribute('Type') || '', target: resolveTarget(file, r.getAttribute('Target') || '') }));
  };

  // 主命名空间带前缀、rels 用绝对路径等 ExcelJS 不认的写法先归一化（见 normalize.ts）
  const normalized = await normalizeForExcelJS(zip);

  // ExcelJS 读不了的 drawing：先替换，保证文件能打开（这一步不放进下面的 try，失败就该暴露出来）
  const broken = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/drawings\/[^/]+\.xml$/.test(name)) continue;
    if (!/<xdr:wsDr[\s>]/.test((await text(name)) || '')) broken.add(name);
  }

  // 图表占位 / 图片是锦上添花，任何一步失败都不能拖垮表格预览
  try {
    const wbFile = 'xl/workbook.xml';
    const wb = await xml(wbFile);
    const wbRels = wb ? await rels(wbFile) : [];
    for (const sheet of Array.from(wb?.getElementsByTagNameNS('*', 'sheet') || [])) {
      const rid = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');
      const sheetFile = wbRels.find(r => r.id === rid)?.target;
      if (!sheetFile) continue;
      const floats: FloatAnchor[] = [];
      for (const rel of (await rels(sheetFile)).filter(r => r.type.endsWith('/drawing'))) {
        const doc = await xml(rel.target);
        if (!doc) continue;
        const drawingRels = await rels(rel.target);
        for (const tag of ['twoCellAnchor', 'oneCellAnchor']) {
          for (const a of Array.from(doc.getElementsByTagNameNS('*', tag))) {
            const pos = (name: string) => {
              const el = a.getElementsByTagNameNS('*', name)[0];
              if (!el) return undefined;
              const n = (k: string) => Number(el.getElementsByTagNameNS('*', k)[0]?.textContent || 0);
              return { col: n('col'), colOff: n('colOff'), row: n('row'), rowOff: n('rowOff') };
            };
            const from = pos('from');
            if (!from) continue;
            const ext = a.getElementsByTagNameNS('*', 'ext')[0];
            const base: RawAnchor = { from, to: pos('to'), ext: ext ? { width: Number(ext.getAttribute('cx') || 0) / 9525, height: Number(ext.getAttribute('cy') || 0) / 9525 } : undefined };
            const chartEl = a.getElementsByTagNameNS('*', 'chart')[0];
            if (chartEl) {
              // 图表定义在独立的 chartN.xml 里；解析不了（不支持的类型等）就只留占位框
              const chartFile = drawingRels.find(r => r.id === (chartEl.getAttributeNS(REL_NS, 'id') || chartEl.getAttribute('r:id')))?.target;
              const chartXml = chartFile ? await text(chartFile) : undefined;
              let chart: ChartSpec | undefined;
              try { chart = (chartXml && parseChart(chartXml)) || undefined; } catch { /* 留占位框 */ }
              floats.push({ ...base, kind: 'chart', chart });
              continue;
            }
            // 图片：正常的 drawing 由 ExcelJS 负责，这里只接管被替换掉的那些
            const blip = broken.has(rel.target) ? a.getElementsByTagNameNS('*', 'blip')[0] : undefined;
            const media = blip && drawingRels.find(r => r.id === (blip.getAttributeNS(REL_NS, 'embed') || blip.getAttribute('r:embed')))?.target;
            const data = media ? await zip.file(media)?.async('base64') : undefined;
            if (data) floats.push({ ...base, kind: 'image', src: `data:${IMG_MIME[media!.split('.').pop()!.toLowerCase()] || 'image/png'};base64,${data}` });
          }
        }
      }
      if (floats.length) out.floats[sheet.getAttribute('name') || ''] = floats;
    }
  } catch { /* 静默 */ }

  if (broken.size || normalized) {
    for (const name of broken) zip.file(name, EMPTY_DRAWING);
    // 只是中转给 ExcelJS，不压缩，省时间
    out.patched = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  }
  return out;
}
