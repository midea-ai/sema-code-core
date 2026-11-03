import { useEffect, useMemo, useState } from 'react';
import { Brain, FileText, RotateCw } from 'lucide-react';
import { useApp, PanelTab } from '../../store/app';
import { wsClient } from '../../api/ws';
import { Markdown } from '../chat/Markdown';
import { Spinner, cn } from '../../common/ui';
import { t } from '../../i18n';

const MEMORY_DIR = '.sema/memory';

/** core.getMemoryInfo 返回：MEMORY.md 主 prompt + 目录下其他 .md 关联文件（绝对路径） */
export interface MemoryConfig { prompt: string; from?: string; FilePath?: string; refFilePath?: string[] }

interface MemoryEntry { title: string; file: string; hook: string }

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/**
 * 解析 MEMORY.md 索引行 `- [标题](文件.md) — 摘要` 为结构化条目；
 * 解析不出的行归入 leftover，用 Markdown 兜底渲染（手写的自由格式索引也能看）
 */
function parseIndex(prompt: string): { entries: MemoryEntry[]; leftover: string } {
  const entries: MemoryEntry[] = [];
  const rest: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*)?(.*)$/);
    if (m) entries.push({ title: m[1].trim(), file: m[2].trim(), hook: m[3].trim() });
    else rest.push(line);
  }
  return { entries, leftover: rest.join('\n').trim() };
}

/** 索引未提及的关联文件（标题即文件名），保证目录里的记忆一个不漏 */
const extraFiles = (memory: MemoryConfig, entries: MemoryEntry[]) => {
  const named = new Set(entries.map(e => fileName(e.file)));
  return (memory.refFilePath || []).filter(fp => !named.has(fileName(fp)));
};

/** 记忆条目数（索引条目 + 未提及的关联文件 + 兜底 Markdown 算 1 条）：扩展标签的分组计数用 */
export function memoryEntryCount(memory: MemoryConfig): number {
  const { entries, leftover } = parseIndex(memory.prompt || '');
  return entries.length + extraFiles(memory, entries).length + (leftover ? 1 : 0);
}

/** 记忆条目列表（索引条目 + 索引未提及的关联文件 + 兜底 Markdown）：记忆标签与扩展标签共用，调用方保证 memory.prompt 非空。
 * compact：紧凑列表行（无独立边框，由调用方的分隔线容器区分），摘要单行截断 */
export function MemoryEntries({ sessionId, memory, compact }: { sessionId: string; memory: MemoryConfig; compact?: boolean }) {
  const openFileTab = useApp(s => s.openFileTab);
  const { entries, leftover } = useMemo(() => parseIndex(memory.prompt || ''), [memory.prompt]);
  const extras = useMemo(() => extraFiles(memory, entries), [entries, memory.refFilePath]);

  /** 索引里的链接是相对 .sema/memory/ 的文件名，拼回可打开的路径 */
  const openEntry = (file: string) => openFileTab(sessionId, /^(\/|[a-zA-Z]:[\\/])/.test(file) ? file : `${MEMORY_DIR}/${file.replace(/^\.\//, '')}`);
  const row = compact ? 'group py-1.5 cursor-pointer' : 'rounded-lg border border-border px-3 py-2 cursor-pointer hover:bg-black/[0.02] hover:border-black/15';

  return (
    <>
      {entries.map(e => (
        <div key={e.file + e.title} onClick={() => openEntry(e.file)} className={row}>
          <div className={cn('text-[13px] font-medium text-fg truncate', compact && 'group-hover:underline')} title={e.file}>{e.title}</div>
          {e.hook && <div className={cn('text-xs text-muted', compact ? 'truncate' : 'mt-0.5 break-words')} title={compact ? e.hook : undefined}>{e.hook}</div>}
        </div>
      ))}
      {extras.map(fp => (
        <div key={fp} onClick={() => openFileTab(sessionId, fp)} className={row}>
          <div className={cn('text-[13px] font-medium text-fg truncate', compact && 'group-hover:underline')} title={fp}>{fileName(fp)}</div>
        </div>
      ))}
      {leftover && (
        <div className={compact ? 'py-1.5 text-[13px]' : 'rounded-lg border border-border px-3 py-2 text-[13px]'}>
          <Markdown text={leftover} sessionId={sessionId} renderImages />
        </div>
      )}
    </>
  );
}

/** 「记忆」标签：经 core.getMemoryInfo 展示当前项目实际加载的记忆（MEMORY.md 为空/缺失时 core 不加载，如实显示空态） */
export function MemoryTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const openFileTab = useApp(s => s.openFileTab);
  const toast = useApp(s => s.toast);
  const [memory, setMemory] = useState<MemoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (asRefresh = false) => {
    asRefresh ? setRefreshing(true) : setLoading(true);
    // 打开时记忆多半刚被本轮修改过，固定带 refresh 清掉 core 侧缓存
    try { setMemory(await wsClient.request<MemoryConfig | null>('session.getMemoryInfo', sessionId, { refresh: true })); }
    catch (e: any) { setMemory(null); if (asRefresh) toast(`${t('memory.loadFailed')}：${e?.message || e}`, 'error'); }
    asRefresh ? setRefreshing(false) : setLoading(false);
  };
  // focusSeq：每次从记忆卡片打开都会变化，触发重拉
  useEffect(() => { void load(); }, [sessionId, tab.focusSeq]);

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-2.5 border-b border-border">
        <span className="text-xs text-muted truncate">{MEMORY_DIR}</span>
        <span className="flex-1" />
        {memory?.FilePath && (
          <button onClick={() => openFileTab(sessionId, memory.FilePath!)} className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-xs text-muted hover:text-fg hover:bg-black/[0.05]" title={memory.FilePath}>
            <FileText size={12} /> MEMORY.md
          </button>
        )}
        <button onClick={() => void load(true)} disabled={refreshing} className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] disabled:opacity-40" title={t('memory.refresh')}>
          {refreshing ? <Spinner className="h-3.5 w-3.5" /> : <RotateCw size={13} />}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5">
        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner /></div>
        ) : !memory?.prompt ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted gap-2 p-6">
            <Brain size={30} className="text-fg" />
            <div className="text-base font-medium text-fg">{t('memory.empty')}</div>
            <div className="max-w-xs text-xs">{t('memory.emptyHint')}</div>
          </div>
        ) : (
          <MemoryEntries sessionId={sessionId} memory={memory} />
        )}
      </div>
    </>
  );
}
