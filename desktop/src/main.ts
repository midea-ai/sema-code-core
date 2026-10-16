/**
 * SemaWork 桌面版主进程。
 * 启动即起一个 utility 子进程跑 webui/server（dist/server-host.js；随机端口、每次启动随机 token），窗口加载该地址；
 * 主进程只管窗口与防睡眠。server 不在主进程里跑：worker 的 fork（CreateProcess）是同步调用，在窗口 UI 线程上会把界面卡住，
 * Windows 还会在调用进程的窗口上显示"启动中"转圈光标；挪到无窗口的子进程后两者都没有。
 * 关窗口 macOS 下隐藏（Dock 点击恢复），其他平台退出；退出前走 server 的优雅关闭。
 *
 * 环境变量 SEMA_DESKTOP_DEV_URL=http://localhost:5173：窗口改加载 vite dev 页面（热更新），
 * 此时 server 固定 3210 端口以匹配 vite 代理缺省值。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, shell, utilityProcess } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';

/** 主进程侧的 server 代理：接口与 server.ts 的 ServerHandle 一致，调用经 utility 进程 IPC 转发（见 server-host.ts 的协议） */
interface ServerHandle {
  host: string; port: number; token: string; url: string;
  close(): Promise<void>;
  /** 设置项「运行任务时阻止系统睡眠」：off / ac（仅接电源时）/ always */
  preventSleepMode(): Promise<'off' | 'ac' | 'always'>;
  /** 是否有不该被睡眠打断的工作 */
  hasActiveWork(): Promise<boolean>;
}
type ServerRequest = 'preventSleepMode' | 'hasActiveWork' | 'close';

/** 防睡眠轮询间隔；任务结束后再按住这么久才放开，避免连续回合间抖动 */
const KEEP_AWAKE_POLL_MS = 30_000;
const KEEP_AWAKE_HOLD_MS = 2 * 60_000;

/** esbuild 产物：server-host.js 是 utility 子进程入口，它加载同目录的 server.js（与 worker-entry.js、public/ 同目录），运行时依赖来自 desktop/node_modules */
const SERVER_HOST_ENTRY = path.join(__dirname, 'server-host.js');
const SERVER_ENTRY = path.join(__dirname, 'server.js');
/** 主进程 → server 进程的请求超时；close 发出后再等进程退出的上限，超过则强杀；启动后多久没 ready 视为失败 */
const SERVER_REQ_TIMEOUT_MS = 10_000;
const SERVER_EXIT_WAIT_MS = 5_000;
const SERVER_BOOT_TIMEOUT_MS = 30_000;
const DEV_URL = process.env.SEMA_DESKTOP_DEV_URL || '';

let win: BrowserWindow | null = null;
let handle: ServerHandle | null = null;
let quitting = false;
let blockerId: number | null = null;
let lastActiveAt = 0;

// 与 CLI 入口一致：漏掉的异步异常只打日志，不让整个应用（含所有 worker/终端）崩掉
process.on('uncaughtException', (err) => { console.error('[desktop] uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('[desktop] unhandledRejection:', reason); });

app.setName('SemaWork');
// 开发态跑的是 Electron 原始二进制，Dock 图标是它自带的；打包后由 electron-builder 写进 .app，这里只管开发态
if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));

// 页面侧「已完成未看」会话数 → Dock / 任务栏角标（preload 的 setBadgeCount）
ipcMain.on('sema:badge', (_e, n: unknown) => {
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0) app.setBadgeCount(n);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (e) => {
    quitting = true;
    if (!handle) return;
    e.preventDefault();
    const h = handle;
    handle = null;
    h.close().catch((err) => console.error('[desktop] 关闭服务失败:', err)).finally(() => app.quit());
  });
  app.whenReady().then(boot);
}

/**
 * 从 Finder / 启动台等 GUI 方式启动时拿不到用户 shell 的 PATH（macOS 下只有 /usr/bin:/bin 一类），
 * Agent 跑 git / node / npm 会找不到命令。这里从登录 shell 取一次 PATH 覆盖进来，worker 与终端都继承。
 */
function inheritShellPath(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const marker = '__SEMA_PATH__';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5000 }, (err, stdout) => {
      if (err) console.warn('[desktop] 读取 shell PATH 失败:', err.message);
      const parts = String(stdout || '').split(marker);
      if (parts.length >= 3 && parts[1]) process.env.PATH = parts[1];
      resolve();
    });
  });
}

