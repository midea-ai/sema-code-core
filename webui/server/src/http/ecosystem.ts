/**
 * 生态市场：扫描 webui/resources/ 下的内置资源（skills/、mcp/），提供目录列表与安装/卸载。
 *   - 安装 = 原样复制到用户级：skill 复制目录到 <semaRoot>/skills/<id>，mcp 合并进 <semaRoot>/.mcp.json 的 mcpServers
 *   - 同名即视为已安装（不打来源标记），卸载 = 删同名目录 / 同名 key
 *   - 启停 = 读写用户级 <semaRoot>/settings.json 的 disabledSkills / disabledMcpServers（core 的分层禁用语义，
 *     用户级全局生效；skill 按 SKILL.md frontmatter 的 name 记，与 core 对齐）
 *   - 用户级与 CLI / IDE 插件共通（同一个 semaRoot）
 * 加新资源只需往 resources/skills/ 丢目录（含 SKILL.md，可选 card.json）、往 resources/mcp/ 丢 json（card + server）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { EcoItem, EcoInstalled, EcoInstalledSkill, EcoInstalledMcp } from '../../../shared/types';

const execFileP = promisify(execFile);

// dist 产物为 webui/server/dist/index.js（cjs 单文件），__dirname 即 dist 目录
const RESOURCES_DIR = path.join(__dirname, '..', '..', 'resources');

/** 用户级根目录：与 core 的 getSemaRootDir 同规则（SEMA_ROOT 环境变量，否则 ~/.sema） */
function semaRoot(): string {
  return process.env.SEMA_ROOT ? path.resolve(process.env.SEMA_ROOT) : path.join(os.homedir(), '.sema');
}
const userSkillDir = (id: string) => path.join(semaRoot(), 'skills', id);
const userMcpFile = () => path.join(semaRoot(), '.mcp.json');
const userSettingsFile = () => path.join(semaRoot(), 'settings.json');

interface Card { name?: string; description?: string; category?: string; order?: number }
/**
 * 远程技能来源：GitHub 仓库 + ref + 仓库内子目录。
 * ref 选填：不填时用 HEAD（默认分支最新，适合自己可控的仓库）；
 * 第三方仓库建议钉死 commit/tag，内容不可变、供应链可控
 */
interface RemoteSource { repo: string; ref: string; path: string }
/**
 * dir = 本地目录形式（resources/skills/<id>/）；source = 远程配置形式（resources/skills/<id>.json）。
 * skillName = SKILL.md frontmatter 的 name（core 按它加载/禁用，可能与安装目录名不同）：
 * 本地取 frontmatter，远程取配置的 skillName 字段，缺省回退 source.path 最后一段目录名
 */
interface SkillRes { kind: 'skill'; id: string; card: Card; skillName: string; dir?: string; source?: RemoteSource }
interface McpRes { kind: 'mcp'; id: string; card: Card; server: Record<string, unknown> }
type Resource = SkillRes | McpRes;

