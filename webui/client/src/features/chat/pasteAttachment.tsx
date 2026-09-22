/**
 * 超长粘贴转附件：阈值、预览生成与粘贴芯片（输入框 / 用户气泡共用）。
 * input 模板拼装与解析在 shared/paste.ts（服务端 reducer 也要用）。
 */
import { ChevronRight, FileText, ScanText, X } from 'lucide-react';
import { cn } from '../../common/ui';
import { t } from '../../i18n';

/** 粘贴文本满足其一即转文件 */
const PASTE_MIN_CHARS = 3000;
const PASTE_MIN_LINES = 100;
const PREVIEW_LEN = 80;
/** 转存接口失败时的提示（极少触发，不进 i18n） */
export const PASTE_SAVE_FAILED = 'Failed to save pasted text as a file, pasted as-is';

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || text.split(/\r?\n/).length >= PASTE_MIN_LINES;
}

/** 预览：从首个非空行起，空白折叠为单个空格，`"` 换成 `'`（模板里用双引号包裹），截 80 字符后加 … */
export function makePastePreview(text: string): string {
  const one = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return one.length > PREVIEW_LEN ? one.slice(0, PREVIEW_LEN) + '…' : one;
}

/** 输入框里的粘贴芯片高度（有粘贴块时图片缩略图缩到同高） */
export const PASTE_CHIP_HEIGHT = 'h-16';

/**
 * 输入框粘贴芯片：圆角边框 + 图标 + 单行截断预览，预览下方「在文本框中显示 ›」在芯片内部，
 * 右上角删除角标样式同图片缩略图。
 */
export function PasteChip({ preview, onDelete, onShowInInput }: { preview: string; onDelete: () => void; onShowInInput: () => void }) {
  return (
    <div className="relative shrink-0 w-52">
      <div title={preview} className={cn(PASTE_CHIP_HEIGHT, 'pl-3 pr-7 rounded-xl border border-border bg-white flex items-center gap-2.5 text-xs overflow-hidden')}>
        <ScanText size={18} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <span className="truncate text-fg">{preview}</span>
          <button onClick={onShowInInput} className="self-start inline-flex items-center gap-0.5 text-[11px] text-muted hover:text-fg">
            {t('chat.pasteShowInInput')}<ChevronRight size={12} />
          </button>
        </div>
      </div>
      <button onClick={onDelete}
        className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center">
        <X size={12} />
      </button>
    </div>
  );
}

/** 用户气泡里的粘贴块：独占一行的胶囊，小图标 + 单行截断预览，点击在右栏打开转存文件 */
export function PastePill({ preview, onOpen }: { preview: string; onOpen: () => void }) {
  return (
    <div title={preview} onClick={onOpen}
      className="max-w-72 h-9 px-3 rounded-full border border-border bg-white flex items-center gap-2 text-sm cursor-pointer hover:bg-black/[0.03]">
      <FileText size={14} className="shrink-0 text-muted" />
      <span className="truncate">{preview}</span>
    </div>
  );
}
