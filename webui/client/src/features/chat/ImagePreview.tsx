/** 图片放大预览遮罩：右上角尺寸 / 下载 / 关闭，点图片以外任意处或 Esc 关闭（无编辑功能） */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ImageOff, X } from 'lucide-react';
import { cn } from '../../common/ui';
import { t } from '../../i18n';

// data:image/png;base64,... → png（拿不到就默认 png），下载文件名用
function extFromSrc(src: string): string {
  const m = /^data:image\/([a-z+]+)[;,]/i.exec(src);
  const ext = m ? m[1].toLowerCase() : 'png';
  return ext === 'jpeg' ? 'jpg' : ext;
}

export function ImagePreview({ src, onClose }: { src: string; onClose: () => void }) {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    // 捕获阶段拦截 Esc：避免同时关掉外层弹窗/触发输入框的中断逻辑
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const download = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = `image-${Date.now()}.${extFromSrc(src)}`;
    a.click();
  };

  const btn = 'h-8 w-8 rounded-md bg-white/10 hover:bg-white/25 text-white flex items-center justify-center transition-colors';
  return createPortal(
    <div className="fixed inset-0 z-[1400] bg-black/75 flex items-center justify-center p-10" onMouseDown={onClose}>
      <div className="absolute top-3 right-3 flex items-center gap-2" onMouseDown={e => e.stopPropagation()}>
        {dim && <span className="text-xs tabular-nums text-white/85 bg-white/10 rounded-md px-2 py-1.5 select-none">{dim.w}×{dim.h}</span>}
        <button title={t('common.download')} onClick={download} className={btn}><Download size={15} /></button>
        <button title={t('common.close')} onClick={onClose} className={btn}><X size={16} /></button>
      </div>
      <img
        src={src} alt=""
        onLoad={e => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onMouseDown={e => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded-md shadow-2xl select-none"
      />
    </div>,
    document.body,
  );
}

/** 共用图片缩略图（输入框 / 用户气泡 / 工具读图）：点击放大预览；传 onDelete 时右上角出删除角标；
 * 加载失败时显示占位框，传 label（文件名）/ title（完整路径）时占位框带文件名与失效说明 */
export function ImageThumb({ src, className, onDelete, label, title }: { src: string; className?: string; onDelete?: () => void; label?: string; title?: string }) {
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return label ? (
      <div title={title || label} className={cn('px-1.5 rounded-xl border border-border text-muted flex flex-col items-center justify-center gap-1 text-center overflow-hidden shrink-0', className)}>
        <ImageOff size={16} className="shrink-0" />
        <span className="text-[10px] leading-tight max-w-full truncate">{label}</span>
        <span className="text-[10px] leading-tight opacity-70">文件已不存在</span>
      </div>
    ) : (
      <div className={cn('px-2 rounded-xl border border-border text-xs text-muted flex items-center', className || 'h-10')}>图片</div>
    );
  }
  const img = (
    <img
      src={src} alt="" onClick={() => setPreview(true)} onError={() => setFailed(true)}
      className={cn('object-cover rounded-xl border border-border cursor-zoom-in', className)}
    />
  );
  return (
    <div className={cn('shrink-0', onDelete && 'relative')}>
      {img}
      {onDelete && (
        <button onClick={onDelete}
          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center">
          <X size={12} />
        </button>
      )}
      {preview && <ImagePreview src={src} onClose={() => setPreview(false)} />}
    </div>
  );
}
