import { WebSocketServer, WebSocket } from 'ws';
import { BridgeSession } from './session';
import { BridgeCommand } from './protocol';

const PORT = parseInt(process.env.SEMA_BRIDGE_PORT || '3765');
const WORKING_DIR = process.env.SEMA_WORKING_DIR || process.cwd();

const wss = new WebSocketServer({ port: PORT });
console.log(`[sema-bridge] Listening on ws://localhost:${PORT}`);
console.log(`[sema-bridge] Working directory: ${WORKING_DIR}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('[sema-bridge] Client connected');

    const session = new BridgeSession(ws, { workingDir: WORKING_DIR, logLevel: 'none' });

    ws.on('message', async (raw) => {
        try {
            const cmd: BridgeCommand = JSON.parse(raw.toString());
            await session.handle(cmd);
        } catch (err: any) {
            ws.send(JSON.stringify({ event: 'error', data: { message: err.message } }));
        }
    });

    ws.on('close', () => {
        console.log('[sema-bridge] Client disconnected');
        session.dispose();
    });

    ws.on('error', (err) => {
        console.error('[sema-bridge] WebSocket error:', err);
        session.dispose();
    });
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('[sema-bridge] Shutting down...');
    wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('[sema-bridge] Shutting down...');
    wss.close(() => process.exit(0));
});
