/**
 * 可视化内联嵌入：visualize 技能产出的 html（attachments/<uuid>/*.html，见 shared/viz.ts）在结论下方直接以 iframe 展示，
 * 不再走「网站卡片」。iframe 走 /api/local/<token> 代理、不透明源沙箱（同右栏浏览器）；服务端注入的 viz-runtime
 * 通过 postMessage 上报高度与标题、响应截图请求。视口外不建 iframe（懒加载）。
 * iframe 始终按文档真实高度铺开（不产生内部滚动，与技能「body 随内容生长」的约定一致），不折叠，再高也靠页面滚动看完；
 * 只留一个防异常（尺寸上报失控）的保险丝上限。
 * 宽度默认与消息列一致；页面用 meta 声明了设计宽度（见 shared/viz.ts 的 VIZ_WIDTH_META）时加宽到该值，上限是聊天区两侧留白，页面按这个宽度排版。
 * 无标题行、无边框，内容直接铺在消息流里；悬浮时右侧留白区出现「⋯」，点开菜单：复制为图像、展开（占满窗口的弹层里查看，可缩放、下载图片）、在右栏打开。
 * 「发布到站点」留 onPublish 接口，站点功能落地后接上。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MoreHorizontal, Copy, Maximize2, SquareArrowOutUpRight, Check } from 'lucide-react';
import { VIZ_MSG_TYPE, type VizMessage } from '../../../../shared/viz';
import { useApp } from '../../store/app';
import { getToken } from '../../api/http';
import { normalizeUrl, fileUrlToProxy } from '../../common/url';
import { cn, Spinner, Popover, MenuItem } from '../../common/ui';
import { ExpandDialog } from './ExpandDialog';
import { t, useLang } from '../../i18n';

const MIN_HEIGHT = 160;
/** 保险丝：只防尺寸上报失控 / 内容异常，正常产物不应触到 */
const SANITY_MAX_HEIGHT = 4000;
const FALLBACK_HEIGHT = 480;
const SNAPSHOT_TIMEOUT = 15000;
/** 展开弹层的缩放档位（百分比）：效果同浏览器缩放，放大时页面按更窄的视口重排、内容变大 */
const DIALOG_ZOOMS = [50, 75, 100, 125, 150, 200];

let snapshotSeq = 0;

function absPathOf(p: string, workingDir: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return p;
  return workingDir ? `${workingDir}/${p}` : p;
}

