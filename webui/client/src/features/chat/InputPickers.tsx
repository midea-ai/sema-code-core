/**
 * 输入框辅助弹层：@ 文件选择器 / 斜杠命令面板（键盘驱动：↑↓ 选择、Tab/Enter 补全、Esc 关闭）。
 * 触发判定、文本补全格式与数据加载 hook 都在这里；Composer 只负责接键盘事件与改写 textarea 文本。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { cn } from '../../common/ui';
import { t } from '../../i18n';
import type { CommandsInfo, FileSearchItem, SlashItem } from '../../../../shared/types';

// ==================== 触发判定 ====================

/** @ 引用的边界字符：与 core util/fileReference 的解析正则一致（空白 + 中英文标点） */
const AT_BOUNDARY = /[\s。，、；：！？“”‘’「」『』（）《》〈〉【】,;!?]/;
const isBoundary = (ch: string | undefined) => ch === undefined || ch === '' || AT_BOUNDARY.test(ch);

export interface AtTrigger { kind: 'file'; start: number; end: number; query: string }
export interface SlashTrigger { kind: 'cmd'; query: string }
export type PickerTrigger = AtTrigger | SlashTrigger;

/**
 * 从光标向前找最近的 @：@ 前必须是边界（行首/空白/标点），@ 到光标之间不能有边界字符。
 * end 为 @ 之后连续非边界字符的末尾（用于替换整个 query 词）。
 */
export function findAtTrigger(text: string, caret: number): AtTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (isBoundary(ch)) return null;
    if (ch === '@') {
      if (!isBoundary(text[i - 1])) return null;
      let end = i + 1;
      while (end < text.length && !isBoundary(text[end])) end++;
      return { kind: 'file', start: i, end, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/** 文本以 / 开头且首个词内无空白 → 斜杠命令面板；query 为 / 后到光标（光标须在首词内） */
export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (!text.startsWith('/')) return null;
  const firstWord = text.match(/^\/(\S*)/)![0];
  if (caret > firstWord.length) return null;
  if (/\s/.test(text.slice(1, caret))) return null;
  return { kind: 'cmd', query: text.slice(1, caret) };
}

/** 生成引用文本：路径含空白/标点时用双引号包起来（core 支持 @"..."） */
export function formatFileRef(p: string): string {
  return AT_BOUNDARY.test(p) ? `@"${p.replace(/"/g, '\\"')}"` : `@${p}`;
}

// ==================== 数据 ====================

export interface PickerScope { sessionId?: string; projectId?: string }
const scopeKey = (s: PickerScope) => s.sessionId ? `s:${s.sessionId}` : s.projectId ? `p:${s.projectId}` : '';

/** 文件搜索：120ms 防抖 + reqId 丢弃过期响应 */
export function useFileSearch(scope: PickerScope, query: string | null): { items: FileSearchItem[]; loading: boolean } {
  const [items, setItems] = useState<FileSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const key = scopeKey(scope);
  useEffect(() => {
    if (query === null || !key) { setItems([]); setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api<FileSearchItem[]>('POST', '/api/files/search', { sessionId: scope.sessionId, projectId: scope.projectId, query, limit: 50 });
        if (id === reqId.current) setItems(res);
      } catch { if (id === reqId.current) setItems([]); }
      finally { if (id === reqId.current) setLoading(false); }
    }, 120);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, query]);
  return { items, loading };
}

const BUILTIN_COMMANDS: SlashItem[] = [
  { name: 'clear', description: t('chat.commands.clear'), category: 'command', send: true },
  { name: 'compact', description: t('chat.commands.compact'), category: 'command', send: true },
  { name: 'quickchat', description: t('chat.commands.quickchat'), category: 'command' },
];

const commandsCache = new Map<string, SlashItem[]>();

/** 命令清单：会话走该会话 worker（含项目级 .sema），草稿页走配置 worker（用户级占位）；打开面板时刷新，先显缓存 */
export function useCommands(scope: PickerScope, active: boolean): { items: SlashItem[]; loading: boolean } {
  const key = scopeKey(scope) || 'global';
  const [items, setItems] = useState<SlashItem[]>(() => commandsCache.get(key) || BUILTIN_COMMANDS);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setItems(commandsCache.get(key) || BUILTIN_COMMANDS); }, [key]);
  useEffect(() => {
    if (!active || wsClient.status !== 'open') return;
    let alive = true;
    setLoading(!commandsCache.has(key));
    const req = scope.sessionId
      ? wsClient.request<CommandsInfo>('session.getCommandsInfo', scope.sessionId, {})
      : wsClient.request<CommandsInfo>('core.getCommandsInfo', undefined, {});
    req.then(info => {
      const custom = (info.commands || []).filter(c => !BUILTIN_COMMANDS.some(b => b.name === c.name));
      const all = [...BUILTIN_COMMANDS, ...custom, ...(info.skills || []), ...(info.agents || [])];
      commandsCache.set(key, all);
      if (alive) setItems(all);
    }).catch(() => undefined).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return { items, loading };
}

/** 过滤排序（对齐插件）：名前缀 > 描述前缀 > 名包含 > 描述包含；同档：完全匹配 > 名更短 > 原顺序 */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const ranked: { item: SlashItem; idx: number; rank: number }[] = [];
  items.forEach((item, idx) => {
    const name = item.name.toLowerCase(), desc = (item.description || '').toLowerCase();
    const rank = name.startsWith(q) ? 0 : desc.startsWith(q) ? 1 : name.includes(q) ? 2 : desc.includes(q) ? 3 : -1;
    if (rank >= 0) ranked.push({ item, idx, rank });
  });
  return ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ae = a.item.name.toLowerCase() === q ? 0 : 1, be = b.item.name.toLowerCase() === q ? 0 : 1;
    if (ae !== be) return ae - be;
    if (a.item.name.length !== b.item.name.length) return a.item.name.length - b.item.name.length;
    return a.idx - b.idx;
  }).map(r => r.item);
}

