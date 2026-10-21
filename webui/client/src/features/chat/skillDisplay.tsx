/**
 * 技能 / 内置命令显示映射：把特定斜杠名显示为「图标 + 名字」（斜杠面板、输入框、用户气泡三处共用）。
 * 只影响显示，发给 core 的文本仍是 `/<斜杠名> ...`。要增删映射只需改 SKILL_DISPLAY / COMMAND_DISPLAY。
 * 技能名直接写英文（办公软件名各语言通用）；命令名与所有描述走 i18n，只写 zh / en，其他语言兜底英文。
 */
import { ChartColumn, ChevronsDownUp, Chrome, Eraser, MessageCircleQuestion, Puzzle, Target, Telescope, type LucideIcon } from 'lucide-react';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { FILE_LABEL_ICON } from './fileRefDisplay';
import { cn } from '../../common/ui';
import { t, type I18nKey } from '../../i18n';

export interface SkillDisplay {
  /** 图标（二选一）：file = 复用文件图标，按后缀取（.docx / .xlsx / .pptx / .pdf）；icon = lucide 图标 */
  file?: string;
  icon?: LucideIcon;
  /** 名字颜色：文件图标取 FileIcon 的 iconColors 同色；lucide 图标随此色。省略（内置命令）= 输入框/气泡里与 @ 文件芯片同用强调色，斜杠面板里用中性色 */
  color?: string;
  /** 名字：技能写英文常量 name；命令写 i18n key nameKey（二选一，nameKey 优先） */
  name?: string;
  nameKey?: I18nKey;
  descKey: I18nKey;
}

/** key = 斜杠名（SKILL.md frontmatter 的 name） */
export const SKILL_DISPLAY: Record<string, SkillDisplay> = {
  'minimax-docx':   { file: '.docx', color: '#519ABA', name: 'Word',       descKey: 'skill.minimax-docx.desc' },
  'minimax-xlsx':   { file: '.xlsx', color: '#7CA843', name: 'Excel',      descKey: 'skill.minimax-xlsx.desc' },
  'pptx-generator': { file: '.pptx', color: '#E37933', name: 'PowerPoint', descKey: 'skill.pptx-generator.desc' },
  'minimax-pdf':    { file: '.pdf',  color: '#CC3E44', name: 'PDF',        descKey: 'skill.minimax-pdf.desc' },
  'visualize':      { icon: ChartColumn, color: '#4285F4', name: 'Visualize',  descKey: 'skill.visualize.desc' },
  'chrome-use':     { icon: Chrome,    color: '#fabd15', name: 'Chrome',     descKey: 'skill.chrome-use.desc' },
  'deep-research':  { icon: Telescope, color: '#2A9D8F', name: 'Research',   descKey: 'skill.deep-research.desc' },
  'sema-extend':    { icon: Puzzle,    color: '#A074C4', name: 'SemaExtend', descKey: 'skill.sema-extend.desc' },
};

/** 斜杠面板里命令统一用一个比正文（fg #1f1f1f）略浅、比描述（muted/70）深得多的中性色，不与技能的品牌色抢层级 */
const COMMAND_PANEL_COLOR = '#454545';
/** key = 内置命令名（与 InputPickers 的 BUILTIN_COMMANDS 一致）；不写 color：输入框/气泡里走强调色（与 @ 文件芯片一致） */
export const COMMAND_DISPLAY: Record<string, SkillDisplay> = {
  'clear':     { icon: Eraser,                nameKey: 'chat.commands.clear.name',     descKey: 'chat.commands.clear' },
  'compact':   { icon: ChevronsDownUp,        nameKey: 'chat.commands.compact.name',   descKey: 'chat.commands.compact' },
  'quickchat': { icon: MessageCircleQuestion, nameKey: 'chat.commands.quickchat.name', descKey: 'chat.commands.quickchat' },
  'goal':      { icon: Target,                nameKey: 'chat.commands.goal.name',      descKey: 'chat.commands.goal' },
};

export const skillDisplayOf = (name: string): SkillDisplay | undefined => SKILL_DISPLAY[name];
export const commandDisplayOf = (name: string): SkillDisplay | undefined => COMMAND_DISPLAY[name];

/** 当前语言下的显示名 / 短描述（渲染和面板过滤统一走这里，切换语言即时生效） */
export const displayName = (d: SkillDisplay): string => d.nameKey ? t(d.nameKey) : d.name || '';
export const displayDesc = (d: SkillDisplay): string => t(d.descKey);

const DISPLAY_ORDER = Object.keys(SKILL_DISPLAY);
/** 在 SKILL_DISPLAY 中的序号（面板按此排序）；无映射返回一个大数，排在所有有映射的技能之后且相互保持原顺序 */
export const skillDisplayOrder = (name: string): number => { const i = DISPLAY_ORDER.indexOf(name); return i < 0 ? DISPLAY_ORDER.length : i; };

/**
 * 文本以 `/<映射技能名或内置命令名>` 开头 → 返回名字、前缀长度（含其后一个空格）与剩余文本。
 * 默认后接空白或结尾都算；输入框传 requireSpace，避免手敲到一半刚好拼出技能名就被换成标签
 */
export function matchSkillPrefix(text: string, requireSpace = false): { name: string; display: SkillDisplay; prefixLen: number; rest: string } | null {
  const m = text.match(requireSpace ? /^\/(\S+)\s/ : /^\/(\S+)(\s|$)/);
  if (!m) return null;
  const display = SKILL_DISPLAY[m[1]] || COMMAND_DISPLAY[m[1]];
  if (!display) return null;
  const prefixLen = m[0].length;
  return { name: m[1], display, prefixLen, rest: text.slice(prefixLen) };
}

/**
 * 图标 + 同色名字，内联在文字前面（无底色）；尺寸与对齐方式与 FileLabel 一致（高度取整行行高并 align-top）。
 * 无固定色的命令：正文（输入框/气泡）里用强调色与 @ 文件芯片一致；panel（斜杠面板）里用中性色
 */
export function SkillLabel({ display, className, size = FILE_LABEL_ICON, panel }: { display: SkillDisplay; className?: string; size?: number; panel?: boolean }) {
  const color = display.color ?? (panel ? COMMAND_PANEL_COLOR : undefined);
  return (
    <span className={cn('inline-flex items-center gap-1 h-[1lh] align-top whitespace-nowrap', !color && 'text-accent', className)} style={color ? { color } : undefined}>
      {display.file ? <FileIcon fileName={display.file} size={size} /> : display.icon && <display.icon size={size} strokeWidth={2} />}
      <span className="font-medium">{displayName(display)}</span>
    </span>
  );
}
