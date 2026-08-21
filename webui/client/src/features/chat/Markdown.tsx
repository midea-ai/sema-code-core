import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import { Check, Copy, Globe, WrapText } from 'lucide-react';
import { cn, useCopy } from '../../common/ui';
import { getToken } from '../../api/http';
import { isPrivateUrl } from '../../common/url';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { t } from '../../i18n';
import { useApp } from '../../store/app';
import { isLocalHref, isPathCandidate, parsePathRef, rawFileUrl, useFileStats, type PathStat } from './fileRefs';

// remarkBreaks：段落内的单个换行按换行渲染（与参考实现一致，模型输出常依赖单换行分行）
const remarkPlugins: any[] = [remarkGfm, remarkMath, remarkBreaks];
// KaTeX：公式出错时原样显示而不抛错；trust:false 关闭 \href 等危险命令
const rehypePlugins: any[] = [[rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }], rehypeHighlight];

/** 围栏代码块内的 code 不做文件识别 */
const InPre = createContext(false);

interface MdCtx { sessionId?: string; stat: (p: string) => PathStat | undefined }
const Ctx = createContext<MdCtx>({ stat: () => undefined });

/**
 * Markdown 渲染：禁原始 HTML；支持 GFM 与 KaTeX 公式（$...$ / $$...$$）；
 * - 链接：http(s) 走 openLink（本机/局域网右栏内嵌，其他系统浏览器）；本地路径经 stat 确认后在右栏打开
 * - 行内代码：形如路径且真实存在 → 带文件图标、可点击在右栏打开（支持 :行 / :起-止）
 * - 图片：本地路径经服务端 raw 接口内嵌显示，点击在右栏打开
 * done=false（流式中）不发起文件确认，避免半截路径抖动
 */
export const Markdown = memo(function Markdown({ text, sessionId, className, done = true }: { text: string; sessionId?: string; className?: string; done?: boolean }) {
  const stat = useFileStats(sessionId, text, done);
  const ctx = useMemo<MdCtx>(() => ({ sessionId, stat }), [sessionId, stat]);
  return (
    <Ctx.Provider value={ctx}>
      <div className={`md ${className || ''}`}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml components={components}>{preprocess(text)}</ReactMarkdown>
      </div>
    </Ctx.Provider>
  );
});

const components = { a: Anchor, img: MdImage, pre: CodeBlock, code: InlineCode, table: Table };

function Table({ children }: any) {
  // 外层 div 负责横向滚动，table 保持正常布局（列宽对齐、可撑满宽度）
  return <div className="md-table"><table>{children}</table></div>;
}

/** 可点击的文件引用（行内代码 / 链接共用） */
function FileRef({ path, line, endLine, label, asCode }: { path: string; line?: number; endLine?: number; label: ReactNode; asCode?: boolean }) {
  const { sessionId } = useContext(Ctx);
  const openFileRef = useApp(s => s.openFileRef);
  const onClick = (e: MouseEvent) => { e.preventDefault(); if (sessionId) openFileRef(sessionId, path, line, endLine); };
  const Tag: any = asCode ? 'code' : 'a';
  return (
    <Tag className={cn('md-file', asCode && 'md-file-code')} title={`${t('md.openFile')}: ${path}`} onClick={onClick} href={asCode ? undefined : '#'}>
      <FileIcon fileName={path} size={13} className="md-file-icon" />{label}
    </Tag>
  );
}

function InlineCode({ children, className, ...rest }: any) {
  const inPre = useContext(InPre);
  const { sessionId, stat } = useContext(Ctx);
  if (!inPre && sessionId) {
    const raw = String(Array.isArray(children) ? children.join('') : children ?? '').trim();
    if (isPathCandidate(raw)) {
      const ref = parsePathRef(raw);
      const s = stat(ref.path);
      if (s?.exists && !s.isDir) return <FileRef path={ref.path} line={ref.line} endLine={ref.endLine} label={raw} asCode />;
    }
  }
  return <code className={className} {...rest}>{children}</code>;
}

