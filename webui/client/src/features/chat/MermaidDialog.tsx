/** mermaid 图表展开弹层：外壳走 ExpandDialog（顶部下载 / 关闭，底部按档位缩放），这里管图表的缩放与存成 PNG 图片 */
import { useLayoutEffect, useRef, useState } from 'react';
import { ExpandDialog } from './ExpandDialog';
import { t } from '../../i18n';

/** 缩放档位（百分比），100% 为图表原始尺寸 */
const ZOOMS = [25, 50, 75, 100, 125, 150, 200, 300, 400];
/** 图表四周留白（px），算「合适」缩放时要扣掉 */
const PAD = 24;

export function MermaidDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /** 图表原始尺寸与「合适」缩放（刚好放进可视区，小图不放大，最多 100%）；挂载后量出 */
  const [base, setBase] = useState<{ w: number; h: number; fit: number } | null>(null);
  const [zoom, setZoom] = useState(100);
  /** 缩放前可视区中心在内容里的相对位置，缩放后滚回去 */
  const center = useRef<{ x: number; y: number } | null>(null);

  // 量原始尺寸：mermaid 输出的 viewBox 宽高即 100% 时的像素尺寸；初始缩放取「合适」
  useLayoutEffect(() => {
    const sc = scroller.current;
    const el = box.current?.querySelector('svg');
    if (!sc || !el) return;
    const vb = el.viewBox?.baseVal;
    const rect = el.getBoundingClientRect();
    const w = vb?.width || rect.width;
    const h = vb?.height || rect.height;
    if (!(w > 0 && h > 0)) return;
    const fit = Math.floor(Math.min((sc.clientWidth - PAD * 2) / w, (sc.clientHeight - PAD * 2) / h) * 100);
    const clamped = Math.max(ZOOMS[0], Math.min(100, fit));
    setBase({ w, h, fit: clamped });
    setZoom(clamped);
  }, [svg]);

  // 缩放直接改 SVG 的宽高（矢量重排，放大不糊；布局尺寸随之变化，滚动区域天然正确）
  useLayoutEffect(() => {
    const sc = scroller.current;
    const el = box.current?.querySelector('svg');
    if (!sc || !el || !base) return;
    el.style.display = 'block';
    el.style.maxWidth = 'none';
    el.style.width = `${base.w * zoom / 100}px`;
    el.style.height = `${base.h * zoom / 100}px`;
    const c = center.current;
    if (c) {
      sc.scrollLeft = c.x * sc.scrollWidth - sc.clientWidth / 2;
      sc.scrollTop = c.y * sc.scrollHeight - sc.clientHeight / 2;
      center.current = null;
    }
  }, [base, zoom]);

  const zoomTo = (next: number) => {
    const sc = scroller.current;
    if (sc) center.current = { x: (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth, y: (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight };
    setZoom(next);
  };

  const download = () => {
    const el = box.current?.querySelector('svg');
    if (el && base) void saveDiagram(el, base.w, base.h);
  };

  return (
    <ExpandDialog onClose={onClose} onDownload={download} disabled={!base} zoom={zoom} zooms={ZOOMS} resetZoom={base?.fit ?? 100} resetTitle={t('file.zoomFit')} onZoom={zoomTo}>
      {/* 居中用子元素的 margin:auto 而不是 justify/align center：内容超出时后者会把左 / 上溢出的部分裁掉滚不到 */}
      <div ref={scroller} className="flex-1 min-h-0 flex overflow-auto">
        {/* 套 md 类：节点文字继承的行高、断词与正文里的图表保持一致 */}
        <div ref={box} className="md m-auto shrink-0" style={{ padding: PAD }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </ExpandDialog>
  );
}

/** 把图表存成 PNG：克隆 SVG、按原始尺寸的 2 倍写死宽高（超大图按最长边 8192 封顶），转成 data URL 画到 canvas 再导出。
 * 铺白底：图表文字是深色，透明底贴到深色背景上看不清。
 * 序列化走 XMLSerializer（节点里的 HTML 标签会补成合法 XML）；导出失败（如 canvas 被判为跨源污染）时退回保存 SVG 文件 */
async function saveDiagram(el: SVGSVGElement, w: number, h: number) {
  const scale = Math.min(2, 8192 / Math.max(w, h));
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.style.maxWidth = 'none';
  clone.style.width = '';
  clone.style.height = '';
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  const name = `diagram-${Date.now()}`;
  const save = (href: string, ext: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = `${name}.${ext}`;
    a.click();
  };
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('png export failed');
    const url = URL.createObjectURL(blob);
    save(url, 'png');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    save(svgUrl, 'svg');
  }
}
