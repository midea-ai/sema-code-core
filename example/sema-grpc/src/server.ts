import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { BridgeSession } from './session';

const PORT = parseInt(process.env.SEMA_BRIDGE_PORT || '3766');
const WORKING_DIR = process.env.SEMA_WORKING_DIR || process.cwd();

const PROTO_PATH = path.join(process.cwd(), 'proto', 'sema.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;

function connect(call: grpc.ServerDuplexStream<any, any>): void {
  console.log('[sema-grpc] Client connected');

  const session = new BridgeSession(call, { workingDir: WORKING_DIR, logLevel: 'none' });

  call.on('data', async (cmd: any) => {
    try {
      await session.handle({
        id: cmd.id,
        action: cmd.action,
        payload: cmd.payload ? JSON.parse(cmd.payload) : undefined,
      });
    } catch (err: any) {
      call.write({ event: 'error', data: JSON.stringify({ message: err.message }), cmd_id: '' });
    }
  });

  call.on('end', () => {
    console.log('[sema-grpc] Client disconnected');
    session.dispose();
    call.end();
  });

  call.on('error', (err: Error) => {
    console.error('[sema-grpc] Stream error:', err);
    session.dispose();
  });
}

const server = new grpc.Server();
server.addService(proto.sema.SemaBridge.service, { Connect: connect });

server.bindAsync(
  `127.0.0.1:${PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) {
      console.error('[sema-grpc] Failed to start server:', err);
      process.exit(1);
    }
    console.log(`[sema-grpc] Listening on grpc://localhost:${port}`);
    console.log(`[sema-grpc] Working directory: ${WORKING_DIR}`);
  },
);

process.on('SIGTERM', () => {
  console.log('[sema-grpc] Shutting down...');
  server.tryShutdown(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[sema-grpc] Shutting down...');
  server.tryShutdown(() => process.exit(0));
});
