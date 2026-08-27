import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FolderTree, ExternalLink, Search, X, Files } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { api, getToken } from '../../api/http';
import { useApp, PanelTab } from '../../store/app';
import { cn, Popover, MenuItem, MenuSep, Spinner, useCopy, Dropdown } from '../../common/ui';
import { OpenWithItems, appIconUrl, useOpenWithApps } from '../../common/openWith';

type Zoom = 'fit' | '25' | '50' | '100' | '150' | '200';
const ZOOM_OPTIONS = (['25', '50', '100', '150', '200'] as Zoom[]).map(v => ({ value: v, label: `${v}%` }));
import { useSessions } from '../../store/sessions';
import { useFileSearch, formatFileRef } from '../chat/InputPickers';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { usePanelWidth, ResizeHandle } from '../../common/Resizer';
import { t } from '../../i18n';
import { langOf, escapeHtml } from '../../common/text';
import { Markdown } from '../chat/Markdown';

interface FileData { path: string; abs?: string; inside?: boolean; image?: boolean; size: number; mtime: number; truncated: boolean; binary: boolean; content: string }

function isAbsPath(p: string) { return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('~'); }
/** 可预览类型：仅 markdown（html 在文件标签里只看源码，预览走右栏浏览器） */
function previewKind(p: string): 'md' | null { return /\.(md|markdown)$/i.test(p) ? 'md' : null; }
interface DirItem { name: string; isDirectory: boolean }

const MAX_HL = 200 * 1024; // 超过 200KB 不做高亮

