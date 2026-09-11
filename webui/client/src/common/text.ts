import { t, dateLocale, type I18nKey } from '../i18n';

export function contentToString(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}

/** 工具展示名：mcp__server__tool → server · tool；snake_case → Title Case */
export function toolDisplayName(name: string): string {
  if (!name) return '';
  if (name.startsWith('mcp__')) { const [, server, ...rest] = name.split('__'); return `${server} · ${rest.join('__')}`; }
  const map: Record<string, I18nKey> = {
    view_file: 'toolName.read', run_shell: 'toolName.shell', write_file: 'toolName.write', patch_file: 'toolName.edit', search_files: 'toolName.findFiles', search_content: 'toolName.searchContent',
    fetch_url: 'toolName.fetch', skill: 'toolName.skill', sub_agent: 'toolName.subagent', ask_form: 'toolName.ask', plan_to_agent: 'toolName.exitPlan', edit_notebook: 'toolName.editNotebook',
    create_todo: 'toolName.todo', update_todo: 'toolName.todo', list_todos: 'toolName.todo', get_todo: 'toolName.todo', peek_bg_job: 'toolName.bgJob', stop_bg_job: 'toolName.stopBgJob',
    create_cron: 'toolName.cron', list_crons: 'toolName.cron', del_cron: 'toolName.cron', load_tools: 'toolName.loadTools',
  };
  return map[name] ? t(map[name]) : name.replace(/_/g, ' ');
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** 显示用路径：home 目录缩写为 ~（仅展示，打开/复制仍用真实路径） */
export function displayPath(p: string): string {
  return p.replace(/^(\/(?:Users|home)|[a-zA-Z]:[\\/]Users)[\\/][^\\/]+(?=[\\/])/, '~');
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', kt: 'kotlin', cs: 'csharp', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml', html: 'xml', css: 'css', scss: 'scss', less: 'less',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', rb: 'ruby', php: 'php', swift: 'swift', toml: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile', vue: 'xml', gradle: 'gradle', properties: 'ini', txt: 'plaintext', ipynb: 'python',
};
/** 按文件扩展名推断 highlight.js 语言 */
export function langOf(p: string): string | undefined {
  const base = (p.split(/[\\/]/).pop() || '').replace(/:\d+(-\d+)?$/, '').replace(/ cell:\d+$/, '');
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : base.toLowerCase();
  return EXT_LANG[ext];
}

/** 消息时间分级显示（日期部分按界面语言本地化）：今天→时分；7 天内→星期 时分；本年→M月D日 时分；跨年→YYYY年M月D日 时分 */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) return hm;
  const loc = dateLocale();
  if (dayDiff < 7) return `${d.toLocaleDateString(loc, { weekday: 'long' })} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })} ${hm}`;
  return `${d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' })} ${hm}`;
}

/** 绝对路径缩写为 ~ 相对形式：/Users/xxx/Documents → ~/Documents */
export function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/);
  return home ? '~' + p.slice(home[0].length) : p;
}
