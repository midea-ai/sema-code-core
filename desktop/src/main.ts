/**
 * SemaWork 桌面版主进程。
 * 启动即在进程内拉起 webui/server（随机端口、每次启动随机 token），窗口加载该地址；
 * 关窗口 macOS 下隐藏（Dock 点击恢复），其他平台退出；退出前走 server 的优雅关闭。
 *
 * 环境变量 SEMA_DESKTOP_DEV_URL=http://localhost:5173：窗口改加载 vite dev 页面（热更新），
 * 此时 server 固定 3210 端口以匹配 vite 代理缺省值。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';

interface ServerHandle { host: string; port: number; token: string; url: string; close(): Promise<void> }
interface ServerModule { startServer(opts: { port: number; host?: string; token: string }): Promise<ServerHandle> }

/** esbuild 从 webui/server 源码打进 dist 的服务端（与 worker-entry.js、public/ 同目录），运行时依赖来自 desktop/node_modules */
const SERVER_ENTRY = path.join(__dirname, 'server.js');
const DEV_URL = process.env.SEMA_DESKTOP_DEV_URL || '';

let win: BrowserWindow | null = null;
let handle: ServerHandle | null = null;
let quitting = false;

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
  if (!fs.existsSync(SERVER_ENTRY)) {
    dialog.showErrorBox('SemaWork', `未找到服务端构建产物：\n${SERVER_ENTRY}\n\n请先执行 npm run build`);
    app.quit();
    return;
  }
  await inheritShellPath();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startServer } = require(SERVER_ENTRY) as ServerModule;
  try {
    handle = await startServer({ port: DEV_URL ? 3210 : 0, host: '127.0.0.1', token: randomBytes(16).toString('hex') });
  } catch (e: any) {
    dialog.showErrorBox('SemaWork', `服务启动失败：${e?.message || e}`);
    app.quit();
    return;
  }
  console.log(`[desktop] server ${handle.url}`);
  createWindow();
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
  if (handle) createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600,
    title: 'SemaWork', show: false,
    // macOS 隐藏标题栏文字，红绿灯嵌进页面侧栏顶部（页面侧按 window.sema.desktop.platform 让位并设拖动区）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } } : {}),
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
  win.loadURL(pageUrl());
}