function Anchor({ href, children }: any) {
  const { sessionId, stat } = useContext(Ctx);
  const openLink = useApp(s => s.openLink);
  const openExternal = useApp(s => s.openExternal);
  if (!href) return <a>{children}</a>;
  if (isLocalHref(href)) {
    let p = href;
    try { p = decodeURIComponent(href); } catch { /* keep */ }
    p = p.replace(/#.*$/, '');
    if (sessionId && isPathCandidate(p)) {
      const ref = parsePathRef(p);
      const s = stat(ref.path);
      if (s?.exists && !s.isDir) return <FileRef path={ref.path} line={ref.line} endLine={ref.endLine} label={children} />;
    }
    // 本地路径尚未确认或不存在：按普通文本展示，悬停可见原始目标
    return <span title={href}>{children}</span>;
  }
  return (
    <a href={href} className="md-link" title={href} onClick={e => {
      e.preventDefault();
      if (sessionId) openLink(sessionId, href);
      else openExternal(href).catch(() => window.open(href, '_blank', 'noopener'));
    }}><SiteIcon url={href} />{children}</a>
  );
}

/** 链接前的站点图标：本机/局域网用地球；外网经服务端代理取 favicon，失败回退地球 */
function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let origin = '';
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) origin = u.origin; } catch { /* ignore */ }
  if (!origin || failed || isPrivateUrl(url)) return <Globe size={13} className="md-link-icon" />;
  return <img src={`/api/favicon?origin=${encodeURIComponent(origin)}&token=${encodeURIComponent(getToken())}`} alt="" className="md-link-icon" onError={() => setFailed(true)} />;
}

function MdImage({ src, alt }: any) {
  const { sessionId, stat } = useContext(Ctx);
  const openExternal = useApp(s => s.openExternal);
  const openFileTab = useApp(s => s.openFileTab);
  if (!src) return null;
  if (/^(https?:|data:|blob:)/i.test(src)) {
    const remote = /^https?:\/\//i.test(src);
    return <img src={src} alt={alt} className={cn(remote && 'cursor-pointer')} title={src} onClick={() => remote && openExternal(src).catch(() => window.open(src, '_blank', 'noopener'))} />;
  }
  // 本地图片：确认存在后经 raw 接口显示；否则回退为原始 markdown 文本
  let p = src;
  try { p = decodeURIComponent(src); } catch { /* keep */ }
  const s = sessionId ? stat(p) : undefined;
  if (!sessionId || !s?.exists || s.isDir) return <span className="text-muted">{`![${alt || ''}](${src})`}</span>;
  return <LocalImage sessionId={sessionId} path={p} alt={alt} onOpen={() => openFileTab(sessionId, p)} />;
}

/** 本地图片：加载失败（如系统权限拒绝读取）时显示可点击的失败占位而不是裂图，右栏打开后能看到具体错误 */
function LocalImage({ sessionId, path, alt, onOpen }: { sessionId: string; path: string; alt?: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="md-file md-img-failed" title={`${t('md.openImage')}: ${path}`} onClick={onOpen}>
        <FileIcon fileName={path} size={13} className="md-file-icon" />{alt || path.split(/[\\/]/).pop()}
        <span className="text-muted">（{t('md.imageLoadFailed')}）</span>
      </span>
    );
  }
  return <img src={rawFileUrl(sessionId, path)} alt={alt} className="cursor-pointer md-local-img" title={`${t('md.openImage')}: ${path}`} onClick={onOpen} onError={() => setFailed(true)} />;
}

/** 围栏代码块：右上角悬浮工具栏（自动换行开关、复制），复制内容取自渲染后的纯文本 */
function CodeBlock({ children }: any) {
  const ref = useRef<HTMLPreElement>(null);
  const [wrap, setWrap] = useState(true);
  const { copied, copy } = useCopy();
  return (
    <InPre.Provider value={true}>
      <div className="md-code group">
        <pre ref={ref} className={cn(wrap && 'md-code-wrap')}>{children}</pre>
        <div className="md-code-bar">
          <button type="button" className={cn('md-code-btn', wrap && 'is-on')} title={t(wrap ? 'md.wrapOff' : 'md.wrapOn')} onClick={() => setWrap(v => !v)}>
            <WrapText size={14} />
          </button>
          <button type="button" className="md-code-btn" title={t(copied ? 'common.copied' : 'common.copy')} onClick={() => copy(ref.current?.textContent ?? '')}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </InPre.Provider>
  );
}

function preprocess(text: string): string {
  return linkifyLocalUrls(htmlImgToMarkdown(text));
}

/** 原始 <img src=".." alt=".."> 标签转为 markdown 图片语法（skipHtml 会丢掉原始 HTML），与参考实现一致；围栏代码块内不处理 */
function htmlImgToMarkdown(text: string): string {
  if (!/<img\b/i.test(text)) return text;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((seg, i) => i % 2 === 1 ? seg : seg.replace(/<img\b[^>]*?>/gi, m => {
    const src = m.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src) return m;
    const alt = m.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '';
    return `![${alt}](${src.trim()})`;
  })).join('');
}

/** 把裸的本地 URL 变成 markdown 链接（GFM 已处理大部分自动链接，这里补 URL 后紧跟中文的场景） */
function linkifyLocalUrls(text: string): string {
  return text.replace(/(?<![(\[`])(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s)\]`'"<>，。；]*)/g, (m) => `[${m}](${m})`);
}
