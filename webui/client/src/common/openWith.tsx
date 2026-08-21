/** 「打开方式」：macOS 列出可打开该文件的应用（默认应用置顶、带图标），FileTab 与网站卡片共用 */
import { useEffect, useState } from 'react';
import { api, getToken } from '../api/http';
import { useApp } from '../store/app';
import { MenuItem, Spinner } from './ui';
import { t } from '../i18n';

export interface OpenWithApp { id: string; name: string; path: string; icon: boolean }

export function appIconUrl(id: string) { return `/api/app-icon?id=${encodeURIComponent(id)}&token=${encodeURIComponent(getToken())}`; }

/** 预取候选应用：null=加载中，[]=无结果（非 macOS） */
export function useOpenWithApps(sessionId: string, path: string): OpenWithApp[] | null {
  const [apps, setApps] = useState<OpenWithApp[] | null>(null);
  useEffect(() => {
    let alive = true;
    setApps(null);
    if (!path) return;
    api<{ apps: OpenWithApp[] }>('POST', `/api/sessions/${sessionId}/open-with`, { path })
      .then(r => { if (alive) setApps(r.apps); })
      .catch(() => { if (alive) setApps([]); });
    return () => { alive = false; };
  }, [sessionId, path]);
  return apps;
}

/** 菜单项列表；无结果时退化为「用默认程序打开」 */
export function OpenWithItems({ sessionId, path, apps, onDone }: { sessionId: string; path: string; apps: OpenWithApp[] | null; onDone: () => void }) {
  const run = (app?: string) => { onDone(); useApp.getState().openFileExternal(sessionId, path, app).catch(e => useApp.getState().toast(e.message, 'error')); };
  if (apps === null) return <div className="px-3 py-1.5 text-sm text-muted flex items-center gap-2"><Spinner />{t('common.loading')}</div>;
  if (apps.length === 0) return <MenuItem onClick={() => run()}>{t('file.openDefault')}</MenuItem>;
  return (
    <>
      {apps.map(a => (
        <button key={a.id} onClick={() => run(a.path)} className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded hover:bg-black/[0.06] text-sm text-fg">
          {a.icon ? <img src={appIconUrl(a.id)} alt="" className="w-5 h-5 shrink-0" /> : <span className="w-5 h-5 shrink-0" />}
          <span className="truncate">{a.name}</span>
        </button>
      ))}
    </>
  );
}