// ==================== 弹层 ====================

function PickerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-0 right-0 bottom-full mb-1.5 z-30 bg-white border border-border rounded-lg shadow-xl py-1 max-h-72 overflow-auto text-sm">
      {children}
    </div>
  );
}

function useScrollSelected(selected: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return ref;
}

export function FilePicker({ items, loading, selected, noScope, onSelect, onHover }: {
  items: FileSearchItem[]; loading: boolean; selected: number; noScope?: boolean;
  onSelect: (item: FileSearchItem) => void; onHover: (i: number) => void;
}) {
  const ref = useScrollSelected(selected);
  return (
    <PickerShell>
      <div ref={ref}>
        {noScope ? <div className="px-3 py-2 text-xs text-muted">{t('chat.filePicker.noScope')}</div>
          : items.length === 0 ? <div className="px-3 py-2 text-xs text-muted">{loading ? t('chat.filePicker.loading') : t('chat.filePicker.empty')}</div>
          : items.map((f, i) => {
            const slash = f.path.lastIndexOf('/');
            const name = f.isDirectory ? f.path : f.path.slice(slash + 1);
            const parent = f.isDirectory || slash < 0 ? '' : f.path.slice(0, slash);
            return (
              <div key={f.path} data-selected={i === selected} title={f.path}
                onMouseDown={e => { e.preventDefault(); onSelect(f); }} onMouseEnter={() => onHover(i)}
                className={cn('flex items-center gap-2 px-3 py-1.5 cursor-pointer', i === selected ? 'bg-black/[0.06]' : 'hover:bg-black/[0.04]')}>
                <FileIcon fileName={name} isDirectory={f.isDirectory} size={14} />
                <span className="truncate">{name}</span>
                {parent && <span className="ml-auto pl-3 text-xs text-muted truncate max-w-[55%]">{parent}</span>}
              </div>
            );
          })}
      </div>
    </PickerShell>
  );
}

const CATEGORY_ORDER: SlashItem['category'][] = ['command', 'skill', 'agent'];

export function CommandPanel({ items, loading, selected, onSelect, onHover }: {
  items: SlashItem[]; loading: boolean; selected: number;
  onSelect: (item: SlashItem) => void; onHover: (i: number) => void;
}) {
  const ref = useScrollSelected(selected);
  // 分组渲染但保留扁平下标，与键盘导航一致
  const groups = useMemo(() => CATEGORY_ORDER
    .map(cat => ({ cat, entries: items.map((item, i) => ({ item, i })).filter(e => e.item.category === cat) }))
    .filter(g => g.entries.length > 0), [items]);
  if (items.length === 0) {
    return <PickerShell><div className="px-3 py-2 text-xs text-muted">{loading ? t('chat.commands.loading') : t('chat.filePicker.empty')}</div></PickerShell>;
  }
  return (
    <PickerShell>
      <div ref={ref}>
        {groups.map((g, gi) => (
          <div key={g.cat}>
            {gi > 0 && <div className="my-1 border-t border-border" />}
            <div className="px-3 pt-1 pb-0.5 text-[11px] text-muted/80 uppercase tracking-wide">{t(`chat.commands.${g.cat}` as any)}</div>
            {g.entries.map(({ item, i }) => (
              <div key={`${item.category}:${item.name}`} data-selected={i === selected}
                onMouseDown={e => { e.preventDefault(); onSelect(item); }} onMouseEnter={() => onHover(i)}
                className={cn('flex items-baseline gap-2 px-3 py-1.5 cursor-pointer', i === selected ? 'bg-black/[0.06]' : 'hover:bg-black/[0.04]')}>
                <span className="text-muted">/</span>
                <span className="shrink-0 font-medium">{item.name}</span>
                {item.argumentHint && <span className="text-xs text-muted/70 shrink-0">{item.argumentHint}</span>}
                <span className="ml-auto pl-3 text-xs text-muted truncate">{item.description}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </PickerShell>
  );
}