async function boot() {
  const missing = [SERVER_HOST_ENTRY, SERVER_ENTRY].find((f) => !fs.existsSync(f));
  if (missing) {
    dialog.showErrorBox('SemaWork', `未找到服务端构建产物：\n${missing}\n\n请先执行 npm run build`);
    app.quit();
    return;
  }
  // 先建窗口（暂不加载页面）再起 server：渲染进程与 server 进程的创建重叠。Windows 上每起一个 electron.exe 进程
  // 都要被杀毒按体积扫一遍（约 2 秒），串行是两段，并行只剩一段；窗口在页面首帧前不显示，用户看不到空窗
  createWindow();
  await inheritShellPath();
  try {
    handle = await startServerProcess({ port: DEV_URL ? 3210 : 0, token: randomBytes(16).toString('hex') });
  } catch (e: any) {
    dialog.showErrorBox('SemaWork', `服务启动失败：${e?.message || e}`);
    app.quit();
    return;
  }
  console.log(`[desktop] server ${handle.url}`);
  loadPage();
  startKeepAwake();
}

/**
 * 在 utility 子进程里起 server，返回代理句柄。PATH 等环境在 inheritShellPath 之后整体传下去，worker 与终端照旧继承。
 * 子进程意外退出（不是我们发的 close、也不在退出流程中）：弹框后退出应用；worker 随 IPC 断开自行 dispose。
 */
