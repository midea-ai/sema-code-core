import { useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare, ChevronDown, ChevronRight, Copy, Check, FolderOpen, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import type { FileChange, FileChangesBlock, UserBlock } from '../../../../shared/types';
import { useApp, PanelTab } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { DiffView } from '../chat/DiffView';
import { Dropdown, DropdownOption, cn, useCopy } from '../../common/ui';
import { t } from '../../i18n';

const ALL = '__all__';

interface Turn { block: FileChangesBlock; index: number; summary: string }

/** 「审阅」标签：按轮次汇总会话快照里的 file-changes 块，逐文件查看 hunk */
export function ReviewTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const blocks = useSessions(s => s.snapshots[sessionId]?.blocks);
  const updatePanel = useApp(s => s.updatePanel);

  // 所有轮次（按出现顺序）；摘要取同 inputId 的用户消息首行
  const turns = useMemo<Turn[]>(() => {
    const out: Turn[] = [];
    const users = new Map<string, UserBlock>();
    for (const b of blocks || []) {
      if (b.kind === 'user' && b.inputId) users.set(b.inputId, b);
      if (b.kind === 'file-changes') {
        const u = b.inputId ? users.get(b.inputId) : undefined;
        const summary = (u?.text || '').split('\n')[0].trim();
        out.push({ block: b, index: out.length + 1, summary });
      }
    }
    return out;
  }, [blocks]);

  const latestId = turns[turns.length - 1]?.block.id;
  const [selected, setSelected] = useState<string>(tab.blockId || latestId || ALL);
  // 卡片「审阅」跳转 → 定位到该轮
  useEffect(() => { if (tab.blockId) setSelected(tab.blockId); }, [tab.blockId]);
  // 选中项已不存在（回退截断）→ 回到最新
  useEffect(() => { if (selected !== ALL && !turns.some(x => x.block.id === selected)) setSelected(latestId || ALL); }, [turns, selected, latestId]);

  const files = useMemo<FileChange[]>(() => {
    if (selected === ALL) return mergeAll(turns.map(x => x.block.files));
    return turns.find(x => x.block.id === selected)?.block.files || [];
  }, [turns, selected]);

  // 默认全部展开；切换轮次时重新全部展开
  const allOpened = (fs: FileChange[]) => { const o: Record<string, boolean> = {}; fs.forEach(f => { o[f.path] = true; }); return o; };
  const [opened, setOpened] = useState<Record<string, boolean>>(() => allOpened(files));
  useEffect(() => { setOpened(allOpened(files)); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // 从消息流的文件汇总点进来：只展开该文件并滚动到它
  const focusHandled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!tab.focusPath || focusHandled.current === tab.focusSeq) return;
    if (tab.blockId && selected !== tab.blockId) return; // 等 selected 同步到目标轮次后再定位
    focusHandled.current = tab.focusSeq;
    setOpened({ [tab.focusPath]: true });
    const id = setTimeout(() => document.getElementById(`review-file-${tab.focusPath}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    return () => clearTimeout(id);
  }, [tab.focusPath, tab.focusSeq, selected]);
  const allOpen = files.length > 0 && files.every(f => opened[f.path]);
  const toggleAll = () => {
    if (allOpen) setOpened({});
    else { const o: Record<string, boolean> = {}; files.forEach(f => { o[f.path] = true; }); setOpened(o); }
  };

  const onSelect = (v: string) => {
    setSelected(v);
    // 同步到标签状态，刷新后保留定位
    updatePanel(sessionId, p => ({ ...p, tabs: p.tabs.map(x => x.id === tab.id ? { ...x, blockId: v === ALL ? undefined : v } : x) }));
  };

  const total = files.reduce((acc, f) => ({ a: acc.a + f.additions, r: acc.r + f.removals }), { a: 0, r: 0 });
  const options: DropdownOption<string>[] = [
    { value: ALL, label: t('review.all'), desc: statText(turns.flatMap(x => x.block.files)) },
    ...turns.slice().reverse().map(x => ({
      value: x.block.id,
      label: `${t('review.turn', { n: x.index })}${x.summary ? ` · ${x.summary}` : ''}`,
      desc: `${fmtTime(x.block.ts)} · ${statText(x.block.files)}`,
    })),
  ];
  const curTurn = turns.find(x => x.block.id === selected);

  if (!turns.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted p-6 gap-3">
        <GitCompare size={30} className="text-fg" />
        <div className="text-base font-medium text-fg">{t('review.empty')}</div>
        <div className="max-w-xs">{t('review.emptyHint')}</div>
      </div>
    );
  }

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-1.5 border-b border-border">
        <Dropdown value={selected} options={options} onChange={onSelect} minWidth={280}
          renderValue={() => <span className="max-w-56 truncate text-fg font-medium">{selected === ALL ? t('review.all') : t('review.turn', { n: curTurn?.index ?? 0 })}</span>} />
        <span className="text-xs text-muted">{t('review.filesStat', { n: files.length })}</span>
        <span className="text-xs font-mono"><span className="text-ok">+{total.a}</span> <span className="text-danger">-{total.r}</span></span>
        <span className="flex-1" />
        <button onClick={toggleAll} className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-xs text-muted hover:text-fg hover:bg-black/[0.05]" title={allOpen ? t('review.collapseAll') : t('review.expandAll')}>
          {allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}{allOpen ? t('review.collapseAll') : t('review.expandAll')}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ul className="px-1 py-1">
          {files.map(f => <FileRow key={f.path} sessionId={sessionId} file={f} open={!!opened[f.path]} onToggle={() => setOpened(o => ({ ...o, [f.path]: !o[f.path] }))} />)}
        </ul>
      </div>
    </>
  );
}

function FileRow({ sessionId, file, open, onToggle }: { sessionId: string; file: FileChange; open: boolean; onToggle: () => void }) {
  const { copied, copy } = useCopy();
  const toast = useApp(s => s.toast);
  const revealFile = useApp(s => s.revealFile);
  const i = file.path.lastIndexOf('/');
  const dir = i >= 0 ? file.path.slice(0, i + 1) : '';
  const base = i >= 0 ? file.path.slice(i + 1) : file.path;
  return (
    <li id={`review-file-${file.path}`}>
      <div className="group relative flex items-center gap-2 px-2 h-8 rounded-md hover:bg-black/[0.04] cursor-pointer" onClick={onToggle}>
        {open ? <ChevronDown size={13} className="text-muted shrink-0" /> : <ChevronRight size={13} className="text-muted shrink-0" />}
        <span className="truncate flex-1 text-[13px]" title={file.path}><span className="text-muted">{dir}</span><span className="text-fg">{base}</span></span>
        {/* 统计贴最右；悬停时淡出，由悬浮的操作按钮覆盖（按钮平时不占布局空间） */}
        <span className="text-xs font-mono shrink-0 group-hover:opacity-0"><span className="text-ok">+{file.additions}</span> <span className="text-danger">-{file.removals}</span></span>
        <span className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button onClick={e => { e.stopPropagation(); copy(file.path); }} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={copied ? t('review.copied') : t('review.copyPath')}>{copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}</button>
          <button onClick={e => { e.stopPropagation(); revealFile(sessionId, file.path).catch(err => toast(err.message, 'error')); }} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={t('review.revealFile')}><FolderOpen size={12} /></button>
        </span>
      </div>
      {open && (file.patch.length ? <DiffView patch={file.patch} path={file.path} sessionId={sessionId} className="mx-2 mb-2" /> : <div className="mx-2 mb-2 text-xs text-muted">{t('review.noDiff')}</div>)}
    </li>
  );
}

/** 「全部」：按路径合并各轮改动（patch 顺序拼接、+/− 累加、任一轮为新建则标新建） */
function mergeAll(groups: FileChange[][]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const files of groups) for (const f of files) {
    const prev = map.get(f.path);
    map.set(f.path, prev
      ? { ...prev, type: prev.type === 'new' || f.type === 'new' ? 'new' : 'diff', additions: prev.additions + f.additions, removals: prev.removals + f.removals, patch: [...prev.patch, ...f.patch] }
      : { ...f });
  }
  return [...map.values()];
}

function statText(files: FileChange[]) {
  const seen = new Set(files.map(f => f.path));
  const a = files.reduce((s, f) => s + f.additions, 0), r = files.reduce((s, f) => s + f.removals, 0);
  return `${t('review.filesStat', { n: seen.size })} +${a} -${r}`;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
