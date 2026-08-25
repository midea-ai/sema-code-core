import React, { memo, useState, useMemo, useRef, useLayoutEffect, useEffect } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Check, Copy, X, Undo2, Bot, Pencil, Search, ListTodo, Terminal, FileText, FileDiff, Wrench, AlertTriangle, Info, CircleDot, Globe, Clock, GitBranch, Images } from 'lucide-react';
import type { Block, ToolBlock, PermissionBlock, NoticeBlock, FileChangesBlock, UserBlock, AssistantBlock, TodosBlock, CronBlock, BranchOriginBlock } from '../../../../shared/types';
import { CRON_TOOLS } from '../../../../shared/protocol';
import { Markdown } from './Markdown';
import { DiffView, CodeView, Collapsible } from './DiffView';
import { PickCard } from './PickCard';
import { AgentCard } from './AgentCard';
import { PlanExitCard, PlanImplementCard } from './PlanCards';
import { ImageThumb } from './ImagePreview';
import { Button, cn, Spinner, useCopy, Popover, MenuSep } from '../../common/ui';
import { OpenWithItems, useOpenWithApps } from '../../common/openWith';
import { api, getToken } from '../../api/http';
import { contentToString, toolDisplayName, stripAnsi, fmtTime } from '../../common/text';
import { extractLocalUrls, normalizeUrl } from '../../common/url';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { t } from '../../i18n';

export interface BlockCtx {
  sessionId: string;
  onRewind?: (inputId: string) => void;
  /** 置于子智能体详情页内：嵌套的 agent 卡片不自动打开右侧标签 */
  noAutoOpenAgent?: boolean;
}

// ==================== 分发 ====================

export const BlockRenderer = memo(function BlockRenderer({ block, ctx }: { block: Block; ctx: BlockCtx }) {
  switch (block.kind) {
    case 'user': return <UserBubble block={block} ctx={ctx} />;
    case 'assistant': return <AssistantMsg block={block} ctx={ctx} />;
    // 定时任务增删成功后由 CronCard 展示，工具行不再重复（失败仍显示工具行以便看报错）
    case 'tool': return CRON_TOOLS.has(block.toolName) && block.status === 'done' ? null : <ToolCard block={block} ctx={ctx} />;
    case 'permission': return <PermissionCard block={block} ctx={ctx} />;
    case 'pick': return <PickCard block={block} ctx={ctx} />;
    case 'plan-exit': return <PlanExitCard block={block} ctx={ctx} />;
    case 'todos': return <TodosCard block={block} />;
    case 'agent': return <AgentCard block={block} ctx={ctx} />;
    case 'branch-origin': return <BranchOrigin block={block} />;
    case 'notice': return block.noticeType === 'plan-implement' ? <PlanImplementCard block={block} ctx={ctx} /> : <NoticeBar block={block} />;
    case 'file-changes': return <FileChangesCard block={block} ctx={ctx} />;
    case 'cron': return <CronCard block={block} ctx={ctx} />;
    default: return null;
  }
});

