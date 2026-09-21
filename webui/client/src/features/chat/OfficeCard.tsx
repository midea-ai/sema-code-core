import { Children, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Popover, MenuSep } from '../../common/ui';
import { OpenWithItems, useOpenWithApps } from '../../common/openWith';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { useApp } from '../../store/app';
import { I18nKey, t } from '../../i18n';
import { extractCandidates, useFileStats } from './fileRefs';
import { OFFICE_RE, OfficeKind, officeKindOf, baseNameNoExt } from '../panel/office/kind';

const PREVIEW = 3;

/**
 * 同类产物卡片成组（网站卡片、Office 卡片共用）：同一类的多个产物收在一个圆角框里，行间细线分隔、不留缝；
 * 默认显示前 3 行，其余折叠。不同类型各自成组，组与组之间才留缝。children 为若干 ArtifactRow，为空时不渲染。
 */
export function ArtifactGroup({ children }: { children: React.ReactNode }) {
  const [showAll, setShowAll] = useState(false);
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  const rest = rows.length - PREVIEW;
  return (
    <div className="my-3 rounded-xl border border-border bg-white text-sm divide-y divide-border">
      {showAll ? rows : rows.slice(0, PREVIEW)}
      {rest > 0 && (
        <button onClick={() => setShowAll(v => !v)} className="w-full h-9 flex items-center justify-center gap-1.5 text-[13px] text-muted hover:text-fg hover:bg-black/[0.03] rounded-b-xl">
          {showAll ? t('card.collapseFiles') : t('card.moreFiles', { n: rest })} {showAll ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
    </div>
  );
}

/**
 * 产物卡片的一行：图标 + 标题 / 副标题 + 分体按钮，外框由 ArtifactGroup 提供。
 * 点卡片或按钮左半 = 默认在 SemaWork 右栏打开；右半箭头展开下拉，可选系统应用（与文件标签「打开方式」同源）。
 * appsOnly：下拉只列系统应用、不含 SemaWork，此时整个按钮都是展开下拉（右栏打开只留给点卡片）。
 */
export function ArtifactRow({ sessionId, path, icon, title, subtitle, tip, onOpen, appsOnly }: {
  sessionId: string; path: string; icon: React.ReactNode; title: string; subtitle: string; tip?: string; onOpen: () => void; appsOnly?: boolean;
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const apps = useOpenWithApps(sessionId, path);
  const open = () => { setMenu(null); onOpen(); };
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="h-9 w-9 rounded-lg bg-panel flex items-center justify-center shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={open} title={tip}>
        <div className="font-medium truncate">{title}</div>
        <div className="text-xs text-muted truncate">{subtitle}</div>
      </div>
      {/* 分体按钮：左半「打开方式」= 默认项（右栏打开），右半箭头才展开下拉（与文件标签顶栏一致） */}
      {appsOnly ? (
        <button onClick={e => setMenu(e.currentTarget.getBoundingClientRect())} className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-border text-fg text-xs hover:bg-black/[0.05]">
          {t('card.openWith')} <ChevronDown size={11} className="text-muted" />
        </button>
      ) : (
        <div className="h-7 inline-flex items-stretch rounded-md border border-border text-fg overflow-hidden text-xs">
          <button onClick={open} className="px-2 inline-flex items-center hover:bg-black/[0.05]" title="SemaWork">{t('card.openWith')}</button>
          <button onClick={e => setMenu(e.currentTarget.getBoundingClientRect())} className="px-1 inline-flex items-center text-muted hover:text-fg hover:bg-black/[0.05]"><ChevronDown size={11} /></button>
        </div>
      )}
      <Popover anchor={menu} onClose={() => setMenu(null)} align="right">
        {!appsOnly && (
          <>
            <button onClick={open} className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded hover:bg-black/[0.06] text-sm text-fg">
              <img src="/icon.svg" alt="" className="w-5 h-5 shrink-0" />
              <span className="truncate">SemaWork</span>
            </button>
            <MenuSep />
          </>
        )}
        <OpenWithItems sessionId={sessionId} path={path} apps={apps} onDone={() => setMenu(null)} />
      </Popover>
    </div>
  );
}

// ==================== Office 卡片（结论里提到了 docx / xlsx / pptx / csv / pdf） ====================

const SUBTITLE: Record<OfficeKind, I18nKey> = { docx: 'card.office.docx', xlsx: 'card.office.xlsx', pptx: 'card.office.pptx', csv: 'card.office.csv', pdf: 'card.office.pdf' };

/**
 * 判定与行内文件高亮同源：结论（最后一段助手文本）里被确认存在的 Office 文件就出卡片，不区分是否本轮产出。
 * stat 复用 fileRefs 的会话缓存，Markdown 渲染同一段文本时已经查过，这里不会多发请求。
 * text = 本轮最后一段助手文本。docx / xlsx / pdf 等算同一类，收在一组里。
 */
export function OfficeCards({ sessionId, text }: { sessionId: string; text: string }) {
  const stat = useFileStats(sessionId, text, true);
  const paths = useMemo(() => extractCandidates(text).filter(p => OFFICE_RE.test(p)), [text]);
  // 同一个文件在结论里可能既写相对路径又写绝对路径，候选按字面去重拦不住，这里按 stat 的绝对路径再去一次，留先出现的
  const seen = new Set<string>();
  const files = paths.filter(p => {
    const s = stat(p);
    if (!s?.exists || s.isDir) return false;
    const abs = s.abs || p;
    if (seen.has(abs)) return false;
    seen.add(abs);
    return true;
  });
  return (
    <ArtifactGroup>
      {files.map(p => (
        <ArtifactRow key={`office:${p}`} sessionId={sessionId} path={p} tip={stat(p)?.abs || p} appsOnly
          icon={<FileIcon fileName={p} size={18} />} title={baseNameNoExt(p)} subtitle={t(SUBTITLE[officeKindOf(p)!])}
          onOpen={() => useApp.getState().openFileTab(sessionId, p)} />
      ))}
    </ArtifactGroup>
  );
}
