/**
 * 注册表：项目 / 会话索引（~/.sema/webui/index.json）+ 目录约定（~/Documents/Sema/...）。
 * 写入用临时文件 rename，避免半写。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { DEFAULT_PERMISSION_LEVEL, normalizeLevel } from '../../../shared/types';
import type { Registry, ProjectRecord, SessionRecord, WebUISettings, AgentMode, PermissionLevel } from '../../../shared/types';

export const WEBUI_HOME = path.join(os.homedir(), '.sema', 'webui');
export const TRANSCRIPT_DIR = path.join(WEBUI_HOME, 'transcripts');
export const SEMA_DOCS_ROOT = path.join(os.homedir(), 'Documents', 'Sema');
/** 进程级操作（模型配置等）专用的中性工作目录：放在 ~/.sema 下，避开 macOS 对 Documents 的访问授权限制 */
export const CONFIG_WORKSPACE = path.join(WEBUI_HOME, 'workspace');
const INDEX_FILE = path.join(WEBUI_HOME, 'index.json');
const SETTINGS_FILE = path.join(WEBUI_HOME, 'settings.json');

/** 不开放配置、始终生效的 core 选项 */
const FIXED_CORE_CONFIG = { stream: true, thinking: true } as const;

export const DEFAULT_SETTINGS: WebUISettings = {
  coreConfig: {
    stream: true,
    thinking: true,
    customRules: '- 中文回答',
    skipFileEditPermission: false,
    skipShellExecPermission: false,
    skipSkillPermission: false,
    skipMCPToolPermission: false,
    skipFetchUrlPermission: false,
    skipExternalFileReadPermission: true,
    disableBackgroundTasks: true,
    enableToolSearch: true,
    enableInputPrediction: true,
  },
  defaultAgentMode: 'Agent',
  defaultPermissionLevel: DEFAULT_PERMISSION_LEVEL,
};

