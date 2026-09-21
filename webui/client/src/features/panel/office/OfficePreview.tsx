import { useEffect, useState } from 'react';
import { useApp } from '../../../store/app';
import { Spinner } from '../../../common/ui';
import { t } from '../../../i18n';
import type { OfficeKind } from './kind';
import type { Zoom } from './ZoomDropdown';
import { MAX_RAW, useFileBytes } from './bytes';
import { DocxView } from './DocxView';
import { SheetView } from './xlsx/SheetView';
import { PptxView } from './pptx/PptxView';
import { PdfView, type PdfPageInfo } from './pdf/PdfView';

interface PreviewProps {
  sessionId: string; tabId: string; path: string; kind: OfficeKind; size: number; mtime: number;
  zoom: Zoom; onFitPct: (pct: number | null) => void;
  /** 仅 pdf：上报当前页 / 总页数，注册跳页函数（翻页控件在文件标签头部） */
  onPage?: (info: PdfPageInfo | null) => void;
  pagerRef?: React.MutableRefObject<((page: number) => void) | null>;
}

const MB = 1024 * 1024;
// 解析在主线程做，超过软阈值先让用户确认，避免点开就卡住（pdf 在 worker 里解析、按页渲染，不设软阈值，只受 MAX_RAW 限制）
const SOFT_LIMIT: Record<OfficeKind, number> = { docx: 30 * MB, xlsx: 20 * MB, pptx: 20 * MB, csv: 20 * MB, pdf: Infinity };

/** Office 预览入口：超限 / 大文件确认 → 取字节 → 按类型分发；任何失败都留「用默认程序打开」兜底 */
export function OfficePreview(props: PreviewProps) {
  const { sessionId, path, kind, size } = props;
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [path]);
  if (size > MAX_RAW) return <Notice sessionId={sessionId} path={path} text={t('office.tooLarge')} />;
  if (size > SOFT_LIMIT[kind] && !confirmed) {
    return (
      <Notice sessionId={sessionId} path={path} text={t('office.largeConfirm', { size: `${(size / MB).toFixed(1)} MB` })}>
        <button onClick={() => setConfirmed(true)} className={BTN}>{t('office.continue')}</button>
      </Notice>
    );
  }
  return <Loaded {...props} />;
}

function Loaded({ sessionId, tabId, path, kind, size, mtime, zoom, onFitPct, onPage, pagerRef }: PreviewProps) {
  const { buf, error } = useFileBytes(sessionId, path, mtime, size);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { setFailed(null); }, [buf]);
  const msg = error || failed;
  if (msg) return <Notice sessionId={sessionId} path={path} text={t('office.failed', { msg })} danger />;
  if (!buf) return <div className="p-4 text-sm text-muted font-sans flex items-center gap-2"><Spinner />{t('common.loading')}</div>;
  if (kind === 'docx') return <DocxView buf={buf} zoom={zoom} onFitPct={onFitPct} onError={setFailed} />;
  if (kind === 'pdf') return <PdfView buf={buf} zoom={zoom} tabId={tabId} onFitPct={onFitPct} onError={setFailed} onPage={onPage} pagerRef={pagerRef} />;
  if (kind === 'pptx') return <PptxView buf={buf} zoom={zoom} tabId={tabId} onFitPct={onFitPct} onError={setFailed} />;
  return <SheetView buf={buf} csv={kind === 'csv'} path={path} tabId={tabId} scale={zoom === 'fit' ? 1 : Number(zoom) / 100} onError={setFailed} />;
}

const BTN = 'h-7 px-2.5 rounded-md border border-border text-xs text-fg hover:bg-black/[0.05]';

function Notice({ sessionId, path, text, danger, children }: { sessionId: string; path: string; text: string; danger?: boolean; children?: React.ReactNode }) {
  const openFileExternal = useApp(s => s.openFileExternal);
  const toast = useApp(s => s.toast);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center font-sans">
      <div className={danger ? 'text-sm text-danger' : 'text-sm text-muted'}>{text}</div>
      <div className="flex items-center gap-2">
        {children}
        <button onClick={() => openFileExternal(sessionId, path).catch(e => toast(e.message, 'error'))} className={BTN}>{t('file.openDefault')}</button>
      </div>
    </div>
  );
}
