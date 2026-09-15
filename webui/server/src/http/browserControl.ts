/**
 * 浏览器控制开关：开时补齐用户级 chrome-use skill 与用户级 chrome MCP，关时删除两者。
 * 逻辑对齐 IDE 插件的 BrowserControlManager，core 调用全部经配置 worker（sm.dispatch）：
 *
 * - skill：core 没有「新增 skill」接口，由服务端把 chrome/.sema/skills/chrome-use/ 拷到 ~/.sema/skills/ 后让 core 重扫；
 *   删除走 core.removeSkillConf（删目录 + 清缓存 + 清 settings.disabledSkills）。
 * - MCP：增删都走 core.addMCPServer / core.removeMCPServer（写 ~/.sema/.mcp.json、清 settings、断开 client）。
 * - 配置键 enableBrowserControl 只在动作全部成功后写入；任一步失败不回滚（动作幂等，重试即补齐）。
 * - 所有动作经一条 promise 链串行化：core 的两个 remove 都先查内存缓存，add / 拷目录后的 refresh 是异步的，
 *   快速点两下若不串行，remove 会因缓存里还没有该项而空转，文件里的项就残留了。
 * - webui 多 worker：配置 worker 动作完成后由路由层广播 refreshSkills / refreshMCPServerInfo，让会话 worker 同步。
 *
 * 资源来源（仓库里只保留 chrome/.sema 这一份，不复制）：
 *   桌面版打包时拷到 dist/resources/chrome，否则取仓库 chrome/.sema（webui/server/dist 上溯三级）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SessionManager } from '../sessions';
import type { BrowserControlState } from '../../../shared/types';

const SKILL_NAME = 'chrome-use';
const MCP_NAME = 'chrome';

const SOURCE_CANDIDATES = [
  path.join(__dirname, 'resources', 'chrome'),
  path.join(__dirname, '..', '..', '..', 'chrome', '.sema'),
];

function sourceDir(): string {
  const dir = SOURCE_CANDIDATES.find(d => fs.existsSync(path.join(d, '.mcp.json')));
  if (!dir) throw new Error(`未找到浏览器控制资源目录（${SOURCE_CANDIDATES.join(' / ')}）`);
  return dir;
}

/** 用户级根目录：与 core 的 getSemaRootDir 同规则（SEMA_ROOT 环境变量，否则 ~/.sema） */
function userSkillDir(): string {
  const root = process.env.SEMA_ROOT ? path.resolve(process.env.SEMA_ROOT) : path.join(os.homedir(), '.sema');
  return path.join(root, 'skills', SKILL_NAME);
}

export function browserControlState(enabled: boolean): BrowserControlState {
  return { supported: process.platform !== 'win32', experimental: process.platform === 'linux', enabled };
}

export class BrowserControl {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly sm: SessionManager) {}

  /** 执行开/关动作，串行化；返回动作完成后的开关值（失败则抛错，配置键保持原值） */
  setEnabled(enabled: boolean): Promise<boolean> {
    if (process.platform === 'win32') return Promise.reject(new Error('Windows 暂不支持浏览器控制'));
    const run = () => (enabled ? this.enable() : this.disable());
    const task = this.chain.then(run, run);
    this.chain = task.catch(() => undefined);
    return task;
  }

  private core(action: string, payload: any = {}): Promise<any> {
    return this.sm.dispatch(action, undefined, payload);
  }

  private async enable(): Promise<boolean> {
    const src = sourceDir();
    // 1. 用户级 skill 目录没有就整目录拷贝
    const dest = userSkillDir();
    if (!fs.existsSync(path.join(dest, 'SKILL.md'))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(src, 'skills', SKILL_NAME), dest, { recursive: true });
    }
    // 2. 让 core 重新扫描 skills，把新目录加载进缓存
    await this.core('core.getSkillsInfo', { refresh: true });
    // 3. 用户级没有 chrome MCP 就按模板添加
    const servers: any[] = await this.core('core.getMCPServerInfo');
    if (!findUserMcp(servers)) {
      const template = JSON.parse(fs.readFileSync(path.join(src, '.mcp.json'), 'utf8'));
      const entry = template?.mcpServers?.[MCP_NAME];
      if (!entry) throw new Error(`.mcp.json 缺少 mcpServers.${MCP_NAME}`);
      await this.core('core.addMCPServer', { config: { ...entry, name: MCP_NAME, scope: 'user' } });
    }
    // 4. 三步全部完成后才落配置键
    this.sm.registry.setBrowserControl(true);
    return true;
  }

  private async disable(): Promise<boolean> {
    // 1. 只删用户级 chrome MCP；项目级同名项不动
    const servers: any[] = await this.core('core.getMCPServerInfo');
    if (findUserMcp(servers)) await this.core('core.removeMCPServer', { name: MCP_NAME });
    // 2. 只删用户级 chrome-use skill
    const skills: any[] = await this.core('core.getSkillsInfo');
    if ((skills || []).some(s => s?.name === SKILL_NAME && s?.locate === 'user')) await this.core('core.removeSkillConf', { name: SKILL_NAME });
    this.sm.registry.setBrowserControl(false);
    return false;
  }
}

function findUserMcp(servers: any[]): boolean {
  return (servers || []).some(s => s?.config?.name === MCP_NAME && (s.scope ?? s.config?.scope) === 'user');
}
