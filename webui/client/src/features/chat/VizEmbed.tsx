/**
 * 可视化内联嵌入：visualize 技能产出的 html（attachments/<uuid>/*.html，见 shared/viz.ts）在结论下方直接以 iframe 展示，
 * 不再走「网站卡片」。iframe 走 /api/local/<token> 代理、不透明源沙箱（同右栏浏览器）；服务端注入的 viz-runtime
 * 通过 postMessage 上报高度与标题、响应截图请求。视口外不建 iframe（懒加载）。
 * iframe 始终按文档真实高度铺开（不产生内部滚动，与技能「body 随内容生长」的约定一致）；超过折叠高度时外层裁切、
 * 底部渐隐并给「展开/收起」按钮，展开后靠页面滚动看完。另有一个只防异常（尺寸上报失控）的保险丝上限。
 * 无标题行、无边框，内容直接铺在消息流里；悬浮时右侧留白区出现「⋯」，点开菜单：复制为图像、在右栏打开。
 * 「发布到站点」留 onPublish 接口，站点功能落地后接上。
 */
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Copy, SquareArrowOutUpRight, Check } from 'lucide-react';
import { VIZ_MSG_TYPE, type VizMessage } from '../../../../shared/viz';
import { useApp } from '../../store/app';
import { getToken } from '../../api/http';
import { normalizeUrl, fileUrlToProxy } from '../../common/url';
import { cn, Spinner, Popover, MenuItem } from '../../common/ui';
import { t, useLang } from '../../i18n';

const MIN_HEIGHT = 160;
/** 折叠高度：略小于一屏，超过则裁切 + 展开按钮 */
const COLLAPSED_HEIGHT = 800;
/** 保险丝：只防尺寸上报失控 / 内容异常，正常产物不应触到 */
const SANITY_MAX_HEIGHT = 4000;
const FALLBACK_HEIGHT = 480;
const SNAPSHOT_TIMEOUT = 15000;

let snapshotSeq = 0;

function absPathOf(p: string, workingDir: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return p;
  return workingDir ? `${workingDir}/${p}` : p;
}

export function VizEmbed({ sessionId, path, onPublish: _onPublish }: { sessionId: string; path: string; onPublish?: () => void }) {
  useLang();
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === sessionId)?.workingDir || '');
  const abs = absPathOf(path, workingDir);
  const fileUrl = normalizeUrl(abs);
  const fileName = abs.split(/[\\/]/).pop() || abs;

  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [docHeight, setDocHeight] = useState(MIN_HEIGHT);
  const [title, setTitle] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // 懒加载：进入视口前后 400px 才建 iframe（长会话里可能有很多个）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setVisible(true); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // runtime 上报：只认来自本 iframe 的消息
  useEffect(() => {
    const onMsg = (e: MessageEvent<VizMessage>) => {
      const m = e.data;
      if (!m || m.type !== VIZ_MSG_TYPE || m.kind !== 'size' || e.source !== iframeRef.current?.contentWindow) return;
      setDocHeight(Math.max(MIN_HEIGHT, Math.min(SANITY_MAX_HEIGHT, m.height + 2)));
      if (m.title) setTitle(m.title);
      setLoaded(true);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const copyImage = async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || copying) return;
    setMenu(null);
    setCopying(true);
    const id = ++snapshotSeq;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const timer = window.setTimeout(() => { cleanup(); reject(new Error('timeout')); }, SNAPSHOT_TIMEOUT);
        const onMsg = (e: MessageEvent<VizMessage>) => {
          const m = e.data;
          if (!m || m.type !== VIZ_MSG_TYPE || m.kind !== 'snapshot' || m.id !== id || e.source !== win) return;
          cleanup();
          if ('blob' in m && m.blob) resolve(m.blob); else reject(new Error(('error' in m && m.error) || 'snapshot failed'));
        };
        const cleanup = () => { window.clearTimeout(timer); window.removeEventListener('message', onMsg); };
        window.addEventListener('message', onMsg);
        win.postMessage({ type: VIZ_MSG_TYPE, kind: 'snapshot', id } satisfies VizMessage, '*');
      });
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch {
        // 剪贴板不可用（非安全上下文 / 权限拒绝）：退化为下载 png
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName.replace(/\.html?$/i, '') + '.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      useApp.getState().toast(`${t('viz.copyFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setCopying(false);
    }
  };

  // runtime 没起来（脚本 404 / 页面自己出错）时也要能看到内容：iframe load 后 1.5s 仍无上报就按默认高度显示
  const onIframeLoad = () => {
    window.setTimeout(() => setLoaded(prev => { if (!prev) setDocHeight(FALLBACK_HEIGHT); return true; }), 1500);
  };

  const openPanel = () => { setMenu(null); useApp.getState().openBrowserTab(sessionId, fileUrl); };

  const overflowing = loaded && docHeight > COLLAPSED_HEIGHT;
  const collapsed = overflowing && !expanded;
  const toggleExpanded = () => {
    setExpanded(v => !v);
    // 收起时若顶部已滚出视口，把组件拉回来，避免按钮随内容缩短跳走
    if (expanded && rootRef.current && rootRef.current.getBoundingClientRect().top < 0) rootRef.current.scrollIntoView({ block: 'start' });
  };

  return (
    <div ref={rootRef} className="group relative my-3">
      {/* 右侧留白区的「⋯」：仅悬浮或菜单打开时可见（消息流两侧 px-10 就是给它留的位置） */}
      <button ref={menuBtn} onClick={() => setMenu(menuBtn.current!.getBoundingClientRect())} disabled={!loaded}
        className={cn('absolute top-0 -right-8 h-6 w-6 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] transition-opacity',
          menu || copying || copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
        {copying ? <Spinner /> : copied ? <Check size={14} className="text-ok" /> : <MoreHorizontal size={14} />}
      </button>
      <Popover anchor={menu} onClose={() => setMenu(null)} align="right" className="py-1.5">
        <MenuItem onClick={copyImage} disabled={copying}><span className="inline-flex items-center gap-2"><Copy size={14} className="text-muted" />{t('viz.copyImage')}</span></MenuItem>
        {/* 发布到站点：站点功能落地后在这里加菜单项调 onPublish */}
        <MenuItem onClick={openPanel}><span className="inline-flex items-center gap-2"><SquareArrowOutUpRight size={14} className="text-muted" />{t('viz.openPanel')}</span></MenuItem>
      </Popover>
      {/* 外层只裁切不滚动；iframe 自身始终等于文档高度，页面内不会出现滚动条 */}
      <div className={cn('relative overflow-hidden', collapsed && '[mask-image:linear-gradient(to_bottom,#000_75%,transparent)]')}
        style={{ height: collapsed ? COLLAPSED_HEIGHT : docHeight }}>
        {visible && (
          // 与右栏浏览器同一策略：不给 allow-same-origin（不透明源），防内嵌页脚本借同源拿 token 调 API
          <iframe ref={iframeRef} title={title || fileName} src={fileUrlToProxy(fileUrl, getToken())} onLoad={onIframeLoad}
            sandbox="allow-scripts allow-popups allow-modals allow-downloads" scrolling="no"
            className={cn('block w-full border-0 transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} style={{ height: docHeight }} />
        )}
        {!loaded && <div className="absolute inset-0 flex items-center justify-center text-muted"><Spinner /></div>}
      </div>
      {overflowing && (
        <button type="button" onClick={toggleExpanded} className="mt-1 text-xs text-muted hover:text-fg">
          {expanded ? t('chat.collapse') : t('chat.expand')}
        </button>
      )}
    </div>
  );
}