/** 一个可视化 iframe 的加载状态：runtime 上报的文档高度、标题与页面声明的设计宽度（内联与展开弹层各建一个 iframe，各用一份） */
function useVizFrame() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [docHeight, setDocHeight] = useState(MIN_HEIGHT);
  const [title, setTitle] = useState('');
  const [designWidth, setDesignWidth] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  // runtime 上报：只认来自本 iframe 的消息
  useEffect(() => {
    const onMsg = (e: MessageEvent<VizMessage>) => {
      const m = e.data;
      if (!m || m.type !== VIZ_MSG_TYPE || m.kind !== 'size' || e.source !== iframeRef.current?.contentWindow) return;
      setDocHeight(Math.max(MIN_HEIGHT, Math.min(SANITY_MAX_HEIGHT, m.height + 2)));
      if (m.title) setTitle(m.title);
      if (m.width) setDesignWidth(m.width);
      setLoaded(true);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // runtime 没起来（脚本 404 / 页面自己出错）时也要能看到内容：iframe load 后 1.5s 仍无上报就按默认高度显示
  const onLoad = () => {
    window.setTimeout(() => setLoaded(prev => { if (!prev) setDocHeight(FALLBACK_HEIGHT); return true; }), 1500);
  };

  return { iframeRef, docHeight, title, designWidth, loaded, onLoad };
}

/** 向 iframe 内的 runtime 要一张整页截图（png） */
function requestSnapshot(win: Window): Promise<Blob> {
  const id = ++snapshotSeq;
  return new Promise<Blob>((resolve, reject) => {
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
}

/** 截图存成 png 文件，文件名取页面文件名 */
function savePng(blob: Blob, fileName: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName.replace(/\.html?$/i, '') + '.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function VizEmbed({ sessionId, path, onPublish: _onPublish }: { sessionId: string; path: string; onPublish?: () => void }) {
  useLang();
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === sessionId)?.workingDir || '');
  const abs = absPathOf(path, workingDir);
  const fileUrl = normalizeUrl(abs);
  const fileName = abs.split(/[\\/]/).pop() || abs;

  const rootRef = useRef<HTMLDivElement>(null);
  const { iframeRef, docHeight, title, designWidth, loaded, onLoad: onIframeLoad } = useVizFrame();
  const [visible, setVisible] = useState(false);
  const [full, setFull] = useState(false);
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

  const copyImage = async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || copying) return;
    setMenu(null);
    setCopying(true);
    try {
      const blob = await requestSnapshot(win);
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch {
        // 剪贴板不可用（非安全上下文 / 权限拒绝）：退化为下载 png
        savePng(blob, fileName);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      useApp.getState().toast(`${t('viz.copyFailed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setCopying(false);
    }
  };

  const openPanel = () => { setMenu(null); useApp.getState().openBrowserTab(sessionId, fileUrl); };
  const openFull = () => { setMenu(null); setFull(true); };

  return (
    // viz-embed：默认与消息列等宽；页面声明了设计宽度时经 --viz-w 加宽，上限为聊天区两侧留白（见 index.css）
    <div ref={rootRef} className="viz-embed group relative my-3" style={designWidth ? { '--viz-w': `${designWidth}px` } as CSSProperties : undefined}>
      {/* 右侧留白区的「⋯」：仅悬浮或菜单打开时可见（消息流两侧 px-10 就是给它留的位置） */}
      <button ref={menuBtn} onClick={() => setMenu(menuBtn.current!.getBoundingClientRect())} disabled={!loaded}
        className={cn('absolute top-0 -right-8 h-6 w-6 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] transition-opacity',
          menu || copying || copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
        {copying ? <Spinner /> : copied ? <Check size={14} className="text-ok" /> : <MoreHorizontal size={14} />}
      </button>
      <Popover anchor={menu} onClose={() => setMenu(null)} align="right" className="py-1.5">
        <MenuItem onClick={copyImage} disabled={copying}><span className="inline-flex items-center gap-2"><Copy size={14} className="text-muted" />{t('viz.copyImage')}</span></MenuItem>
        <MenuItem onClick={openFull}><span className="inline-flex items-center gap-2"><Maximize2 size={14} className="text-muted" />{t('chat.expand')}</span></MenuItem>
        {/* 发布到站点：站点功能落地后在这里加菜单项调 onPublish */}
        <MenuItem onClick={openPanel}><span className="inline-flex items-center gap-2"><SquareArrowOutUpRight size={14} className="text-muted" />{t('viz.openPanel')}</span></MenuItem>
      </Popover>
      {/* 外层与 iframe 同高：iframe 始终等于文档高度，页面内不会出现滚动条；iframe 未建 / 未就绪时这块高度用来放加载圈 */}
      <div className="relative" style={{ height: docHeight }}>
        {visible && (
          // 与右栏浏览器同一策略：不给 allow-same-origin（不透明源），防内嵌页脚本借同源拿 token 调 API
          <iframe ref={iframeRef} title={title || fileName} src={fileUrlToProxy(fileUrl, getToken())} onLoad={onIframeLoad}
            sandbox="allow-scripts allow-popups allow-modals allow-downloads" scrolling="no"
            className={cn('block w-full border-0 transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} style={{ height: docHeight }} />
        )}
        {!loaded && <div className="absolute inset-0 flex items-center justify-center text-muted"><Spinner /></div>}
      </div>
      {full && <VizDialog src={fileUrlToProxy(fileUrl, getToken())} fileName={fileName} onClose={() => setFull(false)} />}
    </div>
  );
}

/** 展开弹层：另起一个 iframe 加载同一页面（iframe 挪动 DOM 位置会重载，不复用内联那个），页面按弹层宽度重新排版。
 * iframe 同样按文档真实高度铺开、由弹层内容区滚动；比内容区矮时垂直居中。顶部下载整页截图，底部缩放 */
function VizDialog({ src, fileName, onClose }: { src: string; fileName: string; onClose: () => void }) {
  const { iframeRef, docHeight, title, loaded, onLoad } = useVizFrame();
  const [zoom, setZoom] = useState(100);
  const [saving, setSaving] = useState(false);

  const download = async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || saving) return;
    setSaving(true);
    try {
      savePng(await requestSnapshot(win), fileName);
    } catch (e) {
      useApp.getState().toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ExpandDialog onClose={onClose} onDownload={download} downloading={saving} disabled={!loaded} zoom={zoom} zooms={DIALOG_ZOOMS} resetZoom={100} onZoom={setZoom}>
      <div className="relative flex-1 min-h-0 flex overflow-auto px-5">
        {/* 沙箱策略与内联一致（不给 allow-same-origin）；缩放用 CSS zoom：宽度仍占满，页面视口相应变窄 / 变宽 */}
        <iframe ref={iframeRef} title={title || fileName} src={src} onLoad={onLoad}
          sandbox="allow-scripts allow-popups allow-modals allow-downloads" scrolling="no"
          className={cn('block m-auto w-full shrink-0 border-0 transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} style={{ height: docHeight, zoom: zoom / 100 }} />
        {!loaded && <div className="absolute inset-0 flex items-center justify-center text-muted"><Spinner /></div>}
      </div>
    </ExpandDialog>
  );
}
