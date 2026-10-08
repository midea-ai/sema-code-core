/** generate_image 工具的展示：过程里的工具行（GenImageCard）与结论下方的图片面板（GenImageGallery） */
import { useEffect, useState } from 'react';
import { Download, ImageOff, ImagePlus, PanelRight } from 'lucide-react';
import type { Block, ToolBlock } from '../../../../shared/types';
import type { BlockCtx } from './Blocks';
import { ImagePreview, ImageThumb, downloadImage } from './ImagePreview';
import { rawFileUrl } from './fileRefs';
import { Caret, cn, Spinner, Tip } from '../../common/ui';
import { useApp } from '../../store/app';
import { t } from '../../i18n';

export const GEN_IMAGE_TOOL = 'generate_image';

export interface GenImage { filePath: string; mediaType?: string; bytes?: number }

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/** 工具结果里的图片列表（content 形状异常时返回空） */
export function imagesOf(block: ToolBlock): GenImage[] {
  const list = block.content?.images;
  return Array.isArray(list) ? list.filter((x: any) => x && typeof x.filePath === 'string' && x.filePath) : [];
}

/** 走图片卡片的工具块：生成中，或已完成且拿得到图；失败或结果解析不出图的仍走普通工具行（能看到报错/原始内容）。
 * 不写成类型守卫：否定分支会把已收窄为 ToolBlock 的块收成 never */
export function isGenImageBlock(b: Block): boolean {
  if (b.kind !== 'tool' || b.toolName !== GEN_IMAGE_TOOL) return false;
  return b.status === 'running' || (b.status === 'done' && imagesOf(b).length > 0);
}

/** 收集块列表里全部已生成的图片（含子代理内的），按路径去重 */
export function genImagesIn(blocks: Block[]): GenImage[] {
  const out = new Map<string, GenImage>();
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.kind === 'agent') walk(b.blocks || []);
      else if (b.kind === 'tool' && b.toolName === GEN_IMAGE_TOOL && b.status === 'done') {
        for (const img of imagesOf(b)) if (!out.has(img.filePath)) out.set(img.filePath, img);
      }
    }
  };
  walk(blocks);
  return [...out.values()];
}

/**
 * 工具行：连续的生成调用合并为一行，展开显示缩略图（生成中的用同尺寸占位）。
 * live（本轮运行中）或在子代理详情页内默认展开；回合结束后展开过程时默认收起，图片看结论下方的图片区
 */
export function GenImageCard({ blocks, ctx, live, onOpenChange }: { blocks: ToolBlock[]; ctx: BlockCtx; live?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (!!live || !!ctx.noAutoOpenAgent);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const pending = blocks.filter(b => b.status === 'running');
  const images = blocks.flatMap(imagesOf);
  const running = pending.length > 0;
  // 单次调用时行内带提示词：生成中取标题（core 给的提示词摘要），完成后取结果里的完整提示词
  const prompt = blocks.length === 1 ? String(running ? blocks[0].title || '' : blocks[0].content?.prompt || '') : '';
  return (
    <div className="my-0.5 text-[13px] text-dim">
      <button onClick={() => setManual(!open)} className="max-w-full flex items-center gap-2 py-0.5 text-left cursor-pointer hover:text-fg">
        {running ? <Spinner className="h-3.5 w-3.5 shrink-0" /> : <ImagePlus size={14} className="shrink-0" />}
        <span className="shrink-0">{running ? t('tool.genImage.running') : images.length > 1 ? t('tool.genImage.doneN', { n: images.length }) : t('tool.genImage.done')}</span>
        {prompt && <span className="truncate">{prompt}</span>}
        <Caret open={open} />
      </button>
      {open && (
        <div className="pl-6 py-1 flex gap-2 flex-wrap">
          {images.map(img => (
            <ImageThumb key={img.filePath} src={rawFileUrl(ctx.sessionId, img.filePath)} className="h-20 w-20" label={baseName(img.filePath)} title={img.filePath} />
          ))}
          {pending.map(b => <div key={b.id} className="h-20 w-20 rounded-xl border border-border bg-panel animate-pulse" />)}
        </div>
      )}
    </div>
  );
}

/** 可能带透明通道的图片格式（jpeg 一定不透明，不必采样） */
const mayHaveAlpha = (img: GenImage) => img.mediaType ? img.mediaType === 'image/png' : /\.png$/i.test(img.filePath);

/** 图片是否含透明像素：同源图缩到小画布采样 alpha（画布读像素失败视为不透明） */
function hasAlpha(el: HTMLImageElement): boolean {
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) return false;
    g.drawImage(el, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
    return false;
  } catch { return false; }
}