function parseRemoteSource(v: any): RemoteSource | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(v?.repo || '')) return null;
  const ref = v?.ref == null || v.ref === '' ? 'HEAD' : v.ref;
  if (typeof ref !== 'string' || !/^[\w./-]+$/.test(ref)) return null;
  if (typeof v?.path !== 'string' || !v.path || v.path.includes('..')) return null;
  return { repo: v.repo, ref, path: v.path.replace(/^\/+|\/+$/g, '') };
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** SKILL.md frontmatter 兜底解析：card.json 缺失时取 name/description 当展示文案 */
function parseFrontmatter(file: string): Card {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const lines = m[1].split(/\r?\n/);
    const pick = (key: string) => {
      const idx = lines.findIndex(l => l.startsWith(`${key}:`));
      if (idx === -1) return undefined;
      const inline = lines[idx].slice(key.length + 1).trim();
      // 块标量：|（保留换行）或 >（折叠为空格），兼容 |- >- |+ >+ 变体
      if (/^[|>][+-]?$/.test(inline)) {
        const block: string[] = [];
        for (let i = idx + 1; i < lines.length; i++) {
          if (lines[i].trim() === '') { block.push(''); continue; }
          if (!/^\s/.test(lines[i])) break;
          block.push(lines[i].trim());
        }
        while (block.length && !block[block.length - 1]) block.pop();
        return block.join(inline[0] === '>' ? ' ' : '\n') || undefined;
      }
      return inline.replace(/^["']|["']$/g, '') || undefined;
    };
    return { name: pick('name'), description: pick('description') };
  } catch { return {}; }
}

/** 扫描内置资源。id 取子目录名 / 文件名（无路径分隔符），install/uninstall 按 id 在扫描结果中找回，天然白名单 */
function scanResources(): Resource[] {
  const out: Resource[] = [];
  const skillsRoot = path.join(RESOURCES_DIR, 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // 本地目录形式：自研/内网技能整目录放入
        const dir = path.join(skillsRoot, e.name);
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        const fm = parseFrontmatter(path.join(dir, 'SKILL.md'));
        const card: Card = readJson(path.join(dir, 'card.json')) || fm;
        out.push({ kind: 'skill', id: e.name, dir, card, skillName: fm.name || e.name });
      } else if (e.isFile() && e.name.endsWith('.json')) {
        // 远程配置形式：开源技能只记来源，安装时从 GitHub 拉取
        const conf = readJson(path.join(skillsRoot, e.name));
        const source = parseRemoteSource(conf?.source);
        if (!source) continue;
        const skillName = (typeof conf.skillName === 'string' && conf.skillName.trim()) || source.path.split('/').pop() || '';
        out.push({ kind: 'skill', id: e.name.replace(/\.json$/, ''), card: conf.card || {}, source, skillName });
      }
    }
  }
  const mcpRoot = path.join(RESOURCES_DIR, 'mcp');
  if (fs.existsSync(mcpRoot)) {
    for (const e of fs.readdirSync(mcpRoot, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const conf = readJson(path.join(mcpRoot, e.name));
      if (!conf?.server || typeof conf.server !== 'object' || !Object.keys(conf.server).length) continue;
      out.push({ kind: 'mcp', id: e.name.replace(/\.json$/, ''), card: conf.card || {}, server: conf.server });
    }
  }
  return out;
}

/** 读用户级 .mcp.json；不存在返回空对象，JSON 损坏时抛错（绝不覆盖用户手写的文件） */
export function readUserMcp(): any {
  const file = userMcpFile();
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('用户级 .mcp.json 解析失败，请先手动修复该文件'); }
}

function writeUserMcp(conf: any) {
  const file = userMcpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
}

/** 读用户级 settings.json；不存在返回空对象，JSON 损坏时抛错（绝不覆盖用户手写的文件） */
function readUserSettings(): any {
  const file = userSettingsFile();
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('用户级 settings.json 解析失败，请先手动修复该文件'); }
}

function writeUserSettings(conf: any) {
  const file = userSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
}

type DisabledKey = 'disabledSkills' | 'disabledMcpServers';

