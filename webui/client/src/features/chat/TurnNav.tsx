import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../../../shared/types';
import { cn } from '../../common/ui';
import { t } from '../../i18n';
import type { Turn } from './ChatView';

const MAX_TICKS = 30;
const TICK_H = 7; // 每条短横线占的行高（线 2px + 间距 5px）
const NAV_PAD = 16; // 指示条上下内边距之和
const MIN_TICKS = 5;
/** 少于这么多轮不显示指示条 */
export const MIN_TURNS = 4;

export interface TurnNavItem {
  /** 用户输入（或轮次开头块的文案）的纯文字 */
  title: string;
  /** 本轮以已完成的文字结论收尾时的结论纯文字；以工具 / 报错 / 确认等收尾或仍在运行则无 */
  conclusion?: string;
}

const MAX_CHARS = 400; // 小面板最多显示三行，取这么多字符足够截断

/** 压成一段纯文字：去掉各行行首的标题 / 列表 / 引用标记与行内强调符号，换行并成空格 */
const plainText = (s: string) => s.slice(0, MAX_CHARS * 2).split('\n').map(x => x.trim().replace(/^(?:[#>*\-+]|\d+\.)\s*/, ''))
  .filter(Boolean).join(' ').replace(/[*_`]+/g, '').slice(0, MAX_CHARS);

/** 轮末不参与「以什么收尾」判断的块：待办、文件改动卡片、定时任务卡片、目标达成标记 */
const isTrailer = (b: Block) => b.kind === 'todos' || b.kind === 'file-changes' || b.kind === 'cron' || (b.kind === 'notice' && b.noticeType === 'goal-achieved');

/** 从一轮算出导航条目；排队 / 乐观回显的输入与无开头块的前置组不算一轮，返回 null */
export function turnNavItem(turn: Turn): TurnNavItem | null {
  const o = turn.opener;
  if (!o) return null;
  let title = '';
  if (o.kind === 'user') {
    if (o.queued || o.pending) return null;
    if (o.source === 'goal' && o.goal?.action === 'round') title = t('chat.sourceGoalRound', { n: o.goal.round, max: o.goal.maxRounds });
    else title = plainText(o.text) || o.pastes?.[0]?.preview || (o.attachments?.length ? t('common.image') : '');
  } else title = plainText(o.text);
  const item: TurnNavItem = { title };
  if (!o.doneTs) return item;
  const rest = turn.blocks.slice(1).filter(b => !isTrailer(b));
  const last = rest[rest.length - 1];
  if (last?.kind === 'assistant' && last.done && last.text) item.conclusion = plainText(last.text);
  return item;
}

/**
 * 消息流左缘的轮次指示条：一条短横线对应一轮输入，当前轮（用户气泡正吸顶的那轮）加粗；
 * 悬停某条短横线在其右侧弹出该轮的小面板（单行输入 + 可选结论最多三行），移开即消失；点击跳到该轮用户输入。
 * 当前轮按列表里的 [data-turn] 零高标记算：最后一个顶边不低于滚动位置的标记；滚到底时取最后一轮（末轮太短时顶边永远到不了视口顶）。
 */
export function TurnNav({ listRef, items }: { listRef: React.RefObject<HTMLDivElement | null>; items: TurnNavItem[] }) {
  const [cur, setCur] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  // 点击钉住的轮：目标轮顶边滚不到视口顶（已到底、末尾内容不足一屏）时按滚动位置算出的仍是别的轮，
  // 记下点击后的滚动位置，位置没变就一直显示点中的那轮，用户再滚动（或内容增高带动滚动）即解除
  const pinned = useRef<{ idx: number; top: number } | null>(null);
  // 一次最多画几条：上限 30，消息区矮时按高度缩减（留出上下各一个行高的余量，不让指示条溢出消息区）
  const [maxTicks, setMaxTicks] = useState(MAX_TICKS);
  const count = items.length;

  // 标记元素相对列表内容顶部的位置（不用 offsetTop：标记的 offsetParent 是列表外层的定位容器，与滚动内容不对应）
  const markerTop = (list: HTMLDivElement, el: Element) => el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setMaxTicks(Math.max(MIN_TICKS, Math.min(MAX_TICKS, Math.floor((list.clientHeight - NAV_PAD - 2 * TICK_H) / TICK_H))));
      const markers = list.querySelectorAll<HTMLElement>('[data-turn]');
      if (!markers.length) return;
      if (pinned.current) {
        if (pinned.current.top === list.scrollTop) { setCur(pinned.current.idx); return; }
        pinned.current = null;
      }
      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 1) { setCur(Number(markers[markers.length - 1].dataset.turn)); return; }
      let best = Number(markers[0].dataset.turn);
      for (const m of markers) {
        if (markerTop(list, m) > list.scrollTop + 1) break;
        best = Number(m.dataset.turn);
      }
      setCur(best);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    schedule();
    list.addEventListener('scroll', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(list);
    if (list.firstElementChild) ro.observe(list.firstElementChild);
    return () => { list.removeEventListener('scroll', schedule); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [listRef, count]);

  const go = (idx: number) => {
    const list = listRef.current;
    const m = list?.querySelector<HTMLElement>(`[data-turn="${idx}"]`);
    if (!list || !m) return;
    // 只改滚动位置，贴底状态交给 ChatView 的 onScroll 按滚动方向判定（向上跳离底、向下跳到底附近恢复贴底）
    list.scrollTop = markerTop(list, m);
    pinned.current = { idx, top: list.scrollTop }; // 读回的是钳位后的实际位置
    setCur(idx);
  };

  // 轮数多时指示条只画当前轮附近的一段
  const tickFrom = count > maxTicks ? Math.min(count - maxTicks, Math.max(0, cur - Math.floor(maxTicks / 2))) : 0;
  const ticks = Array.from({ length: Math.min(count, maxTicks) }, (_, i) => tickFrom + i);
  const tip = hovered != null ? items[hovered] : null;

  return (
    // z-30 压过吸顶的用户气泡（z-10）与回到底部按钮（z-20）
    // 每条短横线的可点区域铺满整行（行高 7px = 线 2px + 间距 5px，整列无死区）
    <div onMouseLeave={() => setHovered(null)} className="absolute z-30 left-0 top-1/2 -translate-y-1/2 w-8 flex flex-col items-stretch pl-2.5 py-2">
      {ticks.map(i => (
        <button key={i} onClick={() => go(i)} onMouseEnter={() => setHovered(i)} className="relative h-[7px] flex items-center" tabIndex={-1}>
          <span className={cn('block h-0.5 rounded', i === cur ? 'w-5 bg-fg' : 'w-3 bg-black/20')} />
          {/* 小面板：挂在当前悬停的短横线右侧、垂直居中；不接鼠标事件，免得挡住相邻短横线的悬停 */}
          {hovered === i && tip && (
            <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 w-max max-w-[260px] flex flex-col items-start gap-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 shadow-lg text-left">
              <span className="w-full text-sm leading-5 text-fg truncate">{tip.title || ' '}</span>
              {tip.conclusion && <span className="w-full text-xs leading-4 text-muted line-clamp-3 break-words">{tip.conclusion}</span>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
