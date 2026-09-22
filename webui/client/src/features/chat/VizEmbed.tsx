/**
 * 可视化内联嵌入：visualize 技能产出的 html（attachments/<uuid>/*.html，见 shared/viz.ts）在结论下方直接以 iframe 展示，
 * 不再走「网站卡片」。iframe 走 /api/local/<token> 代理、不透明源沙箱（同右栏浏览器）；服务端注入的 viz-runtime
 * 通过 postMessage 上报高度与标题、响应截图请求。视口外不建 iframe（懒加载），高度封顶后由 iframe 内部滚动。
 * 右上角：复制为图像、在右栏打开、折叠。「发布到站点」留 onPublish 接口，站点功能落地后接上。
 */
import { useEffect, useRef, useState } from 'react';
import { ChartColumn, ChevronDown, ChevronUp, Image, PanelRight, Check } from 'lucide-react';
import { VIZ_MSG_TYPE, type VizMessage } from '../../../../shared/viz';
import { useApp } from '../../store/app';
import { getToken } from '../../api/http';
import { normalizeUrl, fileUrlToProxy } from '../../common/url';
import { cn, Spinner } from '../../common/ui';
import { t, useLang } from '../../i18n';

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 800;
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
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [title, setTitle] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  // 修改文件后 file-changes 会再来一轮，同一路径的嵌入用 key 区分即可；这里的 reloadKey 只服务折叠再展开时重建 iframe
  const [reloadKey, setReloadKey] = useState(0);

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
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, m.height + 2)));
      if (m.title) setTitle(m.title);
      setLoaded(true);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const copyImage = async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || copying) return;
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
    window.setTimeout(() => setLoaded(prev => { if (!prev) setHeight(FALLBACK_HEIGHT); return true; }), 1500);
  };

  const toggle = () => {
    setCollapsed(v => !v);
    if (collapsed) { setLoaded(false); setReloadKey(k => k + 1); }
  };

  const btn = 'h-7 w-7 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] disabled:opacity-40';

  return (
    <div ref={rootRef} className="my-3 rounded-xl border border-border bg-white overflow-hidden">
      <div className="h-9 flex items-center gap-2 px-3 border-b border-border text-[13px]">
        <ChartColumn size={15} className="shrink-0 text-accent" />
        <span className="flex-1 min-w-0 truncate font-medium" title={abs}>{title || fileName}</span>
        {!collapsed && (
          <>
            <button onClick={copyImage} disabled={!loaded || copying} className={btn} title={t('viz.copyImage')}>
              {copying ? <Spinner /> : copied ? <Check size={14} className="text-ok" /> : <Image size={14} />}
            </button>
            {/* 发布到站点：站点功能落地后在这里加按钮调 onPublish */}
            <button onClick={() => useApp.getState().openBrowserTab(sessionId, fileUrl)} className={btn} title={t('viz.openPanel')}><PanelRight size={14} /></button>
          </>
        )}
        <button onClick={toggle} className={btn} title={collapsed ? t('viz.expand') : t('viz.collapse')}>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      </div>
      {!collapsed && (
        <div className="relative bg-white" style={{ height }}>
          {visible && (
            // 与右栏浏览器同一策略：不给 allow-same-origin（不透明源），防内嵌页脚本借同源拿 token 调 API
            <iframe ref={iframeRef} key={reloadKey} title={title || fileName} src={fileUrlToProxy(fileUrl, getToken())} onLoad={onIframeLoad}
              sandbox="allow-scripts allow-popups allow-modals allow-downloads"
              className={cn('block w-full h-full border-0 transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} />
          )}
          {!loaded && <div className="absolute inset-0 flex items-center justify-center text-muted"><Spinner /></div>}
        </div>
      )}
    </div>
  );
}
