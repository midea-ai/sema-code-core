/**
 * WebSocket：请求/应答 + 事件推送。一个连接可订阅多个会话。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { SessionManager, Subscriber } from '../sessions';
import { CORE_ACTIONS, PROJECT_ACTIONS, SESSION_ACTIONS } from '../../../shared/protocol';
import type { ReqFrame } from '../../../shared/types';

const ALLOWED = new Set<string>([...CORE_ACTIONS, ...PROJECT_ACTIONS, ...SESSION_ACTIONS]);

export function attachWs(wss: WebSocketServer, sm: SessionManager) {
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const sub: Subscriber = {
      send: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); },
    };
    sm.globalSubscribers.add(sub);

    ws.on('message', async (raw) => {
      let frame: ReqFrame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (!frame || typeof frame.id !== 'string' || typeof frame.action !== 'string') return;
      const reply = (ok: boolean, data?: any, error?: string) => sub.send({ id: frame.id, ok, data, error });
      try {
        if (!ALLOWED.has(frame.action)) throw new Error(`action 不允许: ${frame.action}`);
        if (frame.action === 'session.subscribe') {
          if (!frame.sessionId) throw new Error('缺少 sessionId');
          reply(true, sm.subscribe(sub, frame.sessionId, frame.payload?.afterSeq));
          return;
        }
        if (frame.action === 'session.unsubscribe') {
          sm.unsubscribe(sub, frame.sessionId);
          reply(true, true);
          return;
        }
        const data = await sm.dispatch(frame.action, frame.sessionId, frame.payload);
        reply(true, data);
      } catch (e: any) {
        reply(false, undefined, e?.message || String(e));
      }
    });

    ws.on('close', () => {
      sm.globalSubscribers.delete(sub);
      sm.unsubscribe(sub);
    });
    ws.on('error', () => { /* close 会跟着触发 */ });
  });
}