/** 分支来源边界：固定在继承历史之后，点击返回原聊天。 */
function BranchOrigin({ block }: { block: BranchOriginBlock }) {
  const source = useApp(s => s.registry.sessions.find(x => x.id === block.sourceSessionId));
  const setView = useApp(s => s.setView);
  const available = !!source;
  return (
    <div className="my-5 flex items-center gap-3 text-sm">
      <span className="h-px flex-1 bg-border" />
      <button
        type="button"
        disabled={!available}
        onClick={() => available && setView({ type: 'chat', sessionId: block.sourceSessionId })}
        className={cn('inline-flex items-center gap-2 font-medium', available ? 'text-accent hover:underline underline-offset-2' : 'text-muted cursor-default')}
        title={available ? `打开原聊天：${source.title || block.sourceTitle}` : t('chat.branchSourceDeleted')}
      >
        <GitBranch size={16} />
        <span>{available ? t('chat.branchFrom') : t('chat.branchSourceDeleted')}</span>
      </button>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ==================== 用户 ====================

// 用户消息折叠高度：14px 字号 × 1.5 行高 × 8 行
const USER_COLLAPSED_MAX = 168;

function UserBubble({ block, ctx }: { block: UserBlock; ctx: BlockCtx }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // 测量是否超过折叠高度（scrollHeight 不受 max-height 影响，两态一致）
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > USER_COLLAPSED_MAX + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [block.text]);
  const collapsed = overflowing && !expanded;
  return (
    <div className="group flex justify-end user-sticky pt-3 pb-1 mb-2">
      <div className="max-w-[80%] flex flex-col items-end gap-1">
        {block.source === 'cron' && (
          <button onClick={() => useApp.getState().openCronTab(ctx.sessionId)} className="flex items-center gap-1 text-xs text-muted hover:text-fg hover:underline underline-offset-2" title={t('panel.cron')}>
            <Clock size={12} />{t('chat.sourceCron')}
          </button>
        )}
        {block.attachments && block.attachments.length > 0 && (
          <div className="flex gap-1.5 flex-wrap justify-end">
            {block.attachments.map((a, i) => a.dataUrl
              ? <ImageThumb key={i} src={a.dataUrl} className="h-20 w-20" />
              : <div key={i} className="h-10 px-2 rounded-md border border-border text-xs text-muted flex items-center">图片</div>)}
          </div>
        )}
        <div className={cn('rounded-2xl px-4 py-2 bg-panel', block.queued && 'opacity-60')}>
          <div ref={textRef} className={cn('whitespace-pre-wrap break-words', collapsed && 'overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]')} style={collapsed ? { maxHeight: USER_COLLAPSED_MAX } : undefined}>
            {block.text}
            {block.queued && <span className="ml-2 text-xs text-muted">{t('chat.queued')}</span>}
          </div>
          {overflowing && (
            <button onClick={() => setExpanded(v => !v)} className="mt-1 text-xs text-muted hover:text-fg">
              {expanded ? t('chat.collapse') : t('chat.expand')}
            </button>
          )}
        </div>
        <UserBubbleBar block={block} ctx={ctx} />
      </div>
    </div>
  );
}

/** 用户消息悬浮工具栏：时间 · 复制 · 回退 */
function UserBubbleBar({ block, ctx }: { block: UserBlock; ctx: BlockCtx }) {
  const { copied, copy } = useCopy();
  const time = useMemo(() => fmtTime(block.ts), [block.ts]);
  const btn = 'text-muted hover:text-fg inline-flex items-center p-0.5 rounded';
  return (
    <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-1.5 text-[11px] text-muted">
      <span>{time}</span>
      <button className={btn} title={t(copied ? 'common.copied' : 'common.copy')} onClick={() => copy(block.text)}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {block.inputId && ctx.onRewind && (
        <button className={btn} title={t('chat.rewindHere')} onClick={() => ctx.onRewind!(block.inputId!)}>
          <Undo2 size={12} />
        </button>
      )}
    </div>
  );
}

// ==================== AI 文本 ====================

function AssistantMsg({ block, ctx }: { block: AssistantBlock; ctx: BlockCtx }) {
  // 思考内容不渲染；无正文的块（纯思考）不占位
  if (!block.text) return null;
  return (
    <div className="my-3">
      <Markdown text={block.text} sessionId={ctx.sessionId} done={block.done} />
    </div>
  );
}

// ==================== 网站卡片（本轮新建/修改了 html 文件） ====================

export const HTML_RE = /\.html?$/i;

/** 从本轮 file-changes 块中提取 html 文件（去重、保持顺序） */
export function htmlFilesOf(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.kind === 'file-changes') for (const f of b.files) if (HTML_RE.test(f.path) && !out.includes(f.path)) out.push(f.path);
  return out;
}

/**
 * 网站卡片：标题取页面 <title>（没有则文件名），默认在右栏浏览器打开（SemaWork），下拉可选系统应用（与文件标签「打开方式」同源）。
 */
export function HtmlSiteCard({ sessionId, path }: { sessionId: string; path: string }) {
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === sessionId)?.workingDir || '');
  const abs = absPathOf(path, workingDir);
  const fileUrl = normalizeUrl(abs);
  const [meta, setMeta] = useState<{ title: string } | null>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const apps = useOpenWithApps(sessionId, path);
  useEffect(() => {
    let alive = true;
    api<{ title: string }>('POST', '/api/page-meta', { url: fileUrl }).then(r => { if (alive) setMeta(r); }).catch(() => { if (alive) setMeta({ title: '' }); });
    return () => { alive = false; };
  }, [fileUrl]);
  const name = path.split(/[\\/]/).pop() || path;
  const openInSema = () => { setMenu(null); useApp.getState().openBrowserTab(sessionId, fileUrl); };
  return (
    <div className="my-3 rounded-xl border border-border bg-white text-sm">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="h-9 w-9 rounded-lg bg-panel flex items-center justify-center shrink-0"><Globe size={16} className="text-fg" /></span>
        <div className="flex-1 min-w-0 cursor-pointer" onClick={openInSema} title={abs}>
          <div className="font-medium truncate">{meta?.title || name}</div>
          <div className="text-xs text-muted truncate">{meta?.title ? name : t('card.site')}</div>
        </div>
        {/* 分体按钮：左半「打开方式」= 默认项（右栏浏览器），右半箭头才展开下拉（与文件标签顶栏一致） */}
        <div className="h-7 inline-flex items-stretch rounded-md border border-border text-fg overflow-hidden text-xs">
          <button onClick={openInSema} className="px-2 inline-flex items-center hover:bg-black/[0.05]" title="SemaWork">{t('card.openWith')}</button>
          <button onClick={e => setMenu(e.currentTarget.getBoundingClientRect())} className="px-1 inline-flex items-center text-muted hover:text-fg hover:bg-black/[0.05]"><ChevronDown size={11} /></button>
        </div>
        <Popover anchor={menu} onClose={() => setMenu(null)} align="right">
          <button onClick={openInSema} className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded hover:bg-black/[0.06] text-sm text-fg">
            <img src="/icon.svg" alt="" className="w-5 h-5 shrink-0" />
            <span className="truncate">SemaWork</span>
          </button>
          <MenuSep />
          <OpenWithItems sessionId={sessionId} path={path} apps={apps} onDone={() => setMenu(null)} />
        </Popover>
      </div>
    </div>
  );
}