/** 文件查看标签：面包屑 + 行号/高亮正文 + 可切换的文件树抽屉 + 「打开」菜单 */
export function FileTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const updatePanel = useApp(s => s.updatePanel);
  const revealFile = useApp(s => s.revealFile);
  const openFileExternal = useApp(s => s.openFileExternal);
  const toast = useApp(s => s.toast);
  // 草稿页面板时 sessionId 实为项目 id，回退到项目记录取目录
  const record = useApp(s => s.registry.sessions.find(x => x.id === sessionId) || s.registry.projects.find(x => x.id === sessionId));
  const rootName = record?.workingDir.split(/[\\/]/).filter(Boolean).pop() || '';
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 没有指定文件（从「+ 文件」打开）时默认展开文件树
  const [tree, setTree] = useState(!tab.path);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [treeW, setTreeW] = usePanelWidth('fileTree', 256, 160, 520);
  const relPath = tab.path || '';
  // 「打开方式」候选应用：文件切换时预取，「打开」按钮用第一个（默认应用）的图标
  const apps = useOpenWithApps(sessionId, relPath);
  const defaultApp = apps?.[0];
  // 「缩放至合适」时显示实际缩放百分比：监听图片渲染尺寸 / 原始尺寸
  const [fitPct, setFitPct] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = imgRef.current;
    if (!el || zoom !== 'fit') return;
    const update = () => { if (el.naturalWidth) setFitPct(Math.round(el.clientWidth / el.naturalWidth * 100)); };
    update();
    el.addEventListener('load', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('load', update); ro.disconnect(); };
  }, [zoom, relPath, data?.image]);

  const setPath = (p: string) => updatePanel(sessionId, s => ({ ...s, tabs: s.tabs.map(x => x.id === tab.id ? { ...x, path: p, title: p.split('/').pop() } : x) }));

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    if (!relPath) return;
    api<FileData>('POST', `/api/sessions/${sessionId}/file`, { path: relPath })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [sessionId, relPath]);

  const lines = useMemo(() => {
    if (!data || data.binary) return [];
    const src = data.content;
    const lang = langOf(relPath);
    if (src.length <= MAX_HL && lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(src, { language: lang, ignoreIllegals: true }).value.split('\n'); } catch { /* fallthrough */ }
    }
    return src.split('\n').map(escapeHtml);
  }, [data, relPath]);

  // 行定位：tab.line/lineSeq 变化且内容已加载时滚动到目标行并高亮范围
  const bodyRef = useRef<HTMLDivElement>(null);
  const hl = tab.line ? { from: tab.line, to: Math.max(tab.line, tab.endLine || tab.line) } : null;
  useEffect(() => {
    if (!hl || !data || data.binary) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(`[data-line="${hl.from}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [data, tab.lineSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 预览 / 源代码切换：可预览类型一律默认预览，切到源码只对当前标签的当前文件生效；带行号定位打开时强制源代码
  const kind = previewKind(relPath);
  const [sourceOverride, setSourceOverride] = useState<boolean | null>(null);
  useEffect(() => { setSourceOverride(null); }, [relPath, tab.lineSeq]);
  const showSource = !kind || (sourceOverride ?? !!tab.line);
  const toggleSource = () => setSourceOverride(!showSource);

  const outside = isAbsPath(relPath);
  const crumbs = relPath.split(/[\\/]/).filter(Boolean);
  // 路径过长时默认滚到最右端：文件名可见，左侧路径左右滑动查看。
  // 刚建标签 / 面板展开时容器宽度可能还是 0，此时 scrollLeft 赋值无效，用 ResizeObserver 在尺寸就绪后再吸右
  const crumbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = crumbRef.current;
    if (!el) return;
    const pin = () => { el.scrollLeft = el.scrollWidth; };
    pin();
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [relPath]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 面包屑 + 操作 */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-border text-xs">
        {/* 路径不省略、始终单行：容器可横向滚动，默认滚到最右端露出文件名（左侧路径滑动可见） */}
        <div ref={crumbRef} className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none whitespace-nowrap" title={relPath ? (outside ? `${t('file.outside')}: ${relPath}` : relPath) : undefined}>
          {/* 未选文件时显示项目名占位；目录内不重复项目名（会话顶部已可见），目录外直接从首段（如 Users）开始 */}
          {!relPath && <span className="text-muted shrink-0">{rootName}</span>}
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight size={11} className="text-muted" />}
              <span className={cn(i === crumbs.length - 1 ? 'text-fg' : 'text-muted')}>{c}</span>
            </span>
          ))}
        </div>
        <span className="flex-1" />
        {kind && data && !data.binary && (
          <button onClick={toggleSource} className="px-1.5 h-7 shrink-0 whitespace-nowrap rounded text-muted hover:text-fg hover:bg-black/[0.05]">{t(showSource ? 'file.viewPreview' : 'file.viewSource')}</button>
        )}
        {data?.image && (
          <Dropdown value={zoom} options={ZOOM_OPTIONS} onChange={setZoom} minWidth={140}
            renderValue={v => <span>{v === 'fit' ? (fitPct !== null ? `${fitPct}%` : t('file.zoomFit')) : `${v}%`}</span>}
            footer={close => (
              <button onClick={() => { setZoom('fit'); close(); }} className="w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded hover:bg-black/[0.05] text-sm">
                <span className="flex-1">{t('file.zoomFit')}</span>
                {zoom === 'fit' && <svg width="14" height="14" viewBox="0 0 24 24" className="text-ok shrink-0"><path d="M5 12l5 5L20 7" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            )} />
        )}
        <button onClick={() => setTree(v => !v)} className={cn('p-1.5 shrink-0 rounded hover:bg-black/[0.05]', tree ? 'text-fg bg-black/[0.06]' : 'text-muted hover:text-fg')} title={t('file.tree')}><FolderTree size={14} /></button>
        {/* 分体按钮：左半「打开」直接用默认程序打开；右半下拉展开更多操作 */}
        {relPath && (
          <div className="h-7 shrink-0 inline-flex items-stretch rounded-md border border-border text-fg overflow-hidden">
            <button onClick={() => openFileExternal(sessionId, relPath, defaultApp?.path).catch(e => toast(e.message, 'error'))} className="px-2 inline-flex items-center gap-1 hover:bg-black/[0.05]" title={defaultApp ? defaultApp.name : t('file.openDefault')}>
              {defaultApp?.icon ? <img src={appIconUrl(defaultApp.id)} alt="" className="w-4 h-4" /> : <ExternalLink size={12} />}{t('file.open')}
            </button>
            <button onClick={e => setMenu(e.currentTarget.getBoundingClientRect())} className="px-1 inline-flex items-center text-muted hover:text-fg hover:bg-black/[0.05]"><ChevronDown size={11} /></button>
          </div>
        )}
        <Popover anchor={menu} onClose={() => setMenu(null)} align="right">
          <OpenWithItems sessionId={sessionId} path={relPath} apps={apps} onDone={() => setMenu(null)} />
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); revealFile(sessionId, relPath).catch(e => toast(e.message, 'error')); }}>{t('file.reveal')}</MenuItem>
          {canSaveAs && <MenuItem onClick={() => { setMenu(null); saveFileAs(sessionId, relPath).catch(e => toast(e.message, 'error')); }}>{t('file.saveAs')}</MenuItem>}
        </Popover>
      </div>
      <div className="flex-1 min-h-0 flex">
        {/* 正文 */}
        <div ref={bodyRef} className="flex-1 min-w-0 overflow-auto font-mono text-[12.5px] leading-[1.6]">
          {!relPath ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2 font-sans">
              <Files size={30} className="text-fg" />
              <div className="text-base font-medium text-fg">{t('file.openTitle')}</div>
              <div className="text-sm text-muted">{t('file.openHint')}</div>
            </div>
          ) : error ? <div className="p-4 text-sm text-danger">{error}</div>
            : !data ? <div className="p-4 text-sm text-muted flex items-center gap-2"><Spinner />{t('common.loading')}</div>
            : data.image ? (
              <div className={cn('min-h-full min-w-full bg-panel font-sans flex', zoom === 'fit' ? 'h-full items-center justify-center p-4' : 'items-start justify-start p-4 w-max')}>
                <img ref={imgRef} src={`/api/sessions/${sessionId}/raw?path=${encodeURIComponent(relPath)}&token=${encodeURIComponent(getToken())}`} alt={relPath}
                  className={cn(zoom === 'fit' && 'max-w-full max-h-full object-contain')}
                  style={zoom === 'fit' ? undefined : { zoom: Number(zoom) / 100 }} />
              </div>
            )
            : data.binary ? <div className="p-4 text-sm text-muted">{t('file.binary')}</div>
            : !showSource && kind === 'md' ? <MdPreview content={data.content} sessionId={sessionId} />
            : (
              <table className="border-collapse min-w-full">
                <tbody>
                  {lines.map((html, i) => (
                    <tr key={i} data-line={i + 1} className={cn(hl && i + 1 >= hl.from && i + 1 <= hl.to && 'bg-accent/10')}>
                      <td className="select-none text-right pr-3 pl-3 text-muted/70 align-top w-1 whitespace-nowrap">{i + 1}</td>
                      <td className="pr-4 whitespace-pre align-top hljs !bg-transparent !p-0" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                    </tr>
                  ))}
                  {data.truncated && <tr><td /><td className="text-muted py-2">{t('file.truncated')}</td></tr>}
                </tbody>
              </table>
            )}
        </div>
        {/* 文件树抽屉：中缝可拖拽调宽 */}
        {tree && <>
          <ResizeHandle side="right" width={treeW} onResize={setTreeW} />
          <FileTree sessionId={sessionId} current={relPath} onPick={setPath} width={treeW} />
        </>}
      </div>
    </div>
  );
}

/** md 预览的 YAML 头（frontmatter）：只取 name / description 两个字段，其余忽略；正文剥掉整段头不再渲染 */
function parseFrontmatter(src: string): { name?: string; description?: string; body: string } {
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: src };
  const lines = m[1].split(/\r?\n/);
  const pick = (key: string) => {
    const idx = lines.findIndex(l => l.startsWith(`${key}:`));
    if (idx === -1) return undefined;
    const inline = lines[idx].slice(key.length + 1).trim();
    // 块标量：|（保留换行）或 >（折叠为空格），兼容 |- >- |+ >+ 变体
    if (/^[|>][+-]?$/.test(inline)) {
      const block: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') { block.push(''); continue; }
        if (!/^\s/.test(lines[i])) break;
        block.push(lines[i].trim());
      }
      while (block.length && !block[block.length - 1]) block.pop();
      return block.join(inline[0] === '>' ? ' ' : '\n') || undefined;
    }
    return inline.replace(/^(['"])(.*)\1$/, '$2') || undefined;
  };
  return { name: pick('name'), description: pick('description'), body: src.slice(m[0].length) };
}

/** md 预览：frontmatter 的 name/description 作为吸顶头部，正文渲染剥掉头后的内容 */
function MdPreview({ content, sessionId }: { content: string; sessionId: string }) {
  const fm = useMemo(() => parseFrontmatter(content), [content]);
  return (
    <div className="font-sans text-sm">
      {(fm.name || fm.description) && (
        <div className="sticky top-0 z-10 bg-bg border-b border-border px-4 py-2.5">
          {fm.name && <div className="font-medium text-fg truncate">{fm.name}</div>}
          {fm.description && (
            <div className="text-xs text-muted mt-0.5" title={fm.description}
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {fm.description}
            </div>
          )}
        </div>
      )}
      <div className="p-4"><Markdown text={fm.body} sessionId={sessionId} /></div>
    </div>
  );
}

function FileTree({ sessionId, current, onPick, width }: { sessionId: string; current: string; onPick: (p: string) => void; width: number }) {
  const [query, setQuery] = useState('');
  const search = useFileSearch({ sessionId }, query.trim() ? query.trim() : null);
  // 整棵树共用一个右键菜单实例，行只上报位置和路径
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const onMenu = (e: React.MouseEvent, path: string) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, path }); };
  return (
    <div className="shrink-0 border-l border-border flex flex-col text-sm" style={{ width }}>
      <div className="p-2 border-b border-border">
        <div className="h-7 flex items-center gap-1.5 px-2 rounded-md border border-border bg-panel">
          <Search size={12} className="text-muted shrink-0" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('file.filter')} className="flex-1 min-w-0 bg-transparent outline-none text-xs" />
          {query && <button onClick={() => setQuery('')} className="text-muted hover:text-fg"><X size={11} /></button>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {query.trim() ? (
          search.loading && !search.items.length ? <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Spinner />{t('common.loading')}</div>
            : search.items.filter(i => !i.isDirectory).map(i => (
              <button key={i.path} onClick={() => onPick(i.path)} onContextMenu={e => onMenu(e, i.path)} className={cn('w-full flex items-center gap-1 px-3 py-1 text-xs hover:bg-black/[0.05]', i.path === current && 'bg-accent/10 text-fg')} title={i.path}>
                <FileIcon fileName={i.path} size={14} /><span className="truncate">{i.path}</span>
              </button>
            ))
        ) : <DirNode sessionId={sessionId} path="" depth={0} current={current} onPick={onPick} onMenu={onMenu} />}
      </div>
      <FileMenu sessionId={sessionId} menu={menu} onClose={() => setMenu(null)} onPick={onPick} />
    </div>
  );
}

function DirNode({ sessionId, path, depth, current, onPick, onMenu }: {
  sessionId: string; path: string; depth: number; current: string; onPick: (p: string) => void; onMenu: (e: React.MouseEvent, path: string) => void;
}) {
  const [items, setItems] = useState<DirItem[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return; loaded.current = true;
    api<{ items: DirItem[] }>('POST', `/api/sessions/${sessionId}/ls`, { path }).then(r => setItems(r.items)).catch(() => setItems([]));
  }, [sessionId, path]);
  // 当前文件所在目录自动展开
  useEffect(() => {
    if (!current) return;
    const rel = path ? (current.startsWith(path + '/') ? current.slice(path.length + 1) : '') : current;
    const first = rel.split('/')[0];
    if (rel.includes('/') && first) setOpen(o => o[first] ? o : { ...o, [first]: true });
  }, [current, path]);
  if (!items) return <div className="px-3 py-1 text-xs text-muted" style={{ paddingLeft: 12 + depth * 12 }}>…</div>;
  return (
    <>
      {items.map(it => {
        const p = path ? `${path}/${it.name}` : it.name;
        if (it.isDirectory) {
          const isOpen = !!open[it.name];
          return (
            <div key={p}>
              <button onClick={() => setOpen(o => ({ ...o, [it.name]: !isOpen }))} className="w-full flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-black/[0.05] text-fg" style={{ paddingLeft: 8 + depth * 12 }}>
                {isOpen ? <ChevronDown size={11} className="text-muted shrink-0" /> : <ChevronRight size={11} className="text-muted shrink-0" />}
                <FileIcon fileName={it.name} isDirectory size={14} /><span className="truncate">{it.name}</span>
              </button>
              {isOpen && <DirNode sessionId={sessionId} path={p} depth={depth + 1} current={current} onPick={onPick} onMenu={onMenu} />}
            </div>
          );
        }
        return (
          <button key={p} onClick={() => onPick(p)} onContextMenu={e => onMenu(e, p)} className={cn('w-full flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-black/[0.05]', p === current ? 'bg-accent/10 text-fg' : 'text-fg/90')} style={{ paddingLeft: 8 + depth * 12 + 14 }} title={p}>
            <FileIcon fileName={it.name} size={14} /><span className="truncate">{it.name}</span>
          </button>
        );
      })}
    </>
  );
}

/** 浏览器是否支持系统「另存为」对话框（File System Access API，Chromium + secure context） */
const canSaveAs = typeof (window as any).showSaveFilePicker === 'function';

/** 另存为：走已有的读文件接口取内容再交给系统对话框；二进制不支持，超大文件按接口上限截断 */
async function saveFileAs(sessionId: string, path: string) {
  const d = await api<FileData>('POST', `/api/sessions/${sessionId}/file`, { path });
  if (d.binary) { useApp.getState().toast(t('file.saveBinary'), 'error'); return; }
  let handle: any;
  try { handle = await (window as any).showSaveFilePicker({ suggestedName: path.split(/[\\/]/).pop() || path }); }
  catch (e: any) { if (e?.name === 'AbortError') return; throw e; }
  const w = await handle.createWritable();
  await w.write(d.content);
  await w.close();
  if (d.truncated) useApp.getState().toast(t('file.savedTruncated'), 'warn');
}

/** 文件行右键菜单：打开 / 添加到聊天 / 复制路径 / 另存为 / 系统操作 */
function FileMenu({ sessionId, menu, onClose, onPick }: {
  sessionId: string; menu: { x: number; y: number; path: string } | null; onClose: () => void; onPick: (p: string) => void;
}) {
  const { copy } = useCopy();
  const path = menu?.path || '';
  // 菜单项统一走这里：先关菜单，异常统一 toast
  const run = (fn: () => void | Promise<void>) => { onClose(); Promise.resolve(fn()).catch((e: any) => useApp.getState().toast(e.message, 'error')); };

  const addToChat = () => {
    const ref = formatFileRef(path);
    useSessions.getState().setDraft(sessionId, d => ({ ...d, text: d.text.trim() ? `${d.text.replace(/\s+$/, '')} ${ref} ` : `${ref} ` }));
    useApp.getState().toast(t('file.addedToChat'));
  };

  const copyPath = (abs: boolean) => {
    const reg = useApp.getState().registry;
    const wd = (reg.sessions.find(s => s.id === sessionId) || reg.projects.find(p => p.id === sessionId))?.workingDir || '';
    copy(abs && wd ? `${wd.replace(/[\\/]$/, '')}/${path}` : path);
    useApp.getState().toast(t('file.copied'));
  };

  return (
    <Popover anchor={menu} onClose={onClose}>
      <MenuItem onClick={() => run(() => onPick(path))}>{t('file.open')}</MenuItem>
      <MenuItem onClick={() => run(addToChat)}>{t('file.addToChat')}</MenuItem>
      <MenuSep />
      <MenuItem onClick={() => run(() => copyPath(false))}>{t('file.copyPath')}</MenuItem>
      <MenuItem onClick={() => run(() => copyPath(true))}>{t('file.copyAbsPath')}</MenuItem>
      {canSaveAs && <MenuItem onClick={() => run(() => saveFileAs(sessionId, path))}>{t('file.saveAs')}</MenuItem>}
      <MenuSep />
      <MenuItem onClick={() => run(() => useApp.getState().openFileExternal(sessionId, path))}>{t('file.openDefault')}</MenuItem>
      <MenuItem onClick={() => run(() => useApp.getState().revealFile(sessionId, path))}>{t('file.reveal')}</MenuItem>
    </Popover>
  );
}

