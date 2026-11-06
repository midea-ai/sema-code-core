/** 展开弹层外壳（mermaid 图表 / 可视化内嵌共用）：遮罩上一个占满窗口的面板（四周留白），顶部下载 / 关闭，底部按档位缩小 / 放大，
 * 中间内容区由调用方提供。面板大小不随缩放变化，缩放按钮不会在点击时跑位；点遮罩或 Esc 关闭 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, Minus, Plus, X } from 'lucide-react';
import { Button, Spinner } from '../../common/ui';
import { t } from '../../i18n';

export function ExpandDialog({ onClose, onDownload, downloading, disabled, zoom, zooms, resetZoom, resetTitle, onZoom, children }: {
  onClose: () => void;
  onDownload: () => void;
  /** 下载进行中：按钮转圈并禁点 */
  downloading?: boolean;
  /** 内容未就绪：下载与缩放禁用 */
  disabled?: boolean;
  /** 当前缩放（百分比）；不一定落在档位上，缩小 / 放大各取离它最近的下一档 */
  zoom: number;
  zooms: number[];
  /** 点百分比回到的缩放值 */
  resetZoom: number;
  resetTitle?: string;
  onZoom: (zoom: number) => void;
  /** 内容区：调用方自己给出占满剩余高度的滚动容器（flex-1 min-h-0 overflow-auto） */
  children: ReactNode;
}) {
  useEffect(() => {
    // 捕获阶段拦截 Esc：避免同时触发输入框的中断逻辑（与图片预览一致）
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const smaller = zooms.filter(z => z < zoom).pop();
  const larger = zooms.find(z => z > zoom);

  // portal 里的点击仍会沿 React 树冒泡到正文外层的容器，在遮罩层截住，避免误触外层的点击处理
  return createPortal(
    <div className="fixed inset-0 z-[1100] bg-black/30 flex items-center justify-center p-6" onMouseDown={onClose} onClick={e => e.stopPropagation()}>
      <div className="flex flex-col w-full h-full bg-bg border border-border rounded-xl shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1 px-3 pt-2.5 pb-1">
          <Button variant="ghost" size="icon" title={t('common.download')} disabled={disabled || downloading} onClick={onDownload}>
            {downloading ? <Spinner /> : <Download size={15} />}
          </Button>
          <Button variant="ghost" size="icon" title={t('common.close')} onClick={onClose}><X size={16} /></Button>
        </div>
        {children}
        <div className="flex items-center justify-center gap-1 px-3 pt-1 pb-2.5">
          <Button variant="ghost" size="icon" aria-label="Zoom out" disabled={disabled || smaller == null} onClick={() => smaller != null && onZoom(smaller)}><Minus size={15} /></Button>
          <button type="button" title={resetTitle} disabled={disabled} onClick={() => onZoom(resetZoom)}
            className="h-7 min-w-[52px] px-1.5 rounded-md text-xs tabular-nums text-muted hover:text-fg hover:bg-black/[0.05] transition-colors">
            {zoom}%
          </button>
          <Button variant="ghost" size="icon" aria-label="Zoom in" disabled={disabled || larger == null} onClick={() => larger != null && onZoom(larger)}><Plus size={15} /></Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
