/**
 * 终端 WebSocket：/ws/term?token=xx&id=<termId>，一个连接对应一个终端。
 * 客户端 → 服务端：JSON {type:'input',data} / {type:'resize',cols,rows}
 * 服务端 → 客户端：原始输出文本（attach 时先回放缓冲）；退出时 JSON {type:'exit',code}
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { TerminalManager } from '../terminal/manager';

export function attachTermWs(wss: WebSocketServer, tm: TerminalManager) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const id = url.searchParams.get('id') || '';
    // 输出走二进制帧，控制消息（exit）走文本 JSON 帧，避免与终端输出内容混淆
    const detach = tm.attach(
      id,
      data => { if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, 'utf8')); },
      code => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'exit', code })); },
    );
    if (!detach) { ws.close(4404, 'terminal not found'); return; }

    ws.on('message', raw => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type === 'input' && typeof msg.data === 'string') tm.write(id, msg.data);
      else if (msg?.type === 'resize') tm.resize(id, Number(msg.cols), Number(msg.rows));
    });
    ws.on('close', () => detach());
    ws.on('error', () => undefined);
  });
}
