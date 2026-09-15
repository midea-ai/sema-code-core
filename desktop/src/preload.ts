/**
 * 渲染进程 preload：只暴露一个 window.sema.desktop 标记，页面据此判断自己跑在桌面版里。
 * 阶段二再往这里加原生能力（选目录、打开文件、通知等）。
 */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('sema', {
  desktop: {
    platform: process.platform,
    electron: process.versions.electron,
  },
});
