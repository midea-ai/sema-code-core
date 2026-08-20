/**
 * 终端窗口：xterm.js + 服务端 node-pty（/ws/term 数据通道）。
 * 挂载时复用标签里的 termId（刷新/切换标签回放缓冲），失效则新建；关闭标签时由 RightPanel 调 DELETE 杀进程。
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, getToken } from '../../api/http';
import { useApp, PanelTab } from '../../store/app';
import { t } from '../../i18n';

const THEME = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  cursorAccent: '#ffffff',
  selectionBackground: '#b3d7ff',
  black: '#000000', red: '#c0392b', green: '#1a7f37', yellow: '#9a6700', blue: '#0a7cff', magenta: '#8250df', cyan: '#0e7490', white: '#d4d4d4',
  brightBlack: '#6e7781', brightRed: '#d1242f', brightGreen: '#2da44e', brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#f6f8fa',
};

export function TerminalTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let ws: WebSocket | null = null;
    let disposed = false;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const connect = (termId: string) => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/term?token=${encodeURIComponent(getToken())}&id=${termId}`);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = ev => {
        // 二进制帧 = 终端输出；文本帧 = 控制消息（exit）
        if (typeof ev.data === 'string') {
          try { if (JSON.parse(ev.data)?.type === 'exit') { setExited(true); term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n'); } } catch { /* ignore */ }
          return;
        }
        term.write(new Uint8Array(ev.data));
      };
      ws.onopen = () => { term.focus(); sendResize(); };
      ws.onclose = ev => { if (!disposed && ev.code === 4404) recreate(); };
      ws.onerror = () => undefined;
    };

    // 复用已有 termId；无或失效（服务端重启）则新建并写回标签
    const ensure = async () => {
      try {
        if (tab.termId) { connect(tab.termId); return; }
        await recreate();
      } catch (e: any) { setError(e.message); }
    };
    const recreate = async () => {
      const info = await api<{ id: string }>('POST', `/api/sessions/${sessionId}/terminals`, { cols: term.cols, rows: term.rows });
      if (disposed) return;
      useApp.getState().updatePanel(sessionId, p => ({ ...p, tabs: p.tabs.map(x => x.id === tab.id ? { ...x, termId: info.id } : x) }));
      connect(info.id);
    };

    const send = (obj: any) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const sendResize = () => send({ type: 'resize', cols: term.cols, rows: term.rows });
    const onData = term.onData(data => send({ type: 'input', data }));

    const ob = new ResizeObserver(() => { try { fit.fit(); sendResize(); } catch { /* not visible */ } });
    ob.observe(el);

    void ensure();

    return () => {
      disposed = true;
      ob.disconnect();
      onData.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, tab.id, restartKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 min-h-0 relative bg-white">
      <div ref={boxRef} className="absolute inset-0 pl-2 pt-1" />
      {error && <div className="absolute inset-0 bg-white flex items-center justify-center text-sm text-danger p-6 text-center">{error}</div>}
      {exited && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <button
            onClick={() => {
              // 丢弃旧 termId，重挂载新建进程
              useApp.getState().updatePanel(sessionId, p => ({ ...p, tabs: p.tabs.map(x => x.id === tab.id ? { ...x, termId: undefined } : x) }));
              setExited(false); setError(null); setRestartKey(k => k + 1);
            }}
            className="h-7 px-3 rounded-md border border-border bg-white shadow-sm text-xs hover:bg-black/[0.04]">
            {t('panel.termRestart')}
          </button>
        </div>
      )}
    </div>
  );
}
