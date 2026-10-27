/**
 * 对话文本中的文件引用识别：`src/a.ts:12-20`、[text](docs/x.md)、![](shot.png) 等。
 * 前端只做格式初筛，是否真实存在由服务端批量 stat 确认（按会话缓存），确认后才渲染为可点击文件。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../../api/http';

export interface PathRef { path: string; line?: number; endLine?: number }
export interface PathStat { exists: boolean; isDir: boolean; inside: boolean; image: boolean; abs?: string; mtime?: number }

const MAX_CANDIDATES = 60;
// 路径形态：可选盘符/~/./../ 前缀 + 若干段，段内允许任意语言字母数字（\p{L}\p{N}，含中文）及 _ - . @ +；可带 :12 / :12-20 行号
const PATH_RE = /^(?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[\p{L}\p{N}_@.\-+]+(?:[\\/][\p{L}\p{N}_@.\-+]+)*[\\/]?(?::\d+(?:[-~]\d+)?)?$/u;
// 链接 href 的宽松形态：目标由 [text](...) 括号显式界定，%20 解码后的空格与括号不构成歧义，段内额外允许空格 ( ) [ ]（首尾不能是空格）
const LINK_PATH_RE = /^(?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[\p{L}\p{N}_@.\-+()[\]]+(?: [\p{L}\p{N}_@.\-+()[\]]+)*(?:[\\/][\p{L}\p{N}_@.\-+()[\]]+(?: [\p{L}\p{N}_@.\-+()[\]]+)*)*[\\/]?(?::\d+(?:[-~]\d+)?)?$/u;

/** 是否像文件路径：必须含 / 或 .，排除 URL、含空白、版本号、纯数字、过长文本；fromLink=true（markdown 链接/图片的 href）放行空格 */
export function isPathCandidate(s: string, fromLink = false): boolean {
  if (!s || s.length < 2 || s.length > 300) return false;
  if (s.includes('://') || (fromLink ? /[\t\n\r]/ : /\s/).test(s)) return false;
  if (!/[\\/.]/.test(s)) return false;
  if (/^\d+(\.\d+)+$/.test(s) || /^\.+$/.test(s)) return false;
  if (!(fromLink ? LINK_PATH_RE : PATH_RE).test(s)) return false;
  // 像 "a.b" 这种单个点且两侧都很短的表达式（obj.prop）：要求扩展名形态或含分隔符
  if (!/[\\/]/.test(s) && !/\.[a-zA-Z0-9]{1,8}(:\d|$)/.test(s)) return false;
  return true;
}

/** 拆出路径与行号：`src/a.ts:12-20` → { path, line:12, endLine:20 } */
export function parsePathRef(s: string): PathRef {
  const m = s.match(/^(.+?)(?::(\d+)(?:[-~](\d+))?)?$/);
  if (!m) return { path: s };
  const ref: PathRef = { path: m[1].replace(/[\\/]$/, '') || m[1] };
  if (m[2]) ref.line = Number(m[2]);
  if (m[3]) ref.endLine = Number(m[3]);
  return ref;
}

/** 本地图片/文件的原始字节 URL（img src 用，token 走 query） */
export function rawFileUrl(sessionId: string, path: string): string {
  return `/api/sessions/${sessionId}/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(getToken())}`;
}

/** href 是否为本地路径（无 scheme、非锚点、非 mailto）；
 * 盘符路径 D:\x 和「文件名.扩展名:行号」（README.md:1-10，冒号前是扩展名、冒号后只有行号）不算 scheme */
export function isLocalHref(href: string): boolean {
  if (!href || href.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href) && !/\.[a-zA-Z0-9]{1,8}:\d+(?:[-~]\d+)?$/.test(href)) return false;
  return true;
}

/** 从 markdown 源文本提取候选路径（剔除围栏代码块；行内代码、链接、图片三类） */
export function extractCandidates(text: string): string[] {
  const out = new Set<string>();
  const src = text.replace(/```[\s\S]*?```/g, '');
  for (const m of src.matchAll(/`([^`\n]+)`/g)) { if (isPathCandidate(m[1].trim())) out.add(parsePathRef(m[1].trim()).path); }
  // href 允许一层成对括号（CommonMark 链接目标规则，如 notes%20(draft).md），否则在文件名里的 ) 处截断，候选路径残缺永远 stat 不到
  for (const m of src.matchAll(/!?\[[^\]\n]*\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g)) {
    let href = m[1];
    try { href = decodeURIComponent(href); } catch { /* keep */ }
    href = href.replace(/#.*$/, '');
    if (isLocalHref(href) && isPathCandidate(href, true)) out.add(parsePathRef(href).path);
  }
  return [...out].slice(0, MAX_CANDIDATES);
}

// 会话级缓存：sessionId → path → stat
const cache = new Map<string, Map<string, PathStat>>();
const pending = new Map<string, Promise<void>>();

function sessionCache(sessionId: string) {
  let m = cache.get(sessionId);
  if (!m) { m = new Map(); cache.set(sessionId, m); }
  return m;
}

/**
 * 批量确认候选路径是否存在。enabled=false（流式中）时不发请求但仍返回已有缓存。
 * 返回查询函数：未确认返回 undefined。
 */
export function useFileStats(sessionId: string | undefined, text: string, enabled: boolean): (path: string) => PathStat | undefined {
  const candidates = useMemo(() => (sessionId ? extractCandidates(text) : []), [sessionId, text]);
  return usePathStats(sessionId, candidates, enabled);
}

/**
 * 批量确认给定路径是否存在（scopeId 为会话或项目 id，服务端 resolveScope 两者都认）。
 * 与 useFileStats 共用缓存；paths 按内容比较，调用方不必 memo
 */
export function usePathStats(scopeId: string | undefined, paths: string[], enabled: boolean): (path: string) => PathStat | undefined {
  const [, bump] = useState(0);
  const key = paths.join('\n');

  useEffect(() => {
    if (!scopeId || !enabled || paths.length === 0) return;
    const sc = sessionCache(scopeId);
    const missing = paths.filter(p => !sc.has(p));
    if (missing.length === 0) return;
    let alive = true;
    const pk = `${scopeId}\n${missing.join('\n')}`;
    let p = pending.get(pk);
    if (!p) {
      p = api<Record<string, PathStat>>('POST', `/api/sessions/${scopeId}/files/stat`, { paths: missing })
        .then(r => { for (const [k, v] of Object.entries(r)) sc.set(k, v); })
        .catch(() => { for (const k of missing) sc.set(k, { exists: false, isDir: false, inside: false, image: false }); })
        .finally(() => pending.delete(pk));
      pending.set(pk, p);
    }
    p.then(() => { if (alive) bump(n => n + 1); });
    return () => { alive = false; };
  }, [scopeId, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (path: string) => (scopeId ? sessionCache(scopeId).get(path) : undefined);
}

/** 已知结果直接写入缓存（如 @ 选择器选中的文件必然存在），免得先显示为文本、stat 回来后再变芯片 */
export function primeStat(scopeId: string, path: string, stat: PathStat) { sessionCache(scopeId).set(path, stat); }