function startServerProcess(opts: { port: number; token: string }): Promise<ServerHandle> {
  const child = utilityProcess.fork(SERVER_HOST_ENTRY, [], {
    env: {
      ...process.env,
      SEMA_DESKTOP_PORT: String(opts.port),
      SEMA_DESKTOP_TOKEN: opts.token,
      // core worker 是线程，整个 server 进程共用一个 libuv 线程池（异步 fs / DNS / zlib）：缺省 4 不够多个会话同时读写文件，放宽到 16
      UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16',
    },
    stdio: 'inherit',
    serviceName: 'sema-server',
  });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  let exited = false;
  let closing = false;
  const exitedP = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const request = (type: ServerRequest, timeoutMs = SERVER_REQ_TIMEOUT_MS) => new Promise<any>((resolve, reject) => {
    if (exited) { reject(new Error('server process exited')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`server request timeout: ${type}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.postMessage({ id, type });
  });
  const close = async () => {
    closing = true;
    if (exited) return;
    await request('close').catch((err) => console.error('[desktop] 关闭服务失败:', err?.message || err));
    await Promise.race([exitedP, new Promise<void>((r) => setTimeout(r, SERVER_EXIT_WAIT_MS))]);
    if (!exited) child.kill();
  };

  return new Promise<ServerHandle>((resolve, reject) => {
    let ready = false;
    // 子进程既不报 ready / error 也不退出的极端情况（server-host 自身已兜住同步异常）：不能让窗口永远开不出来
    const bootTimer = setTimeout(() => { reject(new Error(`服务进程 ${SERVER_BOOT_TIMEOUT_MS / 1000} 秒内未就绪`)); child.kill(); }, SERVER_BOOT_TIMEOUT_MS);
    child.on('message', (m: any) => {
      if (!m) return;
      if (m.type === 'ready') {
        clearTimeout(bootTimer);
        ready = true;
        resolve({
          host: m.host, port: m.port, token: m.token, url: m.url, close,
          preventSleepMode: () => request('preventSleepMode'),
          hasActiveWork: () => request('hasActiveWork'),
        });
        return;
      }
      if (m.type === 'error') { clearTimeout(bootTimer); reject(new Error(m.message)); return; }
      if (typeof m.id !== 'number') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'server error'));
    });
    child.on('exit', (code) => {
      clearTimeout(bootTimer);
      exited = true;
      for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error(`server process exited (code ${code})`)); }
      if (!ready) { reject(new Error(`服务进程启动即退出（code ${code}）`)); return; }
      if (closing || quitting) return;
      console.error(`[desktop] 服务进程异常退出 code=${code}`);
      handle = null;
      dialog.showErrorBox('SemaWork', `服务进程异常退出（code ${code}），应用将退出`);
      app.quit();
    });
  });
}

/**
 * 运行任务时阻止系统睡眠（设置项 preventSleep，缺省关闭）。
 * prevent-app-suspension 只拦闲置自动睡眠，屏幕照常熄灭；合盖、菜单里手动睡眠拦不住，这是系统限制。
 * 按住的依据由服务端判定（处理中的会话 / 运行中的后台任务 / 临近触发的定时任务），这里按设置和电源状态决定是否执行；
 * 工作结束后再按住 KEEP_AWAKE_HOLD_MS 才放开。
 */
function startKeepAwake() {
  const timer = setInterval(() => { void keepAwakeTick(); }, KEEP_AWAKE_POLL_MS);
  timer.unref?.();
  // 电源状态变化（拔/插电源）立即重算，不等下一轮
  powerMonitor.on('on-ac', () => { void keepAwakeTick(); });
  powerMonitor.on('on-battery', () => { void keepAwakeTick(); });
  void keepAwakeTick();
}

async function keepAwakeTick() {
  if (!handle) { setKeepAwake(false); return; }
  let mode: 'off' | 'ac' | 'always' = 'off';
  try { mode = await handle.preventSleepMode(); } catch { mode = 'off'; }
  const allowed = mode === 'always' || (mode === 'ac' && !powerMonitor.isOnBatteryPower());
  let active = false;
  if (allowed) { try { active = await handle.hasActiveWork(); } catch { active = false; } }
  const now = Date.now();
  if (active) lastActiveAt = now;
  setKeepAwake(allowed && (active || now - lastActiveAt < KEEP_AWAKE_HOLD_MS));
}

function isKeepAwake(): boolean { return blockerId !== null && powerSaveBlocker.isStarted(blockerId); }

function setKeepAwake(on: boolean) {
  if (on === isKeepAwake()) return;
  if (on) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  else { if (blockerId !== null) powerSaveBlocker.stop(blockerId); blockerId = null; }
  console.log(`[desktop] keep-awake ${on ? 'on' : 'off'}`);
  win?.webContents.send('sema:keepawake', on);
}

function pageUrl(): string {
  if (!handle) return 'about:blank';
  const base = DEV_URL || `http://${handle.host}:${handle.port}`;
  return `${base.replace(/\/$/, '')}/?token=${handle.token}`;
}

function isOwnOrigin(url: string): boolean {
  try { return new URL(url).origin === new URL(pageUrl()).origin; } catch { return false; }
}

function showWindow() {
  if (win) {
    const wasHidden = !win.isVisible() || win.isMinimized();
    win.show();
    win.focus();
    // 从隐藏/最小化被 Dock 唤起：通知页面跳到最近完成未看的会话（页面侧 onActivate）
    if (wasHidden) win.webContents.send('sema:activate');
    return;
  }
  if (handle) { createWindow(); loadPage(); }
}

function createWindow() {
  // Windows/Linux 去掉 Electron 默认的 File/Edit/View/Window 菜单栏；macOS 保留，Cmd+C/V/Q 等快捷键靠菜单 role 生效
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600,
    title: 'SemaWork', show: false,
    // macOS 隐藏标题栏文字，红绿灯嵌进页面侧栏顶部（页面侧按 window.sema.desktop.platform 让位并设拖动区）
    // y 是按钮框（高 16px）的顶边，14 + 8 = 22 正好落在页面头部行（44px）的垂直中线上
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    // Windows/Linux 开发态跑的是 Electron 原始二进制，窗口与任务栏图标是它自带的；打包后由 electron-builder 写进 exe，这里只管开发态
    ...(process.platform !== 'darwin' && !app.isPackaged ? { icon: path.join(__dirname, '..', 'assets', 'icon-win.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // 页面里 window.open / target=_blank 一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url).catch(() => undefined); return { action: 'deny' }; });
  // 主框架只允许停留在本地服务（或 vite dev）地址，其他跳转交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnOrigin(url)) return;
    e.preventDefault();
    shell.openExternal(url).catch(() => undefined);
  });
  win.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') { e.preventDefault(); win?.hide(); }
  });
  win.on('closed', () => { win = null; });
  // macOS 全屏时红绿灯隐藏，通知页面收回给红绿灯让的位（页面侧 onFullScreen）；页面刷新后也要补发当前状态
  const sendFullScreen = () => win?.webContents.send('sema:fullscreen', win.isFullScreen());
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('did-finish-load', sendFullScreen);
  // 防睡眠当前是否生效，页面刷新后同样补发
  win.webContents.on('did-finish-load', () => win?.webContents.send('sema:keepawake', isKeepAwake()));
}

/** server 就绪后再加载页面（createWindow 只建窗口，见 boot） */
function loadPage() {
  win?.loadURL(pageUrl());
}
