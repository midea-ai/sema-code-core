export function contentToString(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}

/** 工具展示名：mcp__server__tool → server · tool；snake_case → Title Case */
export function toolDisplayName(name: string): string {
  if (!name) return '';
  if (name.startsWith('mcp__')) { const [, server, ...rest] = name.split('__'); return `${server} · ${rest.join('__')}`; }
  const map: Record<string, string> = {
    view_file: '读取', run_shell: '命令', write_file: '写入', patch_file: '编辑', search_files: '查找文件', search_content: '搜索内容',
    fetch_url: '抓取', skill: 'Skill', sub_agent: '子代理', ask_form: '提问', plan_to_agent: '退出计划', edit_notebook: '编辑 Notebook',
    create_todo: '待办', update_todo: '待办', list_todos: '待办', get_todo: '待办', peek_bg_job: '后台任务', stop_bg_job: '停止后台任务',
    create_cron: '定时任务', list_crons: '定时任务', del_cron: '定时任务', load_tools: '加载工具',
  };
  return map[name] || name.replace(/_/g, ' ');
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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

/** 消息时间分级显示：今天→时分；7 天内→星期 时分；本年→M月D日 时分；跨年→YYYY年M月D日 时分 */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) return hm;
  if (dayDiff < 7) return `星期${'日一二三四五六'[d.getDay()]} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 绝对路径缩写为 ~ 相对形式：/Users/xxx/Documents → ~/Documents */
export function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/);
  return home ? '~' + p.slice(home[0].length) : p;
}