// ==================== 工具卡片 ====================

function isDiffContent(c: any): c is { type: 'diff' | 'new'; patch: any[] } {
  return !!c && typeof c === 'object' && Array.isArray(c.patch);
}

/** 工具行动词：已运行 / 已创建 / 已编辑 / 已读取 … */
function toolVerb(block: ToolBlock, diff: { type: 'diff' | 'new' } | null): string {
  const running = block.status === 'running';
  const n = block.toolName;
  if (n === 'run_shell') return running ? '正在运行' : '已运行';
  if (n === 'write_file' && diff?.type === 'new') return running ? '正在创建' : '已创建';
  if (n === 'write_file' || n === 'patch_file' || n === 'edit_notebook') return running ? '正在编辑' : '已编辑';
  if (n === 'view_file') return running ? '正在读取' : '已读取';
  if (n === 'search_files' || n === 'search_content') return running ? '正在搜索' : '已搜索';
  if (n === 'fetch_url') return running ? '正在抓取' : '已抓取';
  if (n === 'sub_agent') return running ? '正在调用子代理' : '已调用子代理';
  if (n === 'skill') return running ? '正在使用技能' : '已使用技能';
  if (n === 'ask_form') return running ? '等待用户回应' : '用户已回应';
  if (n === 'peek_bg_job') return running ? '正在启动后台任务' : '已启动后台任务';
  if (n === 'stop_bg_job') return running ? '正在停止后台任务' : '已停止后台任务';
  return `${running ? '正在调用' : '已调用'} ${toolDisplayName(n)}`;
}

const FILE_TOOLS = new Set(['view_file', 'write_file', 'patch_file', 'edit_notebook']);
/** view_file 标题形如 `a/b.ts:10-20`，去掉行号后缀得到可打开的路径 */
function filePathOf(block: ToolBlock, workingDir = ''): string | null {
  if (!FILE_TOOLS.has(block.toolName)) return null;
  let p = String(block.title || block.input?.file_path || '').replace(/:\d+(-\d+)?$/, '');
  if (workingDir && (p.startsWith(workingDir + '/') || p.startsWith(workingDir + '\\'))) p = p.slice(workingDir.length + 1);
  return p || null;
}
function absPathOf(rel: string, workingDir: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel;
  return workingDir ? `${workingDir}/${rel}` : rel;
}

/** 搜索类工具整行文案：已在 . 中搜索“pattern” / 正在 . 中查找文件“pattern” */
function searchLabel(block: ToolBlock, running: boolean): string {
  // 无 input（旧记录）时从标题 `pattern: "x" glob: "y" path: "z"` 里解析
  const m = (k: string) => block.title?.match(new RegExp(`${k}: "([^"]*)"`))?.[1];
  const dir = String(block.input?.path || m('path') || '.');
  const pattern = block.input?.pattern ?? m('pattern');
  const pat = pattern ? `“${pattern}”` : '';
  const verb = block.toolName === 'search_files' ? '查找文件' : '搜索';
  return `${running ? '正在' : '已在'} ${dir} 中${verb}${pat}`;
}

function toolIcon(n: string): any {
  return n === 'run_shell' ? Terminal : (n === 'search_files' || n === 'search_content') ? Search : n === 'view_file' ? FileText : FILE_TOOLS.has(n) ? Pencil : n === 'fetch_url' ? Globe : n === 'sub_agent' ? Bot : Wrench;
}