function readDisabledSet(key: DisabledKey): Set<string> {
  try {
    const v = readUserSettings()[key];
    return new Set(Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/** 在用户级 settings 的禁用列表中增/删一个名字（保留文件其他字段） */
function setDisabled(key: DisabledKey, name: string, disabled: boolean) {
  const settings = readUserSettings();
  const list: string[] = Array.isArray(settings[key]) ? settings[key] : [];
  settings[key] = disabled ? (list.includes(name) ? list : [...list, name]) : list.filter(n => n !== name);
  writeUserSettings(settings);
}

/**
 * 老约定迁移：早期 webui 用 .mcp.json 内 mcpServersDisabled 表示禁用。
 * 现改为 core 的 settings 语义：条目挪回 mcpServers，禁用状态转记到用户级 settings 的 disabledMcpServers。
 */
function migrateLegacyDisabled() {
  let conf: any;
  try { conf = readUserMcp(); } catch { return; }
  const legacy = conf.mcpServersDisabled;
  if (!legacy || typeof legacy !== 'object' || !Object.keys(legacy).length) {
    if ('mcpServersDisabled' in conf) { delete conf.mcpServersDisabled; writeUserMcp(conf); }
    return;
  }
  try {
    const servers = { ...(conf.mcpServers || {}) };
    for (const [name, config] of Object.entries(legacy)) {
      if (!(name in servers)) servers[name] = config;
      setDisabled('disabledMcpServers', name, true);
    }
    delete conf.mcpServersDisabled;
    writeUserMcp({ ...conf, mcpServers: servers });
  } catch { /* settings 损坏时保留老字段，等修复后下次再迁 */ }
}

function isInstalled(r: Resource): boolean {
  if (r.kind === 'skill') return fs.existsSync(userSkillDir(r.id));
  try {
    const servers = readUserMcp().mcpServers || {};
    return Object.keys(r.server).every(k => k in servers);
  } catch { return false; }
}

export function listCatalog(): EcoItem[] {
  migrateLegacyDisabled();
  // 组内展示顺序：card.order 小的在前（缺省排最后），同序按 id 字母序
  return scanResources()
    .sort((a, b) => ((a.card.order ?? Infinity) - (b.card.order ?? Infinity)) || a.id.localeCompare(b.id))
    .map(r => {
    const source = r.kind === 'skill' ? r.source : undefined;
    return {
      id: r.id,
      kind: r.kind,
      name: r.card.name || r.id,
      description: r.card.description || '',
      category: r.card.category,
      skillName: r.kind === 'skill' ? r.skillName : undefined,
      repo: source?.repo,
      repoUrl: source ? `https://github.com/${source.repo}/tree/${source.ref}/${source.path}` : undefined,
      installed: isInstalled(r),
    };
  });
}

/** 远程资源包大小上限 */
const TARBALL_MAX = 100 * 1024 * 1024;

/** 进行中的 tarball 下载：同仓库同 ref 的并行安装共享一次下载（连点同仓库多个技能只下一遍） */
const inflightTarballs = new Map<string, Promise<Buffer>>();

/** 下载 GitHub 仓库 tarball（codeload 一次请求，无 API 限流），60s 超时；按 repo@ref 去重进行中的请求 */
function downloadTarball(source: RemoteSource): Promise<Buffer> {
  const key = `${source.repo}@${source.ref}`;
  const inflight = inflightTarballs.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await fetch(`https://codeload.github.com/${source.repo}/tar.gz/${encodeURIComponent(source.ref)}`, { signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > TARBALL_MAX) throw new Error('资源包过大');
      return buf;
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError' ? '下载超时，请检查网络后重试' : `下载失败（${source.repo}）: ${e?.message || e}`);
    } finally { clearTimeout(timer); }
  })();
  inflightTarballs.set(key, task);
  // 完成即移除（成功失败都清，失败后重试会重新下载）；两参 then 避免派生出未处理的 rejection
  const clean = () => { inflightTarballs.delete(key); };
  task.then(clean, clean);
  return task;
}

/**
 * 拉取远程技能并落到用户级：先在临时目录下载解压校验，成功后才替换目标目录（失败不留半截）
 */
async function fetchRemoteSkill(r: SkillRes): Promise<void> {
  const source = r.source!;
  const tarball = await downloadTarball(source);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-eco-'));
  try {
    const tarFile = path.join(tmp, 'src.tar.gz');
    fs.writeFileSync(tarFile, tarball);
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    await execFileP('tar', ['-xzf', tarFile, '-C', out]);
    // tarball 顶层是 <repo>-<ref> 单目录，名字随 ref 形态变化，取解出来的唯一目录即可
    const top = fs.readdirSync(out, { withFileTypes: true }).find(e => e.isDirectory());
    const srcDir = top ? path.join(out, top.name, source.path) : '';
    if (!srcDir || !fs.existsSync(path.join(srcDir, 'SKILL.md'))) throw new Error(`资源包中未找到 ${source.path}/SKILL.md，清单的 path 可能有误`);
    const dest = userSkillDir(r.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 安装到用户级；同名已存在且未确认覆盖时返回 needConfirm，由前端二次确认后带 overwrite 重发 */
export async function installResource(id: string, overwrite: boolean): Promise<true | { needConfirm: true }> {
  const r = scanResources().find(x => x.id === id);
  if (!r) throw new Error(`资源不存在: ${id}`);
  if (r.kind === 'skill') {
    const dest = userSkillDir(r.id);
    if (fs.existsSync(dest) && !overwrite) return { needConfirm: true };
    if (r.dir) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(r.dir, dest, { recursive: true });
    } else {
      await fetchRemoteSkill(r);
    }
    return true;
  }
  const conf = readUserMcp();
  const servers = { ...(conf.mcpServers || {}) };
  if (Object.keys(r.server).some(k => k in servers) && !overwrite) return { needConfirm: true };
  Object.assign(servers, r.server);
  writeUserMcp({ ...conf, mcpServers: servers });
  return true;
}

export function uninstallResource(id: string): true {
  const r = scanResources().find(x => x.id === id);
  if (!r) throw new Error(`资源不存在: ${id}`);
  if (r.kind === 'skill') {
    fs.rmSync(userSkillDir(r.id), { recursive: true, force: true });
    return true;
  }
  const conf = readUserMcp();
  const servers = { ...(conf.mcpServers || {}) };
  for (const k of Object.keys(r.server)) { delete servers[k]; setDisabled('disabledMcpServers', k, false); setUseTools(k, null); }
  writeUserMcp({ ...conf, mcpServers: servers });
  return true;
}

// ==================== 已安装（用户级全量，不限市场来源） ====================

/** 校验列表接口返回过的 skill 目录名，杜绝路径拼接穿越 */
function checkSkillId(id: string): string {
  if (!id || id === '.disabled' || id.includes('/') || id.includes('\\') || id.includes('..')) throw new Error(`非法 skill id: ${id}`);
  const dir = userSkillDir(id);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`Skill 不存在: ${id}`);
  return dir;
}

/** MCP server 的一行摘要：stdio 显示命令行，远程显示 url */
function mcpSummary(config: any): string {
  if (config?.url) return String(config.url);
  if (config?.command) return [config.command, ...(Array.isArray(config.args) ? config.args : [])].join(' ');
  return '';
}

/**
 * 用户级已安装列表。
 *   - skill：~/.sema/skills/ 一层子目录（含 SKILL.md 才算），名称/描述取 frontmatter，id 为目录名；
 *     enabled 按 frontmatter name 查用户级 settings 的 disabledSkills（core 同语义）
 *   - mcp：~/.sema/.mcp.json 的 mcpServers；enabled 查用户级 settings 的 disabledMcpServers
 */
export function listInstalled(): EcoInstalled {
  migrateLegacyDisabled();
  // 市场卡片中文名映射（安装目录名 / 技能名 -> 卡片名）：技能名多为英文，已安装列表补个可读标签
  const titles = new Map<string, string>();
  for (const r of scanResources()) {
    if (!r.card.name) continue;
    if (r.kind === 'skill') {
      titles.set(`skill:${r.id}`, r.card.name);
      titles.set(`skill:${r.skillName}`, r.card.name);
    } else {
      // mcp 安装后的 id 是 server 配置的 key，不是清单文件名
      for (const k of Object.keys(r.server)) titles.set(`mcp:${k}`, r.card.name);
    }
  }
  const disabledSkills = readDisabledSet('disabledSkills');
  const skills: EcoInstalledSkill[] = [];
  const skillsRoot = path.join(semaRoot(), 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = path.join(skillsRoot, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(file);
      const name = fm.name || e.name;
      const title = titles.get(`skill:${e.name}`) || titles.get(`skill:${name}`);
      skills.push({ id: e.name, name, description: fm.description || '', enabled: !disabledSkills.has(name), title });
    }
  }
  const disabledMcp = readDisabledSet('disabledMcpServers');
  const useToolsMap = readUseToolsMap();
  const mcp: EcoInstalledMcp[] = [];
  for (const [name, config] of Object.entries<any>(readUserMcp().mcpServers || {})) {
    mcp.push({ id: name, name, description: mcpSummary(config), enabled: !disabledMcp.has(name), config, title: titles.get(`mcp:${name}`), useTools: useToolsMap[name] ?? null });
  }
  mcp.sort((a, b) => a.id.localeCompare(b.id));
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills, mcp };
}

/** 启停：写用户级 settings 的 disabledSkills / disabledMcpServers（全局生效；skill 按 frontmatter name 记） */
export function toggleInstalled(kind: 'skill' | 'mcp', id: string, enabled: boolean): true {
  if (kind === 'skill') {
    const dir = checkSkillId(id);
    const fm = parseFrontmatter(path.join(dir, 'SKILL.md'));
    setDisabled('disabledSkills', fm.name || id, !enabled);
    return true;
  }
  if (!((readUserMcp().mcpServers || {})[id])) throw new Error(`MCP server 不存在: ${id}`);
  setDisabled('disabledMcpServers', id, !enabled);
  return true;
}

export function removeInstalled(kind: 'skill' | 'mcp', id: string): true {
  if (kind === 'skill') {
    const dir = checkSkillId(id);
    // 删除前取 frontmatter name，顺手清掉禁用残留
    const fm = parseFrontmatter(path.join(dir, 'SKILL.md'));
    fs.rmSync(dir, { recursive: true, force: true });
    try { setDisabled('disabledSkills', fm.name || id, false); } catch { /* settings 损坏不阻塞删除 */ }
    return true;
  }
  const conf = readUserMcp();
  const servers = { ...(conf.mcpServers || {}) };
  if (!(id in servers)) throw new Error(`MCP server 不存在: ${id}`);
  delete servers[id];
  writeUserMcp({ ...conf, mcpServers: servers });
  try { setDisabled('disabledMcpServers', id, false); } catch { /* 同上 */ }
  try { setUseTools(id, null); } catch { /* 同上 */ }
  return true;
}

/** 用户级技能根目录：插件页文件窗口（伪作用域 ~skills）的根 */
export function userSkillsRoot(): string {
  return path.join(semaRoot(), 'skills');
}

/** 用户级 settings 的 enabledMcpServerUseTools（core 语义：无记录 = 全部可用） */
function readUseToolsMap(): Record<string, string[]> {
  try {
    const v = readUserSettings().enabledMcpServerUseTools;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** 在用户级 settings 的 enabledMcpServerUseTools 中写/删一个 server 的记录（null = 删除 = 全部可用） */
function setUseTools(id: string, toolNames: string[] | null) {
  const settings = readUserSettings();
  const map = { ...(settings.enabledMcpServerUseTools || {}) };
  if (toolNames === null) delete map[id]; else map[id] = toolNames;
  if (Object.keys(map).length) settings.enabledMcpServerUseTools = map; else delete settings.enabledMcpServerUseTools;
  writeUserSettings(settings);
}

/**
 * 更新单个 MCP server 的可用工具列表：写用户级 settings 的 enabledMcpServerUseTools。
 * toolNames 为 null 时删除记录（= 全部可用）。core 加载时用户级打底、项目级同名覆盖，全局生效
 */
export function updateMcpUseTools(id: string, toolNames: string[] | null): true {
  if (!((readUserMcp().mcpServers || {})[id])) throw new Error(`MCP server 不存在: ${id}`);
  if (toolNames !== null && (!Array.isArray(toolNames) || toolNames.some(t => typeof t !== 'string'))) throw new Error('toolNames 必须是字符串数组或 null');
  setUseTools(id, toolNames);
  return true;
}

/** 更新单个 MCP server 的配置 */
export function updateMcpConfig(id: string, config: unknown): true {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象');
  const conf = readUserMcp();
  const servers = { ...(conf.mcpServers || {}) };
  if (!(id in servers)) throw new Error(`MCP server 不存在: ${id}`);
  servers[id] = config;
  writeUserMcp({ ...conf, mcpServers: servers });
  return true;
}
