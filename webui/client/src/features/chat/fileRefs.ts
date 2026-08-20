/**
 * 对话文本中的文件引用识别：`src/a.ts:12-20`、[text](docs/x.md)、![](shot.png) 等。
 * 前端只做格式初筛，是否真实存在由服务端批量 stat 确认（按会话缓存），确认后才渲染为可点击文件。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../../api/http';

export interface PathRef { path: string; line?: number; endLine?: number }
export interface PathStat { exists: boolean; isDir: boolean; inside: boolean; image: boolean }

const MAX_CANDIDATES = 60;
// 路径形态：可选盘符/~/./../ 前缀 + 若干段，段内允许字母数字 _ - . @ + 空格以外的常见字符；可带 :12 / :12-20 行号
const PATH_RE = /^(?:[a-zA-Z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[\w@.\-+]+(?:[\\/][\w@.\-+]+)*[\\/]?(?::\d+(?:[-~]\d+)?)?$/;

/** 是否像文件路径：必须含 / 或 .，排除 URL、含空白、版本号、纯数字、过长文本 */
export function isPathCandidate(s: string): boolean {
  if (!s || s.length < 2 || s.length > 300) return false;
  if (s.includes('://') || /\s/.test(s)) return false;
  if (!/[\\/.]/.test(s)) return false;
  if (/^\d+(\.\d+)+$/.test(s) || /^\.+$/.test(s)) return false;
  if (!PATH_RE.test(s)) return false;
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

/** href 是否为本地路径（无 scheme、非锚点、非 mailto） */
export function isLocalHref(href: string): boolean {
  if (!href || href.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) return false;
  return true;
}

/** 从 markdown 源文本提取候选路径（剔除围栏代码块；行内代码、链接、图片三类） */
export function extractCandidates(text: string): string[] {
  const out = new Set<string>();
  const src = text.replace(/```[\s\S]*?```/g, '');
  for (const m of src.matchAll(/`([^`\n]+)`/g)) { if (isPathCandidate(m[1].trim())) out.add(parsePathRef(m[1].trim()).path); }
  for (const m of src.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let href = m[1];
    try { href = decodeURIComponent(href); } catch { /* keep */ }
    href = href.replace(/#.*$/, '');
    if (isLocalHref(href) && isPathCandidate(href)) out.add(parsePathRef(href).path);
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
  const [, bump] = useState(0);
  const candidates = useMemo(() => (sessionId ? extractCandidates(text) : []), [sessionId, text]);
  const key = candidates.join('\n');

  useEffect(() => {
    if (!sessionId || !enabled || candidates.length === 0) return;
    const sc = sessionCache(sessionId);
    const missing = candidates.filter(p => !sc.has(p));
    if (missing.length === 0) return;
    let alive = true;
    const pk = `${sessionId}\n${missing.join('\n')}`;
    let p = pending.get(pk);
    if (!p) {
      p = api<Record<string, PathStat>>('POST', `/api/sessions/${sessionId}/files/stat`, { paths: missing })
        .then(r => { for (const [k, v] of Object.entries(r)) sc.set(k, v); })
        .catch(() => { for (const k of missing) sc.set(k, { exists: false, isDir: false, inside: false, image: false }); })
        .finally(() => pending.delete(pk));
      pending.set(pk, p);
    }
    p.then(() => { if (alive) bump(n => n + 1); });
    return () => { alive = false; };
  }, [sessionId, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (path: string) => (sessionId ? sessionCache(sessionId).get(path) : undefined);
}