/** 工具单行摘要（动词 + 目标 + 增删统计）：live 工具组组头用，文案规则与工具行一致 */
function ToolSummary({ block }: { block: ToolBlock }) {
  const n = block.toolName;
  const diff = isDiffContent(block.content) ? block.content : null;
  if (n === 'search_files' || n === 'search_content') return <span className="truncate">{searchLabel(block, block.status === 'running')}</span>;
  const isGeneric = n.startsWith('mcp__') || n === 'ask_form';
  const target = isGeneric ? '' : n === 'view_file' ? (filePathOf(block)?.split('/').pop() || '') : (block.title && block.title !== n ? block.title : '');
  return (
    <>
      <span className="shrink-0">{toolVerb(block, diff)}</span>
      {target && <span className={cn('truncate', n === 'run_shell' && 'font-mono text-[12.5px]')}>{target}</span>}
      {diff && EDIT_TOOLS.has(n) && <DiffStat patch={diff.patch} />}
    </>
  );
}

/** 单个工具：一行摘要（图标 + 动词 + 目标 + 增删统计），点击展开详情 */
function ToolCard({ block, ctx }: { block: ToolBlock; ctx: BlockCtx }) {
  const isShell = block.toolName === 'run_shell';
  /** 子代理调用行：详情看 AgentCard/右侧标签，此行不可展开 */
  const isAgentCall = block.toolName === 'sub_agent';
  const isEdit = block.toolName === 'write_file' || block.toolName === 'patch_file' || block.toolName === 'edit_notebook';
  const isRead = block.toolName === 'view_file';
  const isSearch = block.toolName === 'search_files' || block.toolName === 'search_content';
  /** MCP 工具：行内只显示「已调用 server · tool」，标题/摘要/内容都放展开区 */
  const isGeneric = block.toolName.startsWith('mcp__') || block.toolName === 'ask_form';
  const [open, setOpen] = useState(false);
  const openBrowserTab = useApp(s => s.openBrowserTab);

  const bodyText = useMemo(() => {
    const parts: string[] = [];
    if (block.output) parts.push(stripAnsi(block.output));
    if (block.content !== undefined && !isDiffContent(block.content)) {
      const s = stripAnsi(contentToString(block.content));
      if (s && s !== block.output) parts.push(s);
    }
    return parts.join('\n');
  }, [block.output, block.content]);
  const localUrls = useMemo(() => (isShell || block.status === 'done') ? extractLocalUrls(bodyText).slice(0, 3) : [], [bodyText, isShell, block.status]);
  const diff = isDiffContent(block.content) ? block.content : null;
  const Icon = toolIcon(block.toolName);
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === ctx.sessionId)?.workingDir || '');
  const filePath = filePathOf(block, workingDir);
  const openFileRef = useApp(s => s.openFileRef);
  /** view_file 读图片文件：行为改为可展开，展开区显示缩略图（点击放大预览） */
  const isImageRead = isRead && !!filePath && /\.(png|jpe?g|gif|webp)$/i.test(filePath);
  const expandable = !isSearch && !isAgentCall && (!isRead || isImageRead);

  return (
    <div className="my-0.5 text-[13px] text-dim">
      {/* 整行灰色；读取文件：点文件名在右侧栏打开（读图片行可展开缩略图）；搜索：不可点击；其余点击展开详情 */}
      <div onClick={() => expandable && setOpen(v => !v)} className={cn('w-full flex items-center gap-2 py-0.5 text-left', expandable && 'cursor-pointer')} title={expandable && !isRead ? block.title : undefined}>
        {block.status === 'running' ? <Spinner className="h-3.5 w-3.5 shrink-0" /> : block.status === 'error' ? <X size={14} className="text-danger shrink-0" /> : <Icon size={14} className="shrink-0" />}
        {isSearch ? <span className="truncate">{searchLabel(block, block.status === 'running')}</span> : <span className="shrink-0">{toolVerb(block, diff)}</span>}
        {isSearch || isGeneric ? null : filePath
          ? <span onClick={e => { e.stopPropagation(); openFileRef(ctx.sessionId, filePath); }} className="truncate underline decoration-border underline-offset-2 cursor-pointer hover:text-fg hover:decoration-fg" title={absPathOf(filePath, workingDir)}>{isRead ? filePath.split('/').pop() : block.title}</span>
          : <span className={cn('truncate', isShell && 'font-mono text-[12.5px]')}>{block.title}</span>}
        {block.summary && !isShell && !isEdit && !isRead && !isSearch && !isGeneric && <span className="text-xs truncate max-w-[40%]">{block.summary}</span>}
        {isEdit && diff && <DiffStat patch={diff.patch} />}
      </div>
      {localUrls.length > 0 && (
        <div className="pl-6 pb-1 flex gap-1.5 flex-wrap">
          {localUrls.map(u => (
            <button key={u} onClick={() => openBrowserTab(ctx.sessionId, u)} className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-accent/10 border border-accent/20 text-xs text-accent hover:bg-accent/15">
              <Globe size={11} /> {u}
            </button>
          ))}
        </div>
      )}
      {open && expandable && (
        <div className="pl-6 py-1">
          {isShell && block.summary && <div className="text-xs text-muted mb-1.5">{block.summary}</div>}
          {isGeneric && block.title && block.title !== block.toolName && block.toolName !== 'ask_form' && <div className="text-xs text-muted mb-1 break-all">{block.title}</div>}
          {isGeneric && block.summary && <div className="text-xs text-muted mb-1.5">{block.summary}</div>}
          {isImageRead ? (
            <ImageThumb src={`/api/sessions/${ctx.sessionId}/raw?path=${encodeURIComponent(filePath!)}&token=${encodeURIComponent(getToken())}`} className="h-20 w-20" />
          ) : diff ? <DiffView patch={diff.patch} path={block.title} sessionId={ctx.sessionId} maxLines={400} collapsible /> : (
            bodyText ? (
              <Collapsible deps={bodyText} className="rounded-md bg-code border border-border overflow-hidden">
                <pre className={cn('font-mono text-[12px] leading-5 whitespace-pre-wrap break-words p-2', block.status === 'error' && 'text-danger')}>{bodyText.length > 20000 ? bodyText.slice(-20000) : bodyText}</pre>
              </Collapsible>
            )
              : <div className="text-xs text-muted">{block.status === 'running' ? t('card.running') : '(无输出)'}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 连续的 view_file 读图片合并为一行「已查看 x 张图片」，展开显示缩略图（与输入气泡同规格，点击放大） */
function ImageReadCard({ blocks, ctx }: { blocks: ToolBlock[]; ctx: BlockCtx }) {
  const [open, setOpen] = useState(false);
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === ctx.sessionId)?.workingDir || '');
  const running = blocks.some(b => b.status === 'running');
  const paths = blocks.map(b => filePathOf(b, workingDir)).filter((p): p is string => !!p);
  return (
    <div className="my-0.5 text-[13px] text-dim">
      <button onClick={() => setOpen(v => !v)} className="flex items-center gap-2 py-0.5 text-left cursor-pointer hover:text-fg">
        {running ? <Spinner className="h-3.5 w-3.5 shrink-0" /> : <Images size={14} className="shrink-0" />}
        <span>{running ? '正在查看图片' : `已查看 ${paths.length} 张图片`}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="pl-6 py-1 flex gap-2 flex-wrap">
          {paths.map((p, i) => (
            <ImageThumb key={`${i}:${p}`} src={`/api/sessions/${ctx.sessionId}/raw?path=${encodeURIComponent(p)}&token=${encodeURIComponent(getToken())}`} className="h-20 w-20" />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 工具组（连续多个工具调用折叠为一组） ====================

const EDIT_TOOLS = new Set(['write_file', 'patch_file', 'edit_notebook']);

/** view_file 读图片文件的工具块：单独走「已查看 x 张图片」卡片，不进普通工具行/工具组 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
function isImageReadBlock(b: Block): b is ToolBlock {
  return b.kind === 'tool' && b.toolName === 'view_file'
    && IMAGE_EXT_RE.test(String(b.title || b.input?.file_path || '').replace(/:\d+(-\d+)?$/, ''));
}

/** 可并入工具组的块：工具本身（读图片除外）、已放行的权限卡（本就不渲染）、自动放行提示 */
export function isToolGroupable(b: Block): boolean {
  if (b.kind === 'tool') return !isImageReadBlock(b);
  if (b.kind === 'assistant') return !b.text; // 纯思考块不渲染，不打断分组
  if (b.kind === 'permission') return !!b.resolved && b.resolved !== 'refuse' && b.resolved !== '__interrupted';
  if (b.kind === 'notice') return b.noticeType === 'auto-permission';
  return false;
}

/** 渲染块列表：连续 ≥2 个工具调用（中间无文字）合并为一个可折叠组；live=运行中（组头显示最后一个工具的摘要） */
export function renderBlockList(blocks: Block[], ctx: BlockCtx, live = false) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length;) {
    // 连续的读图片块合并为一张「已查看 x 张图片」卡片
    if (isImageReadBlock(blocks[i])) {
      let j = i;
      while (j < blocks.length && isImageReadBlock(blocks[j])) j++;
      out.push(<ImageReadCard key={blocks[i].id} blocks={blocks.slice(i, j) as ToolBlock[]} ctx={ctx} />);
      i = j; continue;
    }
    if (!isToolGroupable(blocks[i])) { out.push(<BlockRenderer key={blocks[i].id} block={blocks[i]} ctx={ctx} />); i++; continue; }
    let j = i;
    while (j < blocks.length && isToolGroupable(blocks[j])) j++;
    const run = blocks.slice(i, j);
    if (run.filter(b => b.kind === 'tool').length >= 2) {
      // 组头是否仍在增长：只有其后再无新文字/工具调用（真正的末尾组）才用「最后一个工具」当标题，否则回退为整体描述
      const isTailGroup = !blocks.slice(j).some(b => b.kind === 'tool' || (b.kind === 'assistant' && !!b.text));
      out.push(<ToolGroup key={`group:${run[0].id}`} blocks={run} ctx={ctx} live={live && isTailGroup} />);
    } else run.forEach(b => out.push(<BlockRenderer key={b.id} block={b} ctx={ctx} />));
    i = j;
  }
  return out;
}

/** live：组头显示最后一个工具的单行摘要（随新工具加入自动更新）；结束后组头为类别文案。两种模式都默认折叠，点开内容一致 */
function ToolGroup({ blocks, ctx, live }: { blocks: Block[]; ctx: BlockCtx; live?: boolean }) {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === 'tool');
  const hasEdit = tools.some(b => EDIT_TOOLS.has(b.toolName));
  const hasShell = tools.some(b => b.toolName === 'run_shell');
  const hasRead = tools.some(b => b.toolName === 'view_file' || b.toolName === 'search_files' || b.toolName === 'search_content');
  // 默认折叠；用户点过则以手动为准
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? false;
  const last = tools[tools.length - 1];
  const label = [hasEdit && t('card.groupEdited'), hasShell && t('card.groupRan'), hasRead && t('card.groupRead')].filter(Boolean).join(' ') || t('card.groupTools');
  const Icon = live ? toolIcon(last.toolName) : hasEdit ? Pencil : hasShell ? Terminal : hasRead ? Search : Wrench;
  return (
    <div className="my-1.5 text-[13px]">
      <button onClick={() => setManual(!open)} className="group w-full flex items-center gap-2 py-0.5 text-left text-dim hover:text-fg">
        {live && last.status === 'running' ? <Spinner className="h-3.5 w-3.5 shrink-0" /> : live && last.status === 'error' ? <X size={14} className="text-danger shrink-0" /> : <Icon size={14} className="shrink-0" />}
        {live ? <ToolSummary block={last} /> : <span>{label}</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} className="opacity-0 group-hover:opacity-100" />}
      </button>
      {open && <div>{blocks.map(b => <BlockRenderer key={b.id} block={b} ctx={ctx} />)}</div>}
    </div>
  );
}

function DiffStat({ patch, additions, removals }: { patch?: any[]; additions?: number; removals?: number }) {
  let a = additions ?? 0, r = removals ?? 0;
  if (patch) for (const h of patch) {
    let ha = 0;
    for (const l of h.lines || []) { if (l[0] === '+') ha++; else if (l[0] === '-') r++; }
    // 新建文件的预览 hunk 只带前几行，按 newLines 计
    a += h.oldLines === 0 && h.newLines > ha ? h.newLines : ha;
  }
  return <span className="text-xs font-mono shrink-0"><span className="text-ok">+{a}</span> <span className="text-danger">-{r}</span></span>;
}

// ==================== 权限卡片 ====================

/** 权限卡标题里的工具类别文案 */
function permissionKind(n: string): string {
  if (n === 'run_shell') return '终端Shell';
  if (n === 'write_file' || n === 'patch_file' || n === 'edit_notebook') return '文件编辑';
  if (n === 'view_file') return '文件读取';
  if (n === 'fetch_url') return '网页访问';
  if (n === 'skill') return '技能';
  if (n.startsWith('mcp__')) return `MCP 工具 ${toolDisplayName(n)}`;
  return toolDisplayName(n);
}

function PermissionCard({ block, ctx }: { block: PermissionBlock; ctx: BlockCtx }) {
  const respond = useSessions(s => s.respondPermission);
  const [busy, setBusy] = useState(false);
  const diff = isDiffContent(block.content) ? block.content : null;
  const isShell = block.toolName === 'run_shell';
  /** 子代理调用行：详情看 AgentCard/右侧标签，此行不可展开 */
  const isAgentCall = block.toolName === 'sub_agent';
  /** 技能：名字放标题行（权限请求 · 技能 xlsx-pricing），正文只放说明 */
  const titleInHeader = block.toolName === 'skill';
  const resolved = block.resolved;
  const optionKeys = Object.keys(block.options || {});
  // 优先用 core 给的选项文案（带具体命令/前缀说明），缺失时回退 i18n
  const label = (k: string) => block.options[k] || (k === 'agree' ? t('card.agree') : k === 'allow' ? t('card.allow') : k === 'refuse' ? t('card.refuse') : k);

  const onPick = async (k: string) => {
    setBusy(true);
    try { await respond(ctx.sessionId, block.id, block.toolName, k); } finally { setBusy(false); }
  };
  // 已同意/放行的请求不再占位（后面紧跟工具卡片）；只有拒绝或被中断的保留在消息流里
  if (resolved && resolved !== 'refuse' && resolved !== '__interrupted') return null;

  return (
    <div className={cn('my-2 rounded-lg border text-sm', resolved ? 'border-border bg-panel-2' : 'border-warn/50 bg-warn/5')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <CircleDot size={14} className={resolved ? 'text-muted' : 'text-warn'} />
        <span className="font-medium">{t('card.permissionTitle')}</span>
        <span className="text-muted truncate">· {permissionKind(block.toolName)}{titleInHeader && <> <span className="text-fg">{block.title}</span></>}</span>
        {block.agentId !== 'main' && <span className="text-[10px] px-1 rounded bg-black/[0.07] text-muted">{t('card.subagent')}</span>}
        <span className="flex-1" />
        {resolved && (
          <span className={cn('text-xs inline-flex items-center gap-1', resolved === 'refuse' || resolved === '__interrupted' ? 'text-danger' : 'text-ok')}>
            {resolved === '__interrupted' ? <><X size={12} />{t('card.interrupted')}</> : resolved === 'refuse' ? <><X size={12} />{t('card.refuse')}</> : <><Check size={12} />{label(resolved)}</>}
          </span>
        )}
      </div>
      <div className="px-3 pb-2">
        {isShell ? <CodeView code={block.title} className="mb-2" /> : titleInHeader ? null : <div className="mb-2 break-all font-medium">{block.title}</div>}
        {diff ? <DiffView patch={diff.patch} path={block.title} maxLines={resolved ? 40 : 300} collapsible={!!resolved} />
          : (typeof block.content === 'string' && block.content && block.content !== block.title)
            ? <Collapsible deps={block.content} className="rounded-md bg-code border border-border overflow-hidden"><pre className="font-mono text-[12px] leading-5 text-muted whitespace-pre-wrap break-words p-2">{block.content}</pre></Collapsible>
            : (block.content && typeof block.content === 'object')
              ? <Collapsible deps={block.content} className="rounded-md bg-code border border-border overflow-hidden"><pre className="font-mono text-[12px] leading-5 text-muted whitespace-pre-wrap break-words p-2">{contentToString(block.content)}</pre></Collapsible> : null}
        {!resolved && (
          <div className="flex gap-2 mt-3 flex-wrap">
            {optionKeys.map(k => (
              <Button key={k} disabled={busy} size="sm" variant={k === 'agree' ? 'primary' : k === 'refuse' ? 'danger' : 'outline'} onClick={() => onPick(k)} title={block.options[k]}>
                {label(k)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== 待办 ====================

function TodosCard({ block }: { block: TodosBlock }) {
  const [open, setOpen] = useState(false);
  const items = block.todos || [];
  const doneCount = items.filter((x: any) => x.status === 'completed' || x.status === 'done').length;
  return (
    <div className="my-1.5 text-[13px]">
      <button onClick={() => setOpen(v => !v)} className="group flex items-center gap-2 py-0.5 text-dim hover:text-fg">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t('card.todos')} {doneCount}/{items.length}</span>
      </button>
      {open && (
        <ul className="pl-1 pt-0.5 flex flex-col">
          {items.map((it: any, i: number) => {
            const st = it.status;
            const isDone = st === 'completed' || st === 'done';
            const active = st === 'in_progress' || st === 'running' || st === 'processing';
            const text = active && it.progressText ? it.progressText : (it.title ?? it.content ?? it.subject ?? JSON.stringify(it));
            return (
              <li key={it.id ?? i} className={cn('flex items-start gap-2 py-0.5 leading-5', isDone ? 'text-muted line-through' : active ? 'text-fg' : 'text-dim')}>
                <span className="w-4 shrink-0 flex items-center justify-center h-5">
                  {isDone ? <Check size={13} className="text-ok" />
                    : active ? <span className="h-3 w-3 rounded-full border-[1.5px] border-ok" style={{ background: 'linear-gradient(to right, var(--color-ok) 50%, transparent 50%)' }} />
                      : <span className="h-3 w-3 rounded-full border-[1.5px] border-current opacity-70" />}
                </span>
                <span className="break-words">{text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ==================== 提示条 ====================

function NoticeBar({ block }: { block: NoticeBlock }) {
  const subtle = block.noticeType === 'compact-micro';
  const Icon = block.level === 'error' ? X : block.level === 'warn' ? AlertTriangle : Info;
  const [open, setOpen] = useState(false);
  // 模型自动放行提示不展示（工具行本身已足够）
  if (block.noticeType === 'auto-permission') return null;
  if (subtle) return <div className="my-1 text-[11px] text-muted/80 pl-1">· {block.text}{block.detail ? ` (${block.detail})` : ''}</div>;
  return (
    <div className={cn('my-2 rounded-md border px-3 py-1.5 text-xs flex items-start gap-2',
      block.level === 'error' ? 'border-danger/40 bg-danger/10 text-fg' : block.level === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-border bg-white text-muted')}>
      <Icon size={13} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="whitespace-pre-wrap break-words">{block.text}</div>
        {block.detail && (
          <>
            <button onClick={() => setOpen(v => !v)} className="text-muted hover:text-fg mt-0.5">{open ? t('card.collapse') : '详情'}</button>
            {open && <pre className="mt-1 whitespace-pre-wrap max-h-60 overflow-auto text-muted">{block.detail}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

// ==================== 定时任务卡片 ====================

function CronCard({ block, ctx }: { block: CronBlock; ctx: BlockCtx }) {
  const openCron = () => useApp.getState().openCronTab(ctx.sessionId, block.action === 'create' ? block.taskId : undefined);
  const name = block.title || block.taskId;
  return (
    <div className="my-3 rounded-xl border border-border bg-white text-sm">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="h-9 w-9 rounded-lg bg-panel flex items-center justify-center shrink-0"><Clock size={16} className="text-fg" /></span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{t(block.action === 'create' ? 'card.cronCreated' : 'card.cronDeleted')}</div>
          <div className="text-xs text-muted truncate" title={name}>{name}{block.schedule ? ` · ${block.schedule}` : ''}</div>
        </div>
        <Button size="sm" variant="outline" onClick={openCron}>{t('card.cronOpen')}</Button>
      </div>
    </div>
  );
}

// ==================== 文件改动卡片 ====================

function FileChangesCard({ block, ctx }: { block: FileChangesBlock; ctx: BlockCtx }) {
  const PREVIEW = 3;
  const [showAll, setShowAll] = useState(false);
  const files = block.files;
  const total = files.reduce((acc, f) => ({ a: acc.a + f.additions, r: acc.r + f.removals }), { a: 0, r: 0 });
  const shown = showAll ? files : files.slice(0, PREVIEW);
  const rest = files.length - PREVIEW;
  const openReview = (path?: string) => useApp.getState().openReviewTab(ctx.sessionId, block.id, path);
  const splitPath = (p: string) => { const i = p.lastIndexOf('/'); return i >= 0 ? [p.slice(0, i + 1), p.slice(i + 1)] : ['', p]; };
  return (
    <div className="my-3 rounded-xl border border-border bg-white text-sm">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="h-9 w-9 rounded-lg bg-panel flex items-center justify-center shrink-0"><FileDiff size={16} className="text-fg" /></span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{t('card.filesEdited', { n: files.length })}</div>
          <div className="text-xs font-mono"><span className="text-ok">+{total.a}</span> <span className="text-danger">-{total.r}</span></div>
        </div>
        {block.inputId && ctx.onRewind && <Button size="sm" variant="ghost" onClick={() => ctx.onRewind!(block.inputId!)}>{t('card.undo')} <Undo2 size={13} /></Button>}
        <Button size="sm" variant="outline" onClick={() => openReview()}>{t('card.review')}</Button>
      </div>
      <ul className="border-t border-border px-1 py-1">
        {shown.map(f => {
          const [dir, base] = splitPath(f.path);
          return (
            <li key={f.path}>
              <div className="flex items-center gap-2 px-2 h-8 rounded-md hover:bg-black/[0.04] cursor-pointer" onClick={() => openReview(f.path)} title={f.path}>
                <span className="truncate flex-1 text-[13px]"><span className="text-muted">{dir}</span><span className="text-fg">{base}</span></span>
                <DiffStat additions={f.additions} removals={f.removals} />
              </div>
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <button onClick={() => setShowAll(v => !v)} className="w-full flex items-center gap-1.5 px-3 h-9 border-t border-border text-[13px] font-medium hover:bg-black/[0.03] rounded-b-xl">
          {showAll ? t('card.collapseFiles') : t('card.moreFiles', { n: rest })} {showAll ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
    </div>
  );
}
