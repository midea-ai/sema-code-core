import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare, ChevronDown, ChevronRight, Copy, Check, FolderOpen, ChevronsDownUp, ChevronsUpDown, SquareArrowOutUpRight, RotateCw } from 'lucide-react';
import type { FileChange, FileChangesBlock, UserBlock } from '../../../../shared/types';
import { countPatch } from '../../../../shared/transcript';
import { useApp, PanelTab } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { api, getToken } from '../../api/http';
import { DiffView } from '../chat/DiffView';
import { Dropdown, DropdownOption, Spinner, cn, useCopy } from '../../common/ui';
import { displayPath } from '../../common/text';
import { t } from '../../i18n';

const ALL = '__all__';
const GIT = 'git:uncommitted';
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

interface Turn { block: FileChangesBlock; index: number; summary: string }
interface GitData { gitRepo: boolean; files: FileChange[]; ts: number }

/** 「审阅」标签：轮次视图（事件流的历史总 diff）+ Git 视图（未暂存/未提交，实时现算） */
export function ReviewTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const blocks = useSessions(s => s.snapshots[sessionId]?.blocks);
  const updatePanel = useApp(s => s.updatePanel);
  const toast = useApp(s => s.toast);

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
  const isGit = selected === GIT;
  // 卡片「审阅」跳转 → 定位到该轮
  useEffect(() => { if (tab.blockId) setSelected(tab.blockId); }, [tab.blockId]);
  // 选中项已不存在（回退截断/旧版 git 视图值）→ 回到最新；Git 视图不受轮次影响
  useEffect(() => {
    if (selected.startsWith('git:') && selected !== GIT) { setSelected(GIT); return; }
    if (selected !== ALL && selected !== GIT && !turns.some(x => x.block.id === selected)) setSelected(latestId || ALL);
  }, [turns, selected, latestId]);

  // 是否 Git 仓库：决定下拉里显示不显示 Git 视图选项（每次打开面板探测一次）
  const [gitRepo, setGitRepo] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ gitRepo: boolean }>('POST', `/api/sessions/${sessionId}/git-diff`, { mode: 'check' })
      .then(d => { if (alive) setGitRepo(d.gitRepo); })
      .catch(() => { if (alive) setGitRepo(false); });
    return () => { alive = false; };
  }, [sessionId]);
  // 非 Git 仓库但持久化的选中项是 Git 视图（比如目录后来变了）→ 回到最新一轮
  useEffect(() => {
    if (gitRepo === false && selected.startsWith('git:')) setSelected(latestId || ALL);
  }, [gitRepo, selected, latestId]);

  // Git 视图：切入 / 新一轮结束（latestId 变化）/ 手动刷新时重新拉取
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const gitSeq = useRef(0);
  const loadGit = useCallback(async () => {
    const seq = ++gitSeq.current;
    setGitLoading(true);
    try {
      const d = await api<GitData>('POST', `/api/sessions/${sessionId}/git-diff`, { mode: 'list' });
      if (gitSeq.current === seq) setGitData(d);
    } catch (e: any) {
      if (gitSeq.current === seq) { setGitData({ gitRepo: true, files: [], ts: Date.now() }); toast(e.message, 'error'); }
    } finally {
      if (gitSeq.current === seq) setGitLoading(false);
    }
  }, [sessionId, toast]);
  useEffect(() => { if (isGit) loadGit(); }, [isGit, latestId, loadGit]);

  const allFiles = useMemo(() => mergeAll(turns.map(x => x.block.files)), [turns]);
  const files = useMemo<FileChange[]>(() => {
    if (isGit) return gitData?.files || [];
    if (selected === ALL) return allFiles;
    return turns.find(x => x.block.id === selected)?.block.files || [];
  }, [turns, selected, isGit, gitData, allFiles]);

  // 「未提交」视图用左右分栏：左侧单文件详情（按需取 diff）+ 右侧文件树；轮次/本次会话仍为列表
  const split = isGit;
  const [selPath, setSelPath] = useState<string | null>(null);
  useEffect(() => {
    if (split && (!selPath || !files.some(f => f.path === selPath))) setSelPath(files[0]?.path ?? null);
  }, [split, files]); // eslint-disable-line react-hooks/exhaustive-deps
  // 分界线拖拽调整文件树宽度
  const [treeW, setTreeW] = useState(192);
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = treeW;
    const move = (ev: PointerEvent) => setTreeW(Math.min(480, Math.max(110, startW + (startX - ev.clientX))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 默认全部展开；切换视图时重新全部展开
  const allOpened = (fs: FileChange[]) => { const o: Record<string, boolean> = {}; fs.forEach(f => { o[f.path] = true; }); return o; };
  const [opened, setOpened] = useState<Record<string, boolean>>(() => allOpened(files));
  useEffect(() => { setOpened(allOpened(files)); }, [selected, gitData]); // eslint-disable-line react-hooks/exhaustive-deps
  // 从消息流的文件汇总点进来：分栏时选中该文件；列表时只展开该文件并滚动到它
  const focusHandled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!tab.focusPath || focusHandled.current === tab.focusSeq) return;
    if (tab.blockId && selected !== tab.blockId) return; // 等 selected 同步到目标轮次后再定位
    focusHandled.current = tab.focusSeq;
    if (split) { setSelPath(tab.focusPath); return; }
    setOpened({ [tab.focusPath]: true });
    const id = setTimeout(() => document.getElementById(`review-file-${tab.focusPath}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    return () => clearTimeout(id);
  }, [tab.focusPath, tab.focusSeq, selected, split]);
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
    { value: ALL, label: t('review.all'), desc: statNode(allFiles) },
    ...turns.slice().reverse().map(x => ({
      value: x.block.id,
      label: `${t('review.turn', { n: x.index })}${x.summary ? ` · ${x.summary}` : ''}`,
      desc: <>{fmtTime(x.block.ts)} · {statNode(x.block.files)}</>,
    })),
    // Git 视图仅在会话目录处于 Git 仓库内时提供，与轮次组之间画分割线
    ...(gitRepo ? [{ value: GIT, label: t('review.uncommitted'), sepAbove: true }] : []),
  ];
  const curTurn = turns.find(x => x.block.id === selected);
  const selectedLabel = isGit
    ? t('review.uncommitted')
    : selected === ALL ? t('review.all') : t('review.turn', { n: curTurn?.index ?? 0 });

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-1.5 border-b border-border">
        <Dropdown value={selected} options={options} onChange={onSelect} fitWidth
          renderValue={() => <span className="max-w-56 truncate text-fg font-medium">{selectedLabel}</span>} />
        <span className="text-xs text-muted">{t('review.filesStat', { n: files.length })}</span>
        <span className="text-xs font-mono"><span className="text-ok">+{total.a}</span> <span className="text-danger">-{total.r}</span></span>
        <span className="flex-1" />
        {isGit && (
          <button onClick={loadGit} title={t('review.refresh')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-xs text-muted hover:text-fg hover:bg-black/[0.05]">
            <RotateCw size={13} className={gitLoading ? 'animate-spin' : undefined} />
            {gitData ? fmtClock(gitData.ts) : null}
          </button>
        )}
        {!split && (
          <button onClick={toggleAll} className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-xs text-muted hover:text-fg hover:bg-black/[0.05]" title={allOpen ? t('review.collapseAll') : t('review.expandAll')}>
            {allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}{allOpen ? t('review.collapseAll') : t('review.expandAll')}
          </button>
        )}
      </div>
      <div className={cn('flex-1 min-h-0', split ? 'flex' : 'overflow-y-auto')}>
        {isGit && gitData && !gitData.gitRepo ? (
          <EmptyHint title={t('review.notGit')} hint={t('review.notGitHint')} />
        ) : isGit && !gitLoading && gitData && files.length === 0 ? (
          <EmptyHint title={t('review.gitClean')} hint={t('review.gitCleanHint')} />
        ) : !isGit && !turns.length ? (
          <EmptyHint title={t('review.empty')} hint={t('review.emptyHint')} />
        ) : split ? (
          <>
            <FileDetail sessionId={sessionId} file={files.find(f => f.path === selPath) || files[0]} gitTs={gitData?.ts} />
            <div onPointerDown={onDividerDown} className="w-[5px] -mx-0.5 shrink-0 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/40" />
            <FileTree files={files} selected={selPath} onSelect={setSelPath} width={treeW} />
          </>
        ) : (
          <ul className="px-1 py-1">
            {files.map(f => <FileRow key={f.path} sessionId={sessionId} file={f} open={!!opened[f.path]} onToggle={() => setOpened(o => ({ ...o, [f.path]: !o[f.path] }))} />)}
          </ul>
        )}
      </div>
    </>
  );
}

function EmptyHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-sm text-muted p-6 gap-3">
      <GitCompare size={30} className="text-fg" />
      <div className="text-base font-medium text-fg">{title}</div>
      <div className="max-w-xs">{hint}</div>
    </div>
  );
}

function FileRow({ sessionId, file, open, onToggle }: { sessionId: string; file: FileChange; open: boolean; onToggle: () => void }) {
  const { copied, copy } = useCopy();
  const toast = useApp(s => s.toast);
  const revealFile = useApp(s => s.revealFile);
  const openFileTab = useApp(s => s.openFileTab);
  const disp = displayPath(file.path);
  const i = disp.lastIndexOf('/');
  const dir = i >= 0 ? disp.slice(0, i + 1) : '';
  const base = i >= 0 ? disp.slice(i + 1) : disp;
  return (
    <li id={`review-file-${file.path}`}>
      <div className="group relative flex items-center gap-2 px-2 h-8 rounded-md hover:bg-black/[0.04] cursor-pointer" onClick={onToggle}>
        {open ? <ChevronDown size={13} className="text-muted shrink-0" /> : <ChevronRight size={13} className="text-muted shrink-0" />}
        <span className="truncate flex-1 text-[13px]" title={file.path}><span className="text-muted">{dir}</span><span className="text-fg">{base}</span></span>
        {/* 统计贴最右；悬停时淡出，由悬浮的操作按钮覆盖（按钮平时不占布局空间） */}
        <span className="text-xs font-mono shrink-0 group-hover:opacity-0"><span className="text-ok">+{file.additions}</span> <span className="text-danger">-{file.removals}</span></span>
        <span className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button onClick={e => { e.stopPropagation(); openFileTab(sessionId, file.path); }} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={t('review.openFile')}><SquareArrowOutUpRight size={12} /></button>
          <button onClick={e => { e.stopPropagation(); copy(file.path); }} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={copied ? t('review.copied') : t('review.copyPath')}>{copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}</button>
          <button onClick={e => { e.stopPropagation(); revealFile(sessionId, file.path).catch(err => toast(err.message, 'error')); }} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={t('review.revealFile')}><FolderOpen size={12} /></button>
        </span>
      </div>
      {open && (file.patch.length ? <DiffView patch={file.patch} path={file.path} sessionId={sessionId} diffText={file.diffText} className="mx-2 mb-2" /> : <div className="mx-2 mb-2 text-xs text-muted">{t('review.noDiff')}</div>)}
    </li>
  );
}

/** 文件状态字母：U 新增 / D 删除 / M 修改，配 VS Code 风格语义色 */
function statusOf(f: FileChange): { ch: string; cls: string } {
  if (f.deleted) return { ch: 'D', cls: 'text-danger' };
  if (f.type === 'new') return { ch: 'U', cls: 'text-ok' };
  return { ch: 'M', cls: 'text-warn' };
}

/** 分栏左侧：单文件详情。diff 按选中文件即时向服务端取（列表不带 patch），图片直接展示当前内容 */
function FileDetail({ sessionId, file, gitTs }: { sessionId: string; file?: FileChange; gitTs?: number }) {
  const openFileTab = useApp(s => s.openFileTab);
  const path = file?.path;
  const isImg = !!path && IMG_RE.test(path);
  const [detail, setDetail] = useState<{ path: string; file: FileChange } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path || isImg) return;
    let alive = true;
    setLoading(true);
    api<{ file: FileChange | null }>('POST', `/api/sessions/${sessionId}/git-diff`, { mode: 'file', path })
      .then(d => { if (alive && d.file) setDetail({ path, file: d.file }); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, path, isImg, gitTs]);
  if (!file || !path) return <div className="flex-1" />;
  const cur = detail?.path === path ? detail.file : null;
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <span className="truncate flex-1 text-[13px]" title={path}>{displayPath(path)}</span>
        <span className="text-xs font-mono shrink-0"><span className="text-ok">+{file.additions}</span> <span className="text-danger">-{file.removals}</span></span>
        {!file.deleted && (
          <button onClick={() => openFileTab(sessionId, path)} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" title={t('review.openFile')}>
            <SquareArrowOutUpRight size={12} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {isImg && !file.deleted ? (
          <img src={`/api/sessions/${sessionId}/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(getToken())}`}
            className="max-w-full rounded-md border border-border" alt={path} />
        ) : cur ? (
          cur.patch.length
            ? <DiffView patch={cur.patch} path={path} sessionId={sessionId} diffText={cur.diffText} />
            : <div className="text-xs text-muted">{t('review.noDiff')}</div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-xs text-muted p-2"><Spinner />{t('common.loading')}</div>
        ) : (
          <div className="text-xs text-muted">{t('review.noDiff')}</div>
        )}
      </div>
    </div>
  );
}

interface TreeRow { name: string; depth: number; key: string; file?: FileChange }
interface DirNode { dirs: Map<string, DirNode>; files: FileChange[] }

/** 路径列表 → 缩进树行：目录在前按名排序，仅单一子目录且无文件的目录链折叠为一行；collapsed 中的目录不展开子项 */
function treeRows(files: FileChange[], collapsed: Set<string>): TreeRow[] {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = displayPath(f.path).split('/').filter(Boolean);
    let node = root;
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) { next = { dirs: new Map(), files: [] }; node.dirs.set(seg, next); }
      node = next;
    }
    node.files.push(f);
  }
  const out: TreeRow[] = [];
  const walk = (node: DirNode, depth: number, prefix: string) => {
    for (const dn of [...node.dirs.keys()].sort()) {
      let name = dn, child = node.dirs.get(dn)!;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const k = [...child.dirs.keys()][0];
        name += '/' + k;
        child = child.dirs.get(k)!;
      }
      const key = `${prefix}/${name}`;
      out.push({ name, depth, key });
      if (!collapsed.has(key)) walk(child, depth + 1, key);
    }
    for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
      out.push({ name: f.path.split('/').pop() || f.path, depth, key: f.path, file: f });
    }
  };
  walk(root, 0, '');
  return out;
}

/** 分栏右侧：文件树，目录可折叠，文件名后带彩色状态字母；宽度由分界线拖拽控制 */
function FileTree({ files, selected, onSelect, width }: { files: FileChange[]; selected: string | null; onSelect: (p: string) => void; width: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => treeRows(files, collapsed), [files, collapsed]);
  const toggleDir = (key: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div style={{ width }} className="shrink-0 border-l border-border overflow-y-auto overflow-x-hidden py-1">
      {rows.map(r => {
        if (!r.file) {
          return (
            <button key={r.key} style={{ paddingLeft: 4 + r.depth * 10 }} onClick={() => toggleDir(r.key)}
              className="w-full h-6 flex items-center gap-0.5 pr-2 text-xs text-muted text-left hover:bg-black/[0.04]">
              {collapsed.has(r.key) ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
              <span className="truncate">{r.name}</span>
            </button>
          );
        }
        const st = statusOf(r.file);
        const path = r.file.path;
        return (
          <button key={r.key} style={{ paddingLeft: 16 + r.depth * 10 }} onClick={() => onSelect(path)} title={path}
            className={cn('w-full h-6 flex items-center gap-1.5 pr-2 text-[12px] text-left hover:bg-black/[0.04]', selected === path && 'bg-black/[0.06]')}>
            <span className="truncate flex-1 text-fg">{r.name}</span>
            <span className={cn('shrink-0 font-mono text-[11px]', st.cls)}>{st.ch}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 「全部」视图：优先取每个文件最后一轮的会话级总 diff（会话首次触及前 → 最新，服务端事件时刻算好）；
 * 最后一轮无总 diff（降级/老快照）则回退为逐轮拼接（patch 顺序拼、+/− 累加）。
 */
function mergeAll(groups: FileChange[][]): FileChange[] {
  const map = new Map<string, { concat: FileChange; last: FileChange }>();
  for (const files of groups) for (const f of files) {
    const prev = map.get(f.path);
    const concat: FileChange = prev
      ? { ...prev.concat, type: prev.concat.type === 'new' || f.type === 'new' ? 'new' : 'diff', additions: prev.concat.additions + f.additions, removals: prev.concat.removals + f.removals, patch: [...prev.concat.patch, ...f.patch], diffText: prev.concat.diffText || f.diffText }
      : { ...f };
    map.set(f.path, { concat, last: f });
  }
  return [...map.values()].map(({ concat, last }) => {
    if (last.cumulative && !last.sessionDropped) {
      const patch = last.sessionPatch ?? last.patch;
      const { additions, removals } = countPatch(patch);
      return { ...last, type: last.sessionPatch ? (last.sessionType ?? last.type) : last.type, patch, additions, removals };
    }
    return concat;
  });
}

/** 「N 个文件 +a -r」，增删数带颜色 */
function statNode(files: FileChange[]) {
  const seen = new Set(files.map(f => f.path));
  const a = files.reduce((s, f) => s + f.additions, 0), r = files.reduce((s, f) => s + f.removals, 0);
  return <>{t('review.filesStat', { n: seen.size })} <span className="font-mono"><span className="text-ok">+{a}</span> <span className="text-danger">-{r}</span></span></>;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
