/**
 * 技能显示映射：把特定 skill 的斜杠名显示为「图标 + 名字」（斜杠面板、输入框、用户气泡三处共用）。
 * 只影响显示，发给 core 的文本仍是 `/<斜杠名> ...`。要增删映射只需改 SKILL_DISPLAY。
 * 名字/描述直接写英文，不走 i18n（四款办公软件名各语言通用）。
 */
import { ChartColumn, Chrome, Puzzle, type LucideIcon } from 'lucide-react';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { cn } from '../../common/ui';

export interface SkillDisplay {
  /** 图标（二选一）：file = 复用文件图标，按后缀取（.docx / .xlsx / .pptx / .pdf）；icon = lucide 图标 */
  file?: string;
  icon?: LucideIcon;
  /** 名字颜色：文件图标取 FileIcon 的 iconColors 同色；lucide 图标随此色 */
  color: string;
  name: string;
  desc: string;
}

/** key = 斜杠名（SKILL.md frontmatter 的 name） */
export const SKILL_DISPLAY: Record<string, SkillDisplay> = {
  'minimax-docx':   { file: '.docx', color: '#519ABA', name: 'Word',       desc: 'Create and edit Word documents' },
  'minimax-xlsx':   { file: '.xlsx', color: '#7CA843', name: 'Excel',      desc: 'Create, edit and analyze spreadsheets' },
  'pptx-generator': { file: '.pptx', color: '#E37933', name: 'PowerPoint', desc: 'Generate and edit slides' },
  'minimax-pdf':    { file: '.pdf',  color: '#CC3E44', name: 'PDF',        desc: 'Generate and fill PDFs' },
  'visualize':      { icon: ChartColumn, color: '#2A78D6', name: 'Visualize', desc: 'Charts, maps, simulators and mockups rendered in the chat' },
  'chrome-use':     { icon: Chrome,  color: '#4285F4', name: 'Chrome',     desc: 'Browse and operate web pages in your own Chrome' },
  'sema-extend':    { icon: Puzzle,  color: '#A074C4', name: 'SemaExtend',     desc: 'Install, configure or remove skills, MCP servers and plugins' },
};

export const skillDisplayOf = (name: string): SkillDisplay | undefined => SKILL_DISPLAY[name];

const DISPLAY_ORDER = Object.keys(SKILL_DISPLAY);
/** 在 SKILL_DISPLAY 中的序号（面板按此排序）；无映射返回一个大数，排在所有有映射的技能之后且相互保持原顺序 */
export const skillDisplayOrder = (name: string): number => { const i = DISPLAY_ORDER.indexOf(name); return i < 0 ? DISPLAY_ORDER.length : i; };

/**
 * 文本以 `/<映射技能名>` 开头 → 返回技能名、前缀长度（含其后一个空格）与剩余文本。
 * 默认后接空白或结尾都算；输入框传 requireSpace，避免手敲到一半刚好拼出技能名就被换成标签
 */
export function matchSkillPrefix(text: string, requireSpace = false): { name: string; display: SkillDisplay; prefixLen: number; rest: string } | null {
  const m = text.match(requireSpace ? /^\/(\S+)\s/ : /^\/(\S+)(\s|$)/);
  if (!m) return null;
  const display = SKILL_DISPLAY[m[1]];
  if (!display) return null;
  const prefixLen = m[0].length;
  return { name: m[1], display, prefixLen, rest: text.slice(prefixLen) };
}

/** 图标 + 同色名字，内联在文字前面（无底色）；高度取整行行高并 align-top，与 FileRefChip 同一套对齐方式 */
export function SkillLabel({ display, className, size = 15 }: { display: SkillDisplay; className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-1 h-[1lh] align-top whitespace-nowrap', className)} style={{ color: display.color }}>
      {display.file ? <FileIcon fileName={display.file} size={size} /> : display.icon && <display.icon size={size} strokeWidth={2} />}
      <span className="font-medium">{display.name}</span>
    </span>
  );
}
