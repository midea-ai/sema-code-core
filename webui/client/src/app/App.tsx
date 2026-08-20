import { useEffect } from 'react';
import { initToken } from '../api/http';
import { wsClient } from '../api/ws';
import { useApp } from '../store/app';
import { Sidebar } from '../features/sidebar/Sidebar';
import { ChatView } from '../features/chat/ChatView';
import { RightPanel } from '../features/panel/RightPanel';
import { SettingsPage } from '../features/settings/SettingsPage';
import { DraftView } from '../features/chat/DraftView';
import { DialogProvider, cn, Spinner } from '../common/ui';
import { t } from '../i18n';
import { PanelLeft } from 'lucide-react';
import { ResizeHandle, usePanelWidth } from '../common/Resizer';

export function App() {
  const ready = useApp(s => s.ready);
  const view = useApp(s => s.view);
  const bootstrap = useApp(s => s.bootstrap);
  const wsStatus = useApp(s => s.wsStatus);
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  const setSidebarCollapsed = useApp(s => s.setSidebarCollapsed);
  const [sidebarW, setSidebarW] = usePanelWidth('sidebar', 256, 180, 480);
  const [panelW, setPanelW] = usePanelWidth('panel', 520, 320, 1200);
  const panelCollapsed = useApp(s => view.type === 'chat' ? (s.panels[view.sessionId]?.collapsed ?? true) : true);

  useEffect(() => {
    initToken();
    bootstrap().catch(e => {
      useApp.getState().toast(`${t('common.error')}: ${e.message}`, 'error');
      if (e.status === 401) document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#ccc">未授权：请使用服务端启动时打印的带 token 的地址访问。</div>';
    });
  }, [bootstrap]);

  if (!ready) {
    return <div className="h-full flex items-center justify-center text-muted gap-2"><Spinner /> {t('common.loading')}</div>;
  }

  return (
    <DialogProvider>
      <div className="h-full flex overflow-hidden">
        {!sidebarCollapsed && <Sidebar width={sidebarW} />}
        {!sidebarCollapsed && <ResizeHandle side="left" width={sidebarW} onResize={setSidebarW} />}
        <div className="flex-1 min-w-0 flex flex-col relative">
          {wsStatus !== 'open' && (
            <div className="absolute top-0 inset-x-0 z-20 text-center text-xs py-1 bg-warn/20 text-warn">
              {wsStatus === 'connecting' ? t('common.connecting')
                : wsStatus === 'unauthorized' ? t('common.unauthorized')
                : wsStatus === 'failed' ? t('common.connectFailed')
                : t('common.disconnected')}
              {(wsStatus === 'failed' || wsStatus === 'unauthorized') && (
                <button onClick={() => wsClient.retryNow()} className="ml-2 underline hover:opacity-80">{t('common.retry')}</button>
              )}
            </div>
          )}
          {sidebarCollapsed && (
            <button onClick={() => setSidebarCollapsed(false)} className="absolute left-2 top-2 z-10 p-1.5 rounded-md text-muted hover:text-fg hover:bg-black/[0.05]" title="显示侧边栏">
              <PanelLeft size={16} />
            </button>
          )}
          {view.type === 'settings' && <SettingsPage tab={view.tab} />}
          {view.type === 'chat' && (
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 flex flex-col"><ChatView key={view.sessionId} sessionId={view.sessionId} /></div>
              {!panelCollapsed && <ResizeHandle side="right" width={panelW} onResize={setPanelW} />}
              <RightPanel sessionId={view.sessionId} width={panelW} />
            </div>
          )}
          {view.type === 'draft' && <DraftView key={view.projectId || ''} projectId={view.projectId} />}
          {view.type === 'empty' && <DraftView />}
        </div>
        <Toasts />
      </div>
    </DialogProvider>
  );
}

function Toasts() {
  const toasts = useApp(s => s.toasts);
  const dismiss = useApp(s => s.dismissToast);
  return (
    <div className="fixed bottom-4 right-4 z-[1200] flex flex-col gap-2 max-w-sm">
      {toasts.map(tt => (
        <div key={tt.id} onClick={() => dismiss(tt.id)}
          className={cn('px-3 py-2 rounded-lg shadow-lg text-sm border cursor-pointer',
            tt.level === 'error' ? 'bg-danger/15 border-danger/40 text-fg' : tt.level === 'warn' ? 'bg-warn/15 border-warn/40' : 'bg-white border-border')}>
          {tt.text}
        </div>
      ))}
    </div>
  );
}