export function writeJsonAtomic(file: string, data: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function dateFolder(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 删除独立会话目录后调用：上层若是日期目录（SEMA_DOCS_ROOT/<yyyy-mm-dd>）且已空则顺手移除（仅剩 .DS_Store 视为空） */
export function removeEmptyDateParent(workingDir: string) {
  const parent = path.dirname(path.resolve(workingDir));
  if (path.dirname(parent) !== path.resolve(SEMA_DOCS_ROOT)) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(path.basename(parent))) return;
  try {
    const rest = fs.readdirSync(parent).filter(n => n !== '.DS_Store');
    if (rest.length === 0) fs.rmSync(parent, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'project';
}

export class RegistryStore {
  private data: Registry;
  private settings: WebUISettings;

  constructor() {
    fs.mkdirSync(WEBUI_HOME, { recursive: true });
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    this.data = readJson<Registry>(INDEX_FILE, { schemaVersion: 1, projects: [], sessions: [] });
    const s = readJson<Partial<WebUISettings>>(SETTINGS_FILE, {});
    this.settings = {
      ...DEFAULT_SETTINGS, ...s,
      coreConfig: { ...DEFAULT_SETTINGS.coreConfig, ...(s.coreConfig || {}), ...FIXED_CORE_CONFIG },
    };
    // 旧数据里的 Ask 档位归一化为 AutoEdit
    if (s.defaultPermissionLevel) this.settings.defaultPermissionLevel = normalizeLevel(s.defaultPermissionLevel);
    for (const sess of this.data.sessions) {
      sess.permissionLevel = normalizeLevel(sess.permissionLevel);
      // 旧记录中无该字段：项目会话不管理目录，独立会话管理自己的目录。
      if (sess.managedWorkingDir === undefined) sess.managedWorkingDir = !sess.projectId;
    }
    // 旧项目记录无该字段：按目录是否位于受管根目录下推断。
    const managedRoot = path.resolve(SEMA_DOCS_ROOT) + path.sep;
    for (const proj of this.data.projects) {
      if (proj.managedWorkingDir === undefined) proj.managedWorkingDir = path.resolve(proj.workingDir).startsWith(managedRoot);
    }
  }

  // ---------- 读 ----------
  snapshot(): Registry { return JSON.parse(JSON.stringify(this.data)); }
  getSettings(): WebUISettings { return JSON.parse(JSON.stringify(this.settings)); }
  getProject(id: string) { return this.data.projects.find(p => p.id === id); }
  getSession(id: string) { return this.data.sessions.find(s => s.id === id); }
  listSessions() { return this.data.sessions; }

  /** 是否还有会话或项目引用同一个物理工作目录 */
  hasWorkingDirReference(workingDir: string, excludeSessionId?: string): boolean {
    const dir = path.resolve(workingDir);
    return this.data.sessions.some(s => s.id !== excludeSessionId && path.resolve(s.workingDir) === dir)
      || this.data.projects.some(p => path.resolve(p.workingDir) === dir);
  }

  private save() { writeJsonAtomic(INDEX_FILE, this.data); }

  updateSettings(patch: Partial<WebUISettings>): WebUISettings {
    this.settings = {
      ...this.settings, ...patch,
      coreConfig: { ...this.settings.coreConfig, ...(patch.coreConfig || {}), ...FIXED_CORE_CONFIG },
    };
    this.settings.defaultPermissionLevel = normalizeLevel(this.settings.defaultPermissionLevel);
    writeJsonAtomic(SETTINGS_FILE, this.settings);
    return this.getSettings();
  }

  // ---------- 项目 ----------
  createProject(name: string): ProjectRecord {
    const dir = path.join(SEMA_DOCS_ROOT, safeName(name));
    if (fs.existsSync(dir) && this.data.projects.some(p => p.workingDir === fs.realpathSync(dir))) {
      throw new Error(`项目已存在：${name}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const rec: ProjectRecord = { id: randomUUID(), name, workingDir: fs.realpathSync(dir), managedWorkingDir: true, createdAt: now, lastActiveAt: now };
    this.data.projects.push(rec);
    this.save();
    return rec;
  }

  importProject(dirPath: string, name?: string): ProjectRecord {
    const expanded = dirPath.startsWith('~') ? path.join(os.homedir(), dirPath.slice(1)) : dirPath;
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) throw new Error(`目录不存在：${dirPath}`);
    const real = fs.realpathSync(expanded);
    const exists = this.data.projects.find(p => p.workingDir === real);
    if (exists) return exists;
    const now = Date.now();
    const rec: ProjectRecord = { id: randomUUID(), name: name || path.basename(real), workingDir: real, managedWorkingDir: false, createdAt: now, lastActiveAt: now };
    this.data.projects.push(rec);
    this.save();
    return rec;
  }

  renameProject(id: string, name: string) {
    const p = this.getProject(id);
    if (!p) throw new Error('项目不存在');
    p.name = name;
    this.save();
    return p;
  }

  /** 移除项目索引（不删磁盘）；其下会话一并移除索引 */
  removeProject(id: string): SessionRecord[] {
    const removed = this.data.sessions.filter(s => s.projectId === id);
    this.data.projects = this.data.projects.filter(p => p.id !== id);
    this.data.sessions = this.data.sessions.filter(s => s.projectId !== id);
    this.save();
    return removed;
  }

  // ---------- 会话 ----------
  /** 创建会话记录：项目会话共享项目目录；独立会话独占 ~/Documents/Sema/<日期>/<会话id> */
  createSession(opts: { projectId?: string; agentMode?: AgentMode; permissionLevel?: PermissionLevel }): SessionRecord {
    const id = randomUUID();
    let workingDir: string;
    if (opts.projectId) {
      const p = this.getProject(opts.projectId);
      if (!p) throw new Error('项目不存在');
      workingDir = p.workingDir;
      p.lastActiveAt = Date.now();
    } else {
      workingDir = path.join(SEMA_DOCS_ROOT, dateFolder(), id);
      fs.mkdirSync(workingDir, { recursive: true });
      workingDir = fs.realpathSync(workingDir);
    }
    const now = Date.now();
    const rec: SessionRecord = {
      id, title: '', projectId: opts.projectId, workingDir, createdAt: now, lastActiveAt: now,
      managedWorkingDir: !opts.projectId,
      agentMode: opts.agentMode || this.settings.defaultAgentMode,
      permissionLevel: normalizeLevel(opts.permissionLevel || this.settings.defaultPermissionLevel),
    };
    this.data.sessions.push(rec);
    this.save();
    return rec;
  }

  /** 注册 core 已创建的分支会话；目录与会话配置严格继承源会话。 */
  createBranchedSession(sourceId: string, id: string): SessionRecord {
    const source = this.getSession(sourceId);
    if (!source) throw new Error('源会话不存在');
    if (!id || this.getSession(id)) throw new Error('分支会话 ID 无效或已存在');
    const now = Date.now();
    const rec: SessionRecord = {
      id,
      title: source.title ? `${source.title}（分支）` : '分支会话',
      projectId: source.projectId,
      workingDir: source.workingDir,
      managedWorkingDir: source.managedWorkingDir ?? !source.projectId,
      branchedFromSessionId: source.id,
      createdAt: now,
      lastActiveAt: now,
      agentMode: source.agentMode,
      permissionLevel: source.permissionLevel,
    };
    this.data.sessions.push(rec);
    if (source.projectId) {
      const project = this.getProject(source.projectId);
      if (project) project.lastActiveAt = now;
    }
    this.save();
    return rec;
  }

  updateSession(id: string, patch: Partial<SessionRecord>) {
    const s = this.getSession(id);
    if (!s) return undefined;
    Object.assign(s, patch);
    this.save();
    return s;
  }

  touchSession(id: string) {
    const s = this.getSession(id);
    if (!s) return;
    s.lastActiveAt = Date.now();
    if (s.projectId) { const p = this.getProject(s.projectId); if (p) p.lastActiveAt = s.lastActiveAt; }
    this.save();
  }

  removeSession(id: string) {
    const s = this.getSession(id);
    this.data.sessions = this.data.sessions.filter(x => x.id !== id);
    this.save();
    return s;
  }
}
