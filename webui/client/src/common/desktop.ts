/** 桌面版（desktop/ Electron 壳）preload 注入的标记与原生能力；网页模式下为 undefined。定义见 desktop/src/preload.ts */
export interface DesktopBridge {
  platform: string;
  electron: string;
  /** Dock / 任务栏图标角标数字，0 清除 */
  setBadgeCount(n: number): void;
  /** 窗口从隐藏/最小化被 Dock 唤起时回调，返回取消订阅函数 */
  onActivate(cb: () => void): () => void;
}
export const desktop = (window as any).sema?.desktop as DesktopBridge | undefined;

/** macOS 桌面版：标题栏隐藏，红绿灯嵌在页面左上角，侧栏顶部需让位并作为窗口拖动区 */
export const macTitleBar = desktop?.platform === 'darwin';

/**
 * 侧栏收起时各页面头部行的左内边距，给「展开 + 新会话」两个按钮（各 23px，间距 4px）让位：
 * 网页模式按钮从 8px 起，到 58px；macOS 桌面版还要给红绿灯让位，按钮从 76px 起，到 126px
 */
export const collapsedHeaderPad = macTitleBar ? 'pl-[132px]' : 'pl-16';