/** 结论下方的图片面板：本轮生成的图全量展示（正文里的 ![]() 本地图由 Markdown 渲染成文件链接，不会重复出图）。
 * 左侧大图（点击放大，悬浮可在右栏打开 / 下载；透明背景的 png 悬浮时垫灰白方格），右侧一列缩略图切换；只有一张时不显示缩略图列 */
export function GenImageGallery({ sessionId, images }: { sessionId: string; images: GenImage[] }) {
  const openFileTab = useApp(s => s.openFileTab);
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [alpha, setAlpha] = useState<Record<string, boolean>>({});
  const shown = images;
  const idx = Math.min(sel, Math.max(shown.length - 1, 0));
  const cur = shown[idx] as GenImage | undefined;
  const src = cur ? rawFileUrl(sessionId, cur.filePath) : '';
  // 透明检测用单独的 Image 对象：切到缩略图列已加载过（缓存命中）的图时，新挂载的 <img> 可能在 React 挂上 onLoad 前就完成了，事件不会触发
  useEffect(() => {
    if (!cur || !mayHaveAlpha(cur) || alpha[cur.filePath] !== undefined) return;
    const path = cur.filePath;
    let live = true;
    const im = new Image();
    im.onload = () => { if (live) setAlpha(a => ({ ...a, [path]: hasAlpha(im) })); };
    im.src = src;
    return () => { live = false; };
  }, [src]);
  if (!cur) return null;
  const btn = 'h-7 w-7 rounded-md bg-black/30 hover:bg-black/50 text-white flex items-center justify-center';
  const multi = shown.length > 1;
  // 无底色无边框：大图限高（单张 320px；多张 400px，否则方图只有 320px 宽显得很小）、最宽撑满，按比例缩放
  // （用 max-h/max-w 而不是固定高度：页面变窄时固定高度的元素框会比缩小后的画面高，上下留白），靠左放，
  // 操作按钮与序号叠在图片本身上；缩略图列绝对定位贴在大图右侧，高度与大图一致、内部滚动（外层留出 pr 给它）
  return (
    <div className={cn('my-3 max-w-full flex items-start', multi && 'pr-[80px]')}>
      <div className="relative min-w-0 group/main">
        {failed[cur.filePath] ? (
          <div title={cur.filePath} className="py-2 text-muted flex flex-col items-start gap-1">
            <ImageOff size={20} />
            <span className="text-xs max-w-full truncate">{baseName(cur.filePath)}</span>
            <span className="text-xs opacity-70">{t('image.missing')}</span>
          </div>
        ) : (
          <img key={cur.filePath} src={src} alt="" title={cur.filePath}
            onClick={() => setPreview(true)} onError={() => setFailed(f => ({ ...f, [cur.filePath]: true }))}
            className={cn('max-h-80 max-w-full rounded-md cursor-zoom-in select-none', alpha[cur.filePath] && 'hover:bg-checker')} />
        )}
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/main:opacity-100 transition-opacity">
          <Tip content={t('md.openImage')}><button onClick={() => openFileTab(sessionId, cur.filePath)} className={btn}><PanelRight size={14} /></button></Tip>
          <Tip content={t('common.download')}><button onClick={() => downloadImage(src)} className={btn}><Download size={14} /></button></Tip>
        </div>
        {multi && (
          <span className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-black/30 text-white text-[11px] tabular-nums select-none opacity-0 group-hover/main:opacity-100 transition-opacity">{idx + 1} / {shown.length}</span>
        )}
        {multi && (
          <div className="absolute inset-y-0 left-full ml-2 w-[72px] overflow-y-auto flex flex-col gap-2">
            {shown.map((img, i) => (
              <button key={img.filePath} onClick={() => setSel(i)} title={img.filePath}
                className={cn('h-[72px] w-[72px] shrink-0 rounded-lg overflow-hidden border-2 bg-bg', i === idx ? 'border-accent' : 'border-transparent hover:border-border')}>
                {failed[img.filePath]
                  ? <div className="h-full w-full flex items-center justify-center text-muted"><ImageOff size={16} /></div>
                  : <img src={rawFileUrl(sessionId, img.filePath)} alt="" onError={() => setFailed(f => ({ ...f, [img.filePath]: true }))} className="h-full w-full object-cover" />}
              </button>
            ))}
          </div>
        )}
      </div>
      {preview && <ImagePreview src={src} onClose={() => setPreview(false)} />}
    </div>
  );
}
