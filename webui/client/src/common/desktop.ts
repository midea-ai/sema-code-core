/** 桌面版（desktop/ Electron 壳）preload 注入的标记与原生能力；网页模式下为 undefined。定义见 desktop/src/preload.ts */
export interface DesktopBridge {
  platform: string;
  electron: string;
  /** Dock / 任务栏图标角标数字，0 清除 */
  setBadgeCount(n: number): void;
  /** 窗口从隐藏/最小化被 Dock 唤起时回调，返回取消订阅函数 */
  onActivate(cb: () => void): () => void;
  /** 窗口进入/退出全屏时回调（页面加载完也会收到一次当前状态），返回取消订阅函数 */
  onFullScreen(cb: (on: boolean) => void): () => void;
}
export const desktop = (window as any).sema?.desktop as DesktopBridge | undefined;

/** macOS 桌面版：标题栏隐藏，红绿灯嵌在页面左上角，侧栏顶部需让位并作为窗口拖动区 */
export const macTitleBar = desktop?.platform === 'darwin';

/**
 * macOS 全屏时红绿灯隐藏，给它让的位要收回：在 <html> 上打 mac-fullscreen 类，
 * 让位的样式用 [html.mac-fullscreen_&]: 变体切回网页模式的间距（Tailwind 按字面量扫描类名，变体必须整串写死不能拼接）
 */
if (macTitleBar) desktop?.onFullScreen((on) => document.documentElement.classList.toggle('mac-fullscreen', on));

/**
 * 侧栏收起时各页面头部行的左内边距，给「展开 + 新会话」两个按钮（各 23px，间距 4px）让位：
 * 网页模式按钮从 8px 起，到 58px；macOS 桌面版还要给红绿灯让位，按钮从 76px 起，到 126px（全屏时同网页模式）
 */
export const collapsedHeaderPad = macTitleBar ? 'pl-[132px] [html.mac-fullscreen_&]:pl-16' : 'pl-16';

/** 右栏收起时页面头部行的右内边距，给「新建标签 + 展开」两个按钮（各 23px，间距 4px，距右 8px）让位 */
export const panelCollapsedHeaderPad = 'pr-16';
