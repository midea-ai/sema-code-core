/**
 * 渲染进程 preload：暴露 window.sema.desktop，页面据此判断自己跑在桌面版里，并调用少量原生能力。
 * 新增原生能力（选目录、打开文件、通知等）都从这里加，页面侧类型在 webui/client/src/common/desktop.ts。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sema', {
  desktop: {
    platform: process.platform,
    electron: process.versions.electron,
    /** Dock / 任务栏图标角标数字，0 清除（macOS Dock、Linux launcher 生效，Windows 忽略） */
    setBadgeCount(n: number) { ipcRenderer.send('sema:badge', n); },
    /** 窗口从隐藏/最小化被 Dock 唤起时回调，返回取消订阅函数 */
    onActivate(cb: () => void) {
      const handler = () => cb();
      ipcRenderer.on('sema:activate', handler);
      return () => { ipcRenderer.off('sema:activate', handler); };
    },
  },
});
