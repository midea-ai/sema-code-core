/**
 * 渲染预览安装器：PREVIEW_MODE 打开时，在侧栏「会话」下注入一个本地 mock 会话（不经服务端），
 * 打开它即可查看 chat 中所有块/卡片的渲染；其余会话照常使用，两者可随时切换。
 *
 * 只在 main.tsx 里 `import './preview'` 一次；预览开关与数据全部在本目录（见 mockBlocks.ts）。
 * 关闭预览（PREVIEW_COMPONENTS = []）后本文件不做任何事。
 */
import type { SessionRecord } from '../../../shared/types';
import { useApp } from '../store/app';
import { useSessions } from '../store/sessions';
import { wsClient } from '../api/ws';
import { PREVIEW_MODE, getPreviewSnapshot, MOCK_FORK_PREVIEW } from './mockBlocks';

export const PREVIEW_SESSION_ID = '__preview__';
export const isPreviewSession = (id?: string) => id === PREVIEW_SESSION_ID;

const PREVIEW_WORKING_DIR = '/preview/workspace';

const record: SessionRecord = {
  id: PREVIEW_SESSION_ID,
  title: '🧪 渲染预览',
  workingDir: PREVIEW_WORKING_DIR,
  createdAt: Date.now(),
  lastActiveAt: Date.now() + 1e9, // 排在独立会话最前
  agentMode: 'Agent',
  permissionLevel: 'Bypass',
};

function installPreview() {
  // 1) 快照：直接写入 store，并接管 open()/loadSnapshot()，预览会话不请求服务端
  const sessions = useSessions.getState();
  useSessions.setState({
    snapshots: { ...sessions.snapshots, [PREVIEW_SESSION_ID]: getPreviewSnapshot(PREVIEW_SESSION_ID, PREVIEW_WORKING_DIR) },
    open: async id => { if (!isPreviewSession(id)) return sessions.open(id); },
    loadSnapshot: async id => { if (!isPreviewSession(id)) return sessions.loadSnapshot(id); },
    warm: id => { if (!isPreviewSession(id)) sessions.warm(id); },
  });

  // 2) WS 请求：预览会话的动作短路（不发给服务端），本地乐观更新仍生效（应答权限/提问/计划卡片可点）
  const origRequest = wsClient.request.bind(wsClient);
  wsClient.request = ((action: string, sessionId?: string, payload?: any, timeoutMs?: number) => {
    if (!isPreviewSession(sessionId)) return origRequest(action, sessionId, payload, timeoutMs);
    if (action === 'session.getCommandsInfo') return Promise.resolve({ commands: [], skills: [], agents: [] });
    if (action === 'session.getForkPreview') return Promise.resolve(MOCK_FORK_PREVIEW);
    if (action === 'session.fork') return Promise.resolve({ ok: false, error: '预览模式不支持回退' });
    if (action === 'session.processUserInput') {
      // 发送消息：本地追加一条用户气泡，方便看输入区交互
      const cur = useSessions.getState().snapshots[PREVIEW_SESSION_ID];
      if (cur) useSessions.setState(s => ({ snapshots: { ...s.snapshots, [PREVIEW_SESSION_ID]: { ...cur, blocks: [...cur.blocks, { kind: 'user', id: `mock-user-${Date.now()}`, ts: Date.now(), text: String(payload?.input ?? ''), doneTs: Date.now() }] } } }));
    }
    return Promise.resolve(undefined);
  }) as typeof wsClient.request;

  // 3) 注册表：bootstrap / registry:update 都来自服务端，不含预览会话，每次变化后补回
  let viewRestored = false;
  const ensureRecord = () => {
    const s = useApp.getState();
    if (!s.ready) return;
    if (!s.registry.sessions.some(x => x.id === PREVIEW_SESSION_ID)) {
      useApp.setState({ registry: { ...s.registry, sessions: [...s.registry.sessions, record] } });
    }
    // 刷新页面时 bootstrap 会因注册表里没有该会话而把视图退回 draft（在本回调之后同步执行），首次就绪后延后恢复一次
    if (!viewRestored) {
      viewRestored = true;
      queueMicrotask(() => {
        const v = useApp.getState().view;
        if (v.type !== 'chat' && localStorage.getItem('sema.webui.view')?.includes(PREVIEW_SESSION_ID)) useApp.getState().setView({ type: 'chat', sessionId: PREVIEW_SESSION_ID });
      });
    }
  };
  useApp.subscribe(ensureRecord);
  ensureRecord();
  console.log('[preview] 渲染预览已开启：侧栏「会话」→「🧪 渲染预览」；关闭请把 mockBlocks.ts 的 PREVIEW_COMPONENTS 设为 []');
}

if (PREVIEW_MODE) installPreview();
